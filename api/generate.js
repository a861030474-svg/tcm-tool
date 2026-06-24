import { readFileSync } from "fs";
import { join } from "path";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const API_KEY = process.env.DEEPSEEK_API_KEY;

function buildClassicsContext() {
  try {
    const filePath = join(process.cwd(), "data", "classics.json");
    const classics = JSON.parse(readFileSync(filePath, "utf-8"));
    const sorted = classics.sort((a, b) => a.priority - b.priority);
    const lines = sorted.map(
      (c, i) =>
        `${i + 1}. ${c.name}（${c.dynasty}·${c.author}）——${c.description}。${c.stats ? c.stats + "。" : ""}${c.keyFormulas?.length ? "代表方药：" + c.keyFormulas.slice(0, 5).join("、") + "等。" : ""}`
    );
    return lines.join("\n");
  } catch {
    return "《中国药典》2020年版、《中华本草》、《伤寒论》、《金匮要略》、《本草纲目》";
  }
}

const EXTRACT_PROMPT = `你是中医典籍专家。从以下视频文案中提取所有出现的方剂、中成药、民间偏方、土方子、单味药材特殊用法、食疗方。

只输出JSON，格式：
{
  "remedies": [
    {
      "originalText": "文案中的原始描述",
      "name": "名称",
      "claimedEffect": "文案中声称的功效",
      "type": "经典方剂/民间偏方/中成药/食疗方/单味药材"
    }
  ]
}`;

function buildVerifyPrompt(classicsContext) {
  return `你是严谨的中医药典籍考证专家，核实时请严格对照以下权威典籍（按优先级排列）：

${classicsContext}

对以下方子逐一核实：
- 经典方剂：对照原典纠正成分、用量、适应症的错误描述，注明精确出处（书名+卷章）
- 民间偏方/土方子：在上述典籍中查找记载；有依据则给出官方描述，无记载则找最接近功效的官方方剂替代
- 夸大功效：按官方文献给出准确保守的表述

只输出JSON：
{
  "verified": [
    {
      "originalText": "原始描述",
      "officialName": "官方标准名称",
      "verifiedEfficacy": "官方功效",
      "verifiedIndications": "适应证型",
      "officialSource": "权威出处（精确到书名+卷章）",
      "corrections": "与原文案的差异说明，无差异写与官方记载一致",
      "safetyWarnings": "禁忌人群、不良反应、配伍禁忌",
      "isSafe": true
    }
  ]
}`;
}

// 审核专用辩证内容（较详细，含古籍出处证明）
const REVIEW_DISCLAIMER_PROMPT = `你是中医内容合规专家，专门为抖音、小红书、视频号平台撰写审核声明。

根据视频文案和已核实的方剂信息，生成【平台审核专用辩证声明】：
1. 主动引用每个方剂的权威古籍出处（如"XX方，载于《伤寒论》卷X"），证明内容有文献依据
2. 简述每个方剂的官方功效与适应证型，体现专业性
3. 如原文案描述与官方记载有差异，写入正确版本（不要提"原文案有误"，直接写正确的）
4. 结尾加入辨证论治免责语
5. 语言专业、客观，适合审核人员快速判断合规性
6. 字数150-250字

只输出声明文字，不加标题。`;

// 底部警示文案（简短，直接放视频底部）
const BOTTOM_WARNING_PROMPT = `你是中医内容合规专家。

根据视频文案内容，生成一条简短的【视频底部警示文案】：
1. 简洁，适合直接展示在视频画面底部或评论区置顶
2. 体现辨证论治，强调须由执业中医师指导
3. 不得有保证疗效的表述
4. 字数严格控制在60-80字
5. 自然口语化，不要太正式

只输出文案本身，不加标题或前缀。`;

async function chat(system, user) {
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || "DeepSeek API 调用失败");
  }
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

function parseJSON(raw) {
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}") + 1;
  return JSON.parse(raw.slice(s, e));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { content } = req.body;
  if (!content || content.trim().length < 10) {
    return res.status(400).json({ error: "请输入有效的视频文案" });
  }

  try {
    const classicsContext = buildClassicsContext();

    // 第一步：提取方子
    const extractRaw = await chat(EXTRACT_PROMPT, content);
    const extracted = parseJSON(extractRaw);

    if (!extracted.remedies?.length) {
      const [reviewDisclaimer, bottomWarning] = await Promise.all([
        chat(REVIEW_DISCLAIMER_PROMPT, `视频文案：${content}\n\n已核实方剂：无`),
        chat(BOTTOM_WARNING_PROMPT, content),
      ]);
      return res.status(200).json({ reviewDisclaimer, bottomWarning, formulas: [] });
    }

    // 第二步：核实方子
    const remedyList = extracted.remedies
      .map((r, i) => `${i + 1}. 原文："${r.originalText}"，声称功效：${r.claimedEffect}，类型：${r.type}`)
      .join("\n");

    const verifyRaw = await chat(
      buildVerifyPrompt(classicsContext),
      `请对以下方子逐一进行官方文献核实：\n\n${remedyList}`
    );
    const verified = parseJSON(verifyRaw);

    // 第三步：生成两种文案（并行）
    const verifiedSummary = verified.verified
      .map((v) => `${v.officialName}：出处${v.officialSource}，功效${v.verifiedEfficacy}，适应证型${v.verifiedIndications}`)
      .join("；");

    const [reviewDisclaimer, bottomWarning] = await Promise.all([
      chat(REVIEW_DISCLAIMER_PROMPT, `视频文案：${content}\n\n已核实方剂信息：${verifiedSummary}`),
      chat(BOTTOM_WARNING_PROMPT, content),
    ]);

    const formulas = verified.verified.map((v, i) => ({
      ...extracted.remedies[i],
      ...v,
    }));

    return res.status(200).json({ reviewDisclaimer, bottomWarning, formulas });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "生成失败：" + err.message });
  }
}
