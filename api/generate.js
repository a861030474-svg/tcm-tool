import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 第一步：从文案中提取所有方子/药材/偏方
const EXTRACT_PROMPT = `你是中医典籍专家。请从以下视频文案中，提取所有出现的：
- 中药方剂（如四物汤、补中益气汤）
- 中成药（如六味地黄丸）
- 民间偏方/土方子（如"生姜红糖水治感冒"）
- 单味药材的特殊用法（如"生附子泡脚"）
- 食疗方（如"山药薏米粥"）

只输出JSON，格式如下：
{
  "remedies": [
    {
      "originalText": "文案中的原始描述",
      "name": "方剂/偏方名称",
      "claimedEffect": "文案中声称的功效",
      "type": "经典方剂/民间偏方/中成药/食疗方/单味药材"
    }
  ]
}`;

// 第二步：逐一向官方资料核实并给出正确版本
const VERIFY_PROMPT = `你是严谨的中医药典籍考证专家，精通《中国药典》（2020年版）、《中华本草》、《中华人民共和国药典临床用药须知》、《伤寒论》、《金匮要略》、《本草纲目》、《千金方》等权威文献。

对于以下方子/偏方，请严格按照官方权威文献进行核实，输出经过验证和纠正后的标准内容。

核实原则：
1. 如果是经典方剂：对照原典记载，纠正成分、用量、适应症的错误描述
2. 如果是民间偏方：在《中华本草》《中国民间验方》等资料中查找有无记载；若有循证依据则给出官方描述，若无记载则找出最接近功效的官方方剂替代
3. 如果功效描述夸大：按官方文献给出准确、保守的表述
4. 禁止保留任何未经证实的疗效声称

对每个方子输出：
- officialName：官方标准名称（如民间叫法有别名，给出标准名）
- verifiedEfficacy：经官方文献验证的功效（必须有出处支撑）
- verifiedIndications：适应证型（中医辨证分型）
- officialSource：具体出处（精确到书名+卷章或条文）
- corrections：原文案与官方记载的差异说明（如无差异写"与官方记载一致"）
- safetyWarnings：安全警示（禁忌人群、不良反应、不可与哪些药同用）
- isSafe：true=可以用 false=存在安全风险需修改文案

只输出JSON：
{
  "verified": [
    {
      "originalText": "原始描述",
      "officialName": "官方标准名称",
      "verifiedEfficacy": "官方功效",
      "verifiedIndications": "适应证型",
      "officialSource": "权威出处",
      "corrections": "纠正说明",
      "safetyWarnings": "安全警示",
      "isSafe": true
    }
  ]
}`;

// 第三步：生成底部辩证内容
const DISCLAIMER_PROMPT = `你是中医内容合规专家，熟悉抖音、小红书、视频号的中医内容审核规则。

根据以下视频文案内容，生成符合平台审核标准的底部辩证免责声明。

要求：
- 体现中医辨证论治精神
- 强调个体差异，须由执业中医师面诊后辨证使用
- 80-120字，语言自然不生硬
- 不得有保证疗效、保证治愈的表述
- 可引用中医"同病异治、异病同治"理念

只输出声明文字本身，不要加任何标题或前缀。`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { content } = req.body;

  if (!content || content.trim().length < 10) {
    return res.status(400).json({ error: "请输入有效的视频文案" });
  }

  try {
    // 并行执行：提取方子 + 生成免责声明
    const [extractRes, disclaimerRes] = await Promise.all([
      client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system: EXTRACT_PROMPT,
        messages: [{ role: "user", content }],
      }),
      client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        system: DISCLAIMER_PROMPT,
        messages: [{ role: "user", content }],
      }),
    ]);

    const disclaimer = disclaimerRes.content[0].text.trim();

    // 解析提取到的方子
    const extractRaw = extractRes.content[0].text.trim();
    const extractJson = JSON.parse(
      extractRaw.slice(extractRaw.indexOf("{"), extractRaw.lastIndexOf("}") + 1)
    );

    if (!extractJson.remedies || extractJson.remedies.length === 0) {
      return res.status(200).json({ disclaimer, formulas: [] });
    }

    // 第二步：对所有方子逐一核实（传入提取结果一次性验证）
    const remedyList = extractJson.remedies
      .map(
        (r, i) =>
          `${i + 1}. 原文描述："${r.originalText}"，声称功效：${r.claimedEffect}，类型：${r.type}`
      )
      .join("\n");

    const verifyRes = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      system: VERIFY_PROMPT,
      messages: [
        {
          role: "user",
          content: `请对以下方子逐一进行官方文献核实：\n\n${remedyList}`,
        },
      ],
    });

    const verifyRaw = verifyRes.content[0].text.trim();
    const verifyJson = JSON.parse(
      verifyRaw.slice(verifyRaw.indexOf("{"), verifyRaw.lastIndexOf("}") + 1)
    );

    // 合并原始提取信息和验证结果
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
