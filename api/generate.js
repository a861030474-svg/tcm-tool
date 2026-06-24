import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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

const VERIFY_PROMPT = `你是严谨的中医药典籍考证专家，精通《中国药典》2020年版、《中华本草》、《伤寒论》、《金匮要略》、《本草纲目》、《千金方》等权威文献。

对以下方子逐一核实，给出经官方文献验证并纠正后的标准内容：
- 经典方剂：对照原典纠正成分、用量、适应症的错误描述
- 民间偏方/土方子：在《中华本草》《中国民间验方》中查找；有依据则给官方描述，无记载则找最接近功效的官方方剂
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

const DISCLAIMER_PROMPT = `你是中医内容合规专家，熟悉抖音、小红书、视频号审核规则。

根据视频文案生成底部辩证免责声明，要求：
- 体现辨证论治精神，强调个体差异
- 须由执业中医师面诊后辨证使用
- 80-120字，语言自然
- 不得有保证疗效的表述

只输出声明文字本身。`;

async function callGemini(systemPrompt, userContent) {
  const result = await model.generateContent(
    `${systemPrompt}\n\n${userContent}`
  );
  return result.response.text().trim();
}

function parseJSON(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}") + 1;
  return JSON.parse(raw.slice(start, end));
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
    // 并行：提取方子 + 生成免责声明
    const [extractRaw, disclaimer] = await Promise.all([
      callGemini(EXTRACT_PROMPT, content),
      callGemini(DISCLAIMER_PROMPT, content),
    ]);

    const extractJson = parseJSON(extractRaw);

    if (!extractJson.remedies || extractJson.remedies.length === 0) {
      return res.status(200).json({ disclaimer, formulas: [] });
    }

    // 逐一核实方子
    const remedyList = extractJson.remedies
      .map(
        (r, i) =>
          `${i + 1}. 原文："${r.originalText}"，声称功效：${r.claimedEffect}，类型：${r.type}`
      )
      .join("\n");

    const verifyRaw = await callGemini(
      VERIFY_PROMPT,
      `请对以下方子逐一进行官方文献核实：\n\n${remedyList}`
    );

    const verifyJson = parseJSON(verifyRaw);

    const formulas = verifyJson.verified.map((v, i) => ({
      ...extractJson.remedies[i],
      ...v,
    }));

    return res.status(200).json({ disclaimer, formulas });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "生成失败，请稍后重试" });
  }
}
