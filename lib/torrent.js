/**
 * lib/torrent.js — .torrent 文件（bencode 格式）解析器
 *
 * 私有 PT 站（如 BigFANGroup）的搜索结果只给 .torrent 下载链接，
 * 不给磁力 hash。Stremio 和 Real-Debrid 都要 infoHash 才能工作，
 * 所以这里做三件事：
 *   1. 解析 bencode，定位顶层字典里的 "info" 键的字节范围
 *   2. 对 "info" 的原始字节做 SHA-1 —— 这就是 infoHash（BitTorrent 协议定义）
 *   3. 顺便取出 announce / announce-list（tracker 列表，含 PT 站 passkey），
 *      塞进 magnet 的 tr= 参数里，这样 Stremio 内置引擎/RD 才能找到做种者
 *
 * 为什么不引第三方 bencode 库：解析需求很窄（只需要 info 的字节偏移 +
 * 两个字符串字段），手写 ~90 行零依赖，省去构建和体积开销。
 */

'use strict';

const crypto = require('crypto');

/**
 * 解析 .torrent 文件内容。
 * @param {Buffer} buf .torrent 文件的原始字节
 * @returns {{infoHash: string, trackers: string[], name: string}}
 * @throws 格式非法时抛异常
 */
function parseTorrent(buf) {
  let pos = 0;

  // ---- 底层原语 ----

  function readInt() {
    // i<number>e
    const end = buf.indexOf(0x65, pos); // 'e'
    if (end === -1) throw new Error('bencode: 整数未终止');
    const n = parseInt(buf.toString('ascii', pos + 1, end), 10);
    pos = end + 1;
    return n;
  }

  function readString() {
    // <长度>:<内容>
    const colon = buf.indexOf(0x3a, pos); // ':'
    if (colon === -1) throw new Error('bencode: 字符串缺冒号');
    const len = parseInt(buf.toString('ascii', pos, colon), 10);
    const start = colon + 1;
    pos = start + len;
    if (pos > buf.length) throw new Error('bencode: 字符串越界');
    return { start, end: pos, str: buf.toString('utf8', start, pos) };
  }

  /**
   * 通用值解析。mode 控制行为：
   *   'value'  返回解析出的 JS 值（用于 announce 等小字段）
   *   'skip'   只移动 pos，不建值（用于快速跳过无关的大字段）
   */
  function readValue(mode) {
    const ch = buf[pos];
    if (ch === 0x69) {
      // i...e
      if (mode === 'skip') { readInt(); return; }
      return readInt();
    }
    if (ch === 0x6c) {
      // l...e 列表
      pos++; // 跳过 'l'
      const arr = mode === 'skip' ? null : [];
      while (buf[pos] !== 0x65) {
        const v = readValue(mode);
        if (arr) arr.push(v);
      }
      pos++; // 跳过 'e'
      return arr;
    }
    if (ch === 0x64) {
      // d...e 字典
      pos++; // 跳过 'd'
      const obj = mode === 'skip' ? null : {};
      while (buf[pos] !== 0x65) {
        const k = readString().str;
        if (mode === 'skip') {
          readValue('skip');
        } else {
          obj[k] = readValue('value');
        }
      }
      pos++; // 跳过 'e'
      return obj;
    }
    if (ch >= 0x30 && ch <= 0x39) {
      // 数字开头 = 字符串
      const s = readString();
      return mode === 'skip' ? undefined : s.str;
    }
    throw new Error(`bencode: 非法字符 0x${ch ? ch.toString(16) : 'eof'} @${pos}`);
  }

  // ---- 顶层解析：必须是以 'd' 开头的字典 ----

  if (buf[pos] !== 0x64) throw new Error('bencode: 顶层不是字典');
  pos++;

  let infoStart = -1;
  let infoEnd = -1;
  let announce = null;
  let announceList = null;

  while (buf[pos] !== 0x65) {
    const key = readString().str;
    if (key === 'info') {
      // 记录 info 值的原始字节范围 —— hash 是对这段字节做 SHA-1
      infoStart = pos;
      readValue('skip');
      infoEnd = pos;
    } else if (key === 'announce') {
      announce = readValue('value');
    } else if (key === 'announce-list') {
      // 形如 [ ["udp://a"], ["http://b","http://c"] ]
      announceList = readValue('value');
    } else {
      readValue('skip');
    }
  }

  if (infoStart === -1) throw new Error('bencode: 缺少 info 字典');

  const infoHash = crypto
    .createHash('sha1')
    .update(buf.subarray(infoStart, infoEnd))
    .digest('hex');

  // ---- 汇总 tracker 列表（去重，扁平化） ----
  const trackers = new Set();
  if (announce) trackers.add(announce.trim());
  if (Array.isArray(announceList)) {
    for (const tier of announceList) {
      for (const t of tier) trackers.add(t.trim());
    }
  }

  return { infoHash, trackers: [...trackers] };
}

/**
 * 由 infoHash + 文件名 + tracker 列表拼出标准磁力链接。
 * @param {string} infoHash 40 位 hex
 * @param {string} name 显示名
 * @param {string[]} trackers tracker URL 列表（可含 PT 站 passkey）
 */
function buildMagnet(infoHash, name, trackers = []) {
  const parts = [`xt=urn:btih:${infoHash}`];
  if (name) parts.push(`dn=${encodeURIComponent(name)}`);
  for (const t of trackers) parts.push(`tr=${encodeURIComponent(t)}`);
  return `magnet:?${parts.join('&')}`;
}

module.exports = { parseTorrent, buildMagnet };
