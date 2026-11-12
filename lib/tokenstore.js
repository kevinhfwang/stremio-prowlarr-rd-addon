/**
 * lib/tokenstore.js — 服务端配置 token 存储（不透明间接层）
 *
 * 背景：旧设计把完整配置（含 rdKey / prowlarrKey）base64url 编码进 URL 段，
 * base64 只是编码不是加密——任何拿到安装链接或服务器访问日志的人都能解出
 * 真实 key。本模块把配置挪到服务器端，URL 里只放随机 token：
 *
 *   - 拿到链接的人可以用插件（消耗 RD 配额）但解不出原始 key
 *   - Caddy/Express 访问日志里躺的是 token，不是 key
 *   - token 可随时吊销（删除 data/tokens.json 里对应行）
 *
 * 落盘加密（可选）：设环境变量 CONFIG_SECRET（任意长随机串）后，存储文件里的
 * 配置值用 AES-256-GCM 加密，连服务器磁盘上的映射文件都不含明文 key。
 * 不设则以明文落盘并在启动时打一条警告（自托管单机可接受，但不推荐）。
 *
 * 存储文件默认 ./data/tokens.json（容器内挂卷持久化，重启不丢）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_FILE =
  process.env.CONFIG_STORE || path.join(__dirname, '..', 'data', 'tokens.json');

// ---- 可选的落盘加密 ----
const SECRET = process.env.CONFIG_SECRET || '';
let KEY = null;
if (SECRET) {
  KEY = crypto.createHash('sha256').update(SECRET, 'utf8').digest();
} else {
  console.warn(
    '[tokenstore] ⚠️ 未设 CONFIG_SECRET，配置将明文落盘。建议：openssl rand -hex 32 生成后注入环境变量'
  );
}

function encrypt(plain) {
  if (!KEY) return { v: 0, data: plain };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: enc.toString('base64')
  };
}

function decrypt(rec) {
  if (rec.v === 0) return rec.data;
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(rec.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(rec.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(rec.data, 'base64')), decipher.final()]).toString('utf8');
}

// ---- 存储实现 ----
// 结构：{ tokens: { <token>: {v, iv?, tag?, data} } }
// 相同配置重复提交返回同一 token（幂等，重新生成链接 URL 不变）
let store = { tokens: {} };
let dirty = false;

function load() {
  try {
    store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!store.tokens) store.tokens = {};
  } catch {
    store = { tokens: {} };
  }
}

function persist() {
  if (!dirty) return;
  const tmp = STORE_FILE + '.tmp';
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, STORE_FILE); // 原子写，避免中途断电留下半截 JSON
  dirty = false;
}

// 进程退出前兜底刷盘（SIGTERM 是 docker stop 的默认信号）
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try { persist(); } catch {}
    process.exit(0);
  });
}

/** 生成新 token：128 位随机，base64url，22 字符 */
function newToken() {
  return crypto.randomBytes(16).toString('base64url');
}

/** 提交配置 → token。相同配置幂等返回已有 token。 */
function issue(config) {
  const canonical = JSON.stringify(config);
  for (const [tok, rec] of Object.entries(store.tokens)) {
    try {
      if (decrypt(rec) === canonical) return tok;
    } catch { /* 解密失败的条目跳过 */ }
  }
  const tok = newToken();
  store.tokens[tok] = encrypt(canonical);
  dirty = true;
  persist();
  return tok;
}

/** token → 配置对象；未知 token / 解密失败返回 null */
function resolve(token) {
  const rec = store.tokens[token];
  if (!rec) return null;
  try {
    return JSON.parse(decrypt(rec));
  } catch {
    return null;
  }
}

/** 吊销 token（返回是否命中） */
function revoke(token) {
  if (!store.tokens[token]) return false;
  delete store.tokens[token];
  dirty = true;
  persist();
  return true;
}

load();

module.exports = { issue, resolve, revoke, STORE_FILE };
