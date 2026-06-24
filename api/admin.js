import { readFileSync } from "fs";
import { join } from "path";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = "a861030474-svg/tcm-tool";
const CLASSICS_PATH = "data/classics.json";

function readClassics() {
  const filePath = join(process.cwd(), "data", "classics.json");
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

async function updateClassicsOnGitHub(classics) {
  // 获取当前文件的 SHA
  const metaRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${CLASSICS_PATH}`,
    { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "User-Agent": "tcm-tool" } }
  );
  const meta = await metaRes.json();

  const content = Buffer.from(JSON.stringify(classics, null, 2)).toString("base64");

  const updateRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${CLASSICS_PATH}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "tcm-tool",
      },
      body: JSON.stringify({
        message: "update classics via admin",
        content,
        sha: meta.sha,
      }),
    }
  );

  if (!updateRes.ok) {
    const err = await updateRes.json();
    throw new Error(err.message || "GitHub 更新失败");
  }
  return await updateRes.json();
}

export default async function handler(req, res) {
  // 密码校验
  const authHeader = req.headers["x-admin-password"];
  if (authHeader !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "密码错误" });
  }

  if (req.method === "GET") {
    try {
      const classics = readClassics();
      return res.status(200).json(classics);
    } catch (e) {
      return res.status(500).json({ error: "读取失败：" + e.message });
    }
  }

  if (req.method === "POST") {
    try {
      const { classics } = req.body;
      if (!Array.isArray(classics)) {
        return res.status(400).json({ error: "数据格式错误" });
      }
      await updateClassicsOnGitHub(classics);
      return res.status(200).json({ ok: true, message: "已提交，约1分钟后生效" });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
