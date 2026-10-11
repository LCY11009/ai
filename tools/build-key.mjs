#!/usr/bin/env node
/**
 * build-key.mjs — 把智谱 API Key 用 AES-GCM-256 加密后注入 ai-chat.html
 *
 *   node tools/build-key.mjs --key "你的智谱Key"
 *   node tools/build-key.mjs --key "你的智谱Key" --file ai-chat.html
 *   node tools/build-key.mjs --verify            # 只校验现有文件里的密文能否解开
 *
 * 原理：
 *   1. 随机生成 48 字符口令 P（只存在于文件里，且被 XOR 打散成多段）；
 *   2. key = PBKDF2-SHA256(P, salt, 210000) → AES-GCM-256；
 *   3. 用 key 加密真实 API Key，密文写进 HTML；
 *   4. 运行时浏览器再拼回 P、解密、把明文只留在内存里。
 *
 * ⚠️ 这是"提高门槛"而不是"绝对安全"：纯前端方案里解密所需的一切都在文件中，
 *    懂逆向的人最终仍能还原出 Key。要真正保证不外泄，请用 worker/worker.js
 *    起一个中转服务，HTML 里就完全不需要 Key 了。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ITER = 210000;
const START = '/* KEY_PAYLOAD_START */';
const END = '/* KEY_PAYLOAD_END */';
const MASKS = ['zQ7#kLm2', 'Vx9$pR4t', 'Hb3&wY6n', 'Ef1@cJ8s'];

const subtle = (globalThis.crypto ?? (await import('node:crypto')).webcrypto).subtle;
const te = new TextEncoder();
const td = new TextDecoder();

const b64 = (buf) => Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function deriveAesKey(pass, salt, iterations = ITER) {
  const base = await subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptString(aesKey, plain) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, te.encode(plain));
  return { iv, ct: new Uint8Array(ct) };
}
async function decryptString(aesKey, iv, ct) {
  return td.decode(await subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct));
}
function xorEncode(str, mask) {
  const bytes = Buffer.from(str, 'utf8');
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= mask.charCodeAt(i % mask.length);
  return bytes.toString('base64');
}
function xorDecode(b64str, mask) {
  const bytes = Buffer.from(b64str, 'base64');
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= mask.charCodeAt(i % mask.length);
  return bytes.toString('utf8');
}
function splitEven(str, parts) {
  const size = Math.ceil(str.length / parts);
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}
function fingerprint(key) {
  return `${key.slice(0, 6)}····${key.slice(-4)} (len=${key.length})`;
}

async function buildPayload(apiKey) {
  const pass = randomBytes(24).toString('hex');            // 48 个 ASCII 字符
  const salt = randomBytes(16);
  const aesKey = await deriveAesKey(pass, salt);
  const { iv, ct } = await encryptString(aesKey, apiKey);
  const chunks = splitEven(pass, MASKS.length);
  const payload = {
    v: 1,
    n: ITER,
    s: b64(salt),
    i: b64(iv),
    c: b64(ct),
    p: chunks.map((c, i) => xorEncode(c, MASKS[i])),
    m: MASKS.slice(0, chunks.length)
  };
  return payload;
}
function payloadToLiteral(p) {
  return 'var KEY_PAYLOAD = {\n' +
    `  v: 1, n: ${p.n},\n` +
    `  s: '${p.s}',\n  i: '${p.i}',\n  c: '${p.c}',\n` +
    `  p: [${p.p.map((x) => `'${x}'`).join(', ')}],\n` +
    `  m: [${p.m.map((x) => `'${x}'`).join(', ')}]\n};`;
}

function parseArgs(argv) {
  const out = { file: path.join(ROOT, 'ai-chat.html'), key: '', verify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key' || a === '-k') out.key = argv[++i] ?? '';
    else if (a === '--file' || a === '-f') out.file = path.resolve(process.cwd(), argv[++i] ?? '');
    else if (a === '--verify') out.verify = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}
function extractPayload(src) {
  const s = src.indexOf(START), e = src.indexOf(END);
  if (s < 0 || e < 0) throw new Error('在 HTML 里找不到 KEY_PAYLOAD 标记，文件可能被改过');
  return { s, e, body: src.slice(s + START.length, e) };
}
function parseLiteral(body) {
  const arr = (name) => {
    const m = body.match(new RegExp(name + ':\\s*\\[([^\\]]*)\\]'));
    return m ? [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]) : [];
  };
  const one = (name) => {
    const m = body.match(new RegExp(name + ":\\s*'([^']*)'"));
    return m ? m[1] : null;
  };
  return { n: Number((body.match(/n:\s*(\d+)/) || [])[1]) || ITER, s: one('s'), i: one('i'), c: one('c'), p: arr('p'), m: arr('m') };
}
async function decryptFromLiteral(body) {
  const pl = parseLiteral(body);
  if (!pl.s || !pl.i || !pl.c || pl.p.length !== pl.m.length || !pl.p.length) throw new Error('密文载荷不完整');
  const pass = pl.p.map((c, i) => xorDecode(c, pl.m[i])).join('');
  const aesKey = await deriveAesKey(pass, unb64(pl.s), pl.n);
  return decryptString(aesKey, unb64(pl.i), unb64(pl.c));
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`用法：
  node tools/build-key.mjs --key <智谱APIKey> [--file ai-chat.html]
  node tools/build-key.mjs --verify [--file ai-chat.html]`);
  process.exit(0);
}
try {
  const src = await readFile(args.file, 'utf8');
  const { s, e } = extractPayload(src);

  if (args.verify) {
    const key = await decryptFromLiteral(src.slice(s, e));
    console.log(`✅ 解密成功：${fingerprint(key)}`);
    console.log(`   口令片段 ${(src.slice(s, e).match(/m:\s*\[([^\]]*)\]/)?.[1].match(/'/g)?.length ?? 0) / 2} 段，PBKDF2 轮数 ${ITER}`);
    process.exit(0);
  }
  if (!args.key.trim()) {
    console.error('❌ 缺少 --key（或使用 --verify 校验现有文件）');
    process.exit(1);
  }
  const clean = args.key.trim();
  if (clean.length < 20) console.warn('⚠️ Key 看起来偏短，确认没有复制漏字符。');

  const payload = await buildPayload(clean);
  const literal = payloadToLiteral(payload);
  const next = src.slice(0, s + START.length) + '\n' + literal + '\n' + src.slice(e);
  await writeFile(args.file, next, 'utf8');

  // 自检：从刚写出的内容里再解一遍
  const check = await decryptFromLiteral(literal);
  if (check !== clean) throw new Error('自检失败：写入后无法解出同一个 Key');
  console.log(`✅ 已注入 ${path.relative(process.cwd(), args.file)}`);
  console.log(`   Key：${fingerprint(clean)}`);
  console.log(`   密文长度：${payload.c.length} 字节 · 口令 ${payload.p.length} 段 XOR 打散 · PBKDF2-${ITER}`);
  console.log(`   文件中已不存在 Key 明文：${!next.includes(clean) ? '确认' : '❌ 仍存在！'}`);
} catch (err) {
  console.error('❌ ' + err.message);
  process.exit(1);
}
