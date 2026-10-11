/**
 * Cloudflare Worker 中转（方案 B：真正保证 API Key 不外泄）
 *
 * 部署后把地址填进 ai-chat.html 的管理面板 →「代理模式地址」，
 * 例如 https://zhiliao-proxy.你的账号.workers.dev/api/chat
 * 之后浏览器把请求发给这个 Worker，Key 只存在于 Worker 的密钥里，
 * HTML 文件里一个字符的 Key 都不需要。
 *
 * 部署：
 *   1. npm i -g wrangler && wrangler login
 *   2. wrangler secret put ZHIPU_API_KEY     # 粘贴你的智谱 Key
 *   3. 可选：wrangler kv namespace create RL 然后把 id 填到 wrangler.toml 的 RL 绑定
 *   4. wrangler deploy
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

// 每分钟每个 IP 的请求上限（域名级兜底，防止有人拿你的站点刷 Key）
const PER_MINUTE = 5;
const PER_DAY = 200;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return json({ error: { code: 'method', message: '只接受 POST' } }, 405);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const limited = await rateLimit(ip, env);
    if (limited) return json({ error: { code: '429', message: limited } }, 429);

    const endpoint = env.ZHIPU_ENDPOINT || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + env.ZHIPU_API_KEY
      },
      body: await request.text()
    });

    // 原样透传 SSE 流
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...CORS,
        'Content-Type': upstream.headers.get('content-type') || 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no'
      }
    });
  }
};

async function rateLimit(ip, env) {
  if (!env.RL) return null; // 没配 KV 就不做服务端限速（前端仍有限速）
  const minuteKey = `m:${ip}:${Math.floor(Date.now() / 60000)}`;
  const dayKey = `d:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const [m, d] = await Promise.all([
    env.RL.get(minuteKey).then((v) => parseInt(v || '0', 10)),
    env.RL.get(dayKey).then((v) => parseInt(v || '0', 10))
  ]);
  if (m >= PER_MINUTE) return `请求过于频繁：每分钟最多 ${PER_MINUTE} 次`;
  if (d >= PER_DAY) return `今日额度已用完（上限 ${PER_DAY} 次）`;
  await Promise.all([
    env.RL.put(minuteKey, String(m + 1), { expirationTtl: 120 }),
    env.RL.put(dayKey, String(d + 1), { expirationTtl: 90000 })
  ]);
  return null;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
