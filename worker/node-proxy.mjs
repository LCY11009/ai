#!/usr/bin/env node
/**
 * 零依赖 Node 中转（方案 B，本机 / 局域网 / 小服务器都能跑）
 *
 *   ZHIPU_API_KEY=你的Key node worker/node-proxy.mjs
 *   ZHIPU_API_KEY=你的Key PORT=8787 node worker/node-proxy.mjs
 *
 * 然后把 http://localhost:8787/api/chat 填进管理面板的「代理模式地址」。
 * Key 只存在于这台机器的环境变量里，HTML 文件里完全不需要 Key。
 */
import http from 'node:http';

const PORT = process.env.PORT || 8787;
const KEY = process.env.ZHIPU_API_KEY;
const ENDPOINT = process.env.ZHIPU_ENDPOINT || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const PER_MINUTE = Number(process.env.PER_MINUTE || 5);
const PER_DAY = Number(process.env.PER_DAY || 200);

if (!KEY) {
  console.error('缺少环境变量 ZHIPU_API_KEY。示例：\n  ZHIPU_API_KEY=你的Key node worker/node-proxy.mjs');
  process.exit(1);
}

const hits = new Map(); // ip -> number[] 时间戳
const daily = new Map(); // ip -> { day, n }

function limited(ip) {
  const now = Date.now();
  const day = new Date().toISOString().slice(0, 10);
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (list.length >= PER_MINUTE) return `请求过于频繁：每分钟最多 ${PER_MINUTE} 次`;
  const d = daily.get(ip);
  const n = d && d.day === day ? d.n : 0;
  if (n >= PER_DAY) return `今日额度已用完（上限 ${PER_DAY} 次）`;
  list.push(now);
  hits.set(ip, list);
  daily.set(ip, { day, n: n + 1 });
  return null;
}

http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method !== 'POST' || !req.url.startsWith('/api/chat')) {
    res.writeHead(405, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: '只接受 POST /api/chat' } }));
  }

  const ip = req.socket.remoteAddress || 'unknown';
  const blocked = limited(ip);
  if (blocked) {
    res.writeHead(429, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { code: '429', message: blocked } }));
  }

  const body = await new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

  try {
    const upstream = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body
    });
    res.writeHead(upstream.status, {
      ...cors,
      'Content-Type': upstream.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no'
    });
    if (!upstream.body) return res.end();
    for await (const chunk of upstream.body) res.write(chunk); // 边收边发，保持流式
    res.end();
  } catch (err) {
    res.writeHead(502, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '上游请求失败：' + err.message } }));
  }
}).listen(PORT, () => {
  console.log(`✅ 中转已启动：http://localhost:${PORT}/api/chat`);
  console.log(`   限速：${PER_MINUTE} 次/分钟，${PER_DAY} 次/天（每个 IP）`);
  console.log('   把这个地址填进 ai-chat.html 的管理面板 →「代理模式地址」即可。');
});
