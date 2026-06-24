const GITHUB_REPO = 'a861030474-svg/tcm-tool';
const CLASSICS_PATH = 'data/classics.json';

async function readClassics(env, requestUrl) {
  const res = await env.ASSETS.fetch(new URL('/data/classics.json', requestUrl).toString());
  if (!res.ok) throw new Error('读取失败');
  return res.json();
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

async function updateClassicsOnGitHub(classics, githubToken) {
  const metaRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${CLASSICS_PATH}`,
    { headers: { Authorization: `Bearer ${githubToken}`, 'User-Agent': 'tcm-tool' } }
  );
  const meta = await metaRes.json();

  const updateRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${CLASSICS_PATH}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'tcm-tool',
      },
      body: JSON.stringify({
        message: 'update classics via admin',
        content: toBase64(JSON.stringify(classics, null, 2)),
        sha: meta.sha,
      }),
    }
  );

  if (!updateRes.ok) {
    const err = await updateRes.json();
    throw new Error(err.message || 'GitHub 更新失败');
  }
  return updateRes.json();
}

export async function onRequest(context) {
  const { request, env } = context;

  const password = request.headers.get('x-admin-password');
  if (password !== env.ADMIN_PASSWORD) {
    return Response.json({ error: '密码错误' }, { status: 401 });
  }

  if (request.method === 'GET') {
    try {
      const classics = await readClassics(env, request.url);
      return Response.json(classics);
    } catch (e) {
      return Response.json({ error: '读取失败：' + e.message }, { status: 500 });
    }
  }

  if (request.method === 'POST') {
    try {
      const { classics } = await request.json();
      if (!Array.isArray(classics)) {
        return Response.json({ error: '数据格式错误' }, { status: 400 });
      }
      await updateClassicsOnGitHub(classics, env.GITHUB_TOKEN);
      return Response.json({ ok: true, message: '已提交，约1分钟后生效' });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}
