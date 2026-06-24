const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

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

const REVIEW_DISCLAIMER_PROMPT = `你是中医内容合规专家，专门为抖音、小红书、视频号平台撰写审核声明。

根据视频文案和已核实的方剂信息，生成【平台审核专用辩证声明】，目的是帮助内容通过平台审核：
1. 主动引用每个方剂的权威古籍出处（如"XX方，载于《伤寒论》卷X"），证明内容有文献依据
2. 简述每个方剂的官方功效与适应证型，体现专业性与合规性
3. 只写正面的证明性内容，不提任何与原文案的差异、勘误或不足之处
4. 结尾加入辨证论治免责语
5. 语言专业、客观，适合审核人员快速判断合规性
6. 字数150-250字

只输出声明文字，不加标题。`;

const BOTTOM_WARNING_PROMPT = `你是中医内容合规专家。

根据视频文案内容，生成一条简短的【视频底部警示文案】：
1. 简洁，适合直接展示在视频画面底部或评论区置顶
2. 体现辨证论治，强调须由执业中医师指导
3. 不得有保证疗效的表述
4. 字数严格控制在60-80字
5. 自然口语化，不要太正式

只输出文案本身，不加标题或前缀。`;

async function buildClassicsContext(env, requestUrl) {
  try {
    const res = await env.ASSETS.fetch(new URL('/data/classics.json', requestUrl).toString());
    const classics = await res.json();
    const sorted = classics.sort((a, b) => a.priority - b.priority);
    return sorted.map((c, i) =>
      `${i + 1}. ${c.name}（${c.dynasty}·${c.author}）——${c.description}。${c.stats ? c.stats + '。' : ''}${c.keyFormulas?.length ? '代表方药：' + c.keyFormulas.slice(0, 5).join('、') + '等。' : ''}`
    ).join('\n');
  } catch {
    return '《中国药典》2020年版、《中华本草》、《伤寒论》、《金匮要略》、《本草纲目》';
  }
}

async function chat(system, user, apiKey) {
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || 'DeepSeek API 调用失败');
  }
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

function parseJSON(raw) {
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}') + 1;
  return JSON.parse(raw.slice(s, e));
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '请求格式错误' }, { status: 400 });
  }

  const { content } = body;
  if (!content || content.trim().length < 10) {
    return Response.json({ error: '请输入有效的视频文案' }, { status: 400 });
  }

  const API_KEY = env.DEEPSEEK_API_KEY;

  try {
    const classicsContext = await buildClassicsContext(env, request.url);

    const extractRaw = await chat(EXTRACT_PROMPT, content, API_KEY);
    const extracted = parseJSON(extractRaw);

    if (!extracted.remedies?.length) {
      const [reviewDisclaimer, bottomWarning] = await Promise.all([
        chat(REVIEW_DISCLAIMER_PROMPT, `视频文案：${content}\n\n已核实方剂：无`, API_KEY),
        chat(BOTTOM_WARNING_PROMPT, content, API_KEY),
      ]);
      return Response.json({ reviewDisclaimer, bottomWarning, formulas: [] });
    }

    const remedyList = extracted.remedies
      .map((r, i) => `${i + 1}. 原文："${r.originalText}"，声称功效：${r.claimedEffect}，类型：${r.type}`)
      .join('\n');

    const verifyRaw = await chat(
      buildVerifyPrompt(classicsContext),
      `请对以下方子逐一进行官方文献核实：\n\n${remedyList}`,
      API_KEY
    );
    const verified = parseJSON(verifyRaw);

    const verifiedSummary = verified.verified
      .map(v => `${v.officialName}：出处${v.officialSource}，功效${v.verifiedEfficacy}，适应证型${v.verifiedIndications}`)
      .join('；');

    const [reviewDisclaimer, bottomWarning] = await Promise.all([
      chat(REVIEW_DISCLAIMER_PROMPT, `视频文案：${content}\n\n已核实方剂信息：${verifiedSummary}`, API_KEY),
      chat(BOTTOM_WARNING_PROMPT, content, API_KEY),
    ]);

    const formulas = verified.verified.map((v, i) => ({
      ...extracted.remedies[i],
      ...v,
    }));

    return Response.json({ reviewDisclaimer, bottomWarning, formulas });
  } catch (err) {
    console.error(err);
    return Response.json({ error: '生成失败：' + err.message }, { status: 500 });
  }
}
