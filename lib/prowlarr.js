/**
 * lib/prowlarr.js — Prowlarr API 客户端
 *
 * 职责：把"关键词 + 分类"翻译成 Prowlarr 的 /api/v1/search 请求，
 * 并把返回的 Torznab release 标准化为插件内部统一结构：
 *   { title, size, seeders, infoHash, magnetUrl, indexer, guid }
 *
 * Prowlarr 是索引器聚合器（内置对 Jackett 协议的转发），插件本身
 * 不做任何网页爬虫——BT 站的检索全部委托给 Prowlarr。
 */

'use strict';

const axios = require('axios');
const { CATEGORIES } = require('../manifest');
const { parseTorrent, buildMagnet } = require('./torrent');

// 内存缓存：避免 Stremio 界面连续滑动/重复点击打爆 Prowlarr
// key = `${type}|${query}`, 有效期 5 分钟
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// .torrent 解析结果缓存：url → { infoHash, trackers, magnetUrl }
// PT 站的种子文件内容不变，hash 可以永久缓存
const torrentCache = new Map();

// 从 magnet 链接里解析 infoHash：xt=urn:btih:<40位hex或32位base32>
const MAGNET_HASH_RE = /xt=urn:btih:([a-fA-F0-9]{40}|[A-Z2-7]{32})/i;

// base32 → hex（个别老站点 magnet 里给 32 位 base32 编码的 hash）
function base32ToHex(b32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of b32.toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v === -1) return null;
    bits += v.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/**
 * 从一条 Prowlarr release 记录中尽力提取 infoHash。
 * Prowlarr 的 release 对象里 infoHash 字段经常为空，需要兜底从
 * magnetUrl / downloadUrl / guid 里解析。
 * @param {object} release Prowlarr 原始 release
 * @returns {string|null} 小写 40 位 hex infoHash，或 null
 */
function extractInfoHash(release) {
  if (release.infoHash && /^[a-fA-F0-9]{40}$/.test(release.infoHash)) {
    return release.infoHash.toLowerCase();
  }
  const candidates = [release.magnetUrl, release.downloadUrl, release.guid];
  for (const url of candidates) {
    if (!url) continue;
    const m = url.match(MAGNET_HASH_RE);
    if (m) {
      let h = m[1].toLowerCase();
      // 32 位 base32 的老 hash 转成 40 位 hex
      if (/^[a-z2-7]{32}$/.test(h)) {
        h = base32ToHex(h);
      }
      return /^[a-f0-9]{40}$/.test(h) ? h : null;
    }
  }
  return null;
}

/**
 * 标准化 Prowlarr release。
 * 私有 PT 站只有 downloadUrl（.torrent 下载链接），hash 稍后由
 * enrichReleases() 下载 .torrent 补出来，所以这里先放行。
 */
function normalizeRelease(release) {
  const infoHash = extractInfoHash(release);
  const magnetUrl = release.magnetUrl || null;
  return {
    title: release.title || '未知标题',
    size: release.size || 0, // 字节
    seeders: release.seeders || 0,
    leechers: release.leechers || 0,
    indexer: release.indexer || 'unknown',
    guid: release.guid || '',
    downloadUrl: release.downloadUrl || null,
    infoHash, // 可能为 null；Real-Debrid 层会用它做秒播判定
    magnetUrl,
    trackers: [] // enrichReleases 里从 .torrent 解析出的 tracker 列表
  };
}

/**
 * 下载 .torrent 并解析出 infoHash + tracker 列表（私有 PT 站专用）。
 * @param {string} downloadUrl Prowlarr 给的下载链接
 * @param {string} apiKey Prowlarr API Key（部分下载链接要求鉴权）
 */
async function resolveTorrentHash(downloadUrl, apiKey) {
  if (torrentCache.has(downloadUrl)) return torrentCache.get(downloadUrl);
  try {
    const { data } = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      headers: { 'X-Api-Key': apiKey },
      timeout: 20000,
      maxRedirects: 5
    });
    const parsed = parseTorrent(Buffer.from(data));
    const result = { infoHash: parsed.infoHash, trackers: parsed.trackers };
    torrentCache.set(downloadUrl, result);
    return result;
  } catch (err) {
    // 下载/解析失败就记 null，不再重试（PT 站下载链接会过期）
    torrentCache.set(downloadUrl, null);
    console.error('[prowlarr] .torrent 解析失败:', err.message);
    return null;
  }
}

/**
 * 给缺 hash 的结果补充 infoHash（并发 3 个，限制处理数量防拖慢搜索）。
 */
async function enrichReleases(releases, apiKey, limit = 15) {
  const pending = releases.filter((r) => !r.infoHash && r.downloadUrl).slice(0, limit);
  let idx = 0;
  async function worker() {
    while (idx < pending.length) {
      const r = pending[idx++];
      const res = await resolveTorrentHash(r.downloadUrl, apiKey);
      if (res) {
        r.infoHash = res.infoHash;
        r.trackers = res.trackers;
        r.magnetUrl = buildMagnet(res.infoHash, r.title, res.trackers);
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return releases;
}

/**
 * 核心搜索函数。
 * @param {object} opts
 * @param {string} opts.baseUrl   Prowlarr 根地址，如 http://localhost:9696
 * @param {string} opts.apiKey    Prowlarr API Key（Settings → General 里生成）
 * @param {string} opts.query     搜索关键词（影片标题，可带年份/SxxEyy）
 * @param {string} opts.type      'movie' | 'series' | 'adult'
 * @param {number} [opts.limit]   返回条数上限，默认 20
 * @returns {Promise<Array>} 标准化 release 列表，按做种数降序
 */
async function searchProwlarr({ baseUrl, apiKey, query, type = 'movie', limit = 20 }) {
  const key = `${type}|${query.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL) {
    return hit.data;
  }

  const client = axios.create({
    baseURL: baseUrl.replace(/\/+$/, ''), // 去掉结尾斜杠
    headers: { 'X-Api-Key': apiKey },
    timeout: 15000
  });

  // Prowlarr 的 /api/v1/search 兼容 Torznab 语义：
  //   query      关键词
  //   categories 分类号（会匹配该分类下所有子分类）
  const { data } = await client.get('/api/v1/search', {
    params: {
      query,
      categories: CATEGORIES[type] || CATEGORIES.movie,
      limit
    }
  });

  if (!Array.isArray(data)) return [];

  // 第一轮过滤：没 hash 但有 downloadUrl 的先留着（私有 PT 站），
  // 什么都没用的（纯网页结果）才丢
  const candidates = data
    .map(normalizeRelease)
    .filter((r) => r.infoHash || r.magnetUrl || r.downloadUrl)
    .sort((a, b) => b.seeders - a.seeders)
    .slice(0, limit);

  // 第二轮：给私有站结果下载 .torrent 解析 hash（带缓存，重复搜索零开销）
  const enriched = await enrichReleases(candidates, apiKey);

  // 解析后依然没有 hash 的，对 Stremio/RD 确实没用了，丢弃
  const results = enriched.filter((r) => r.infoHash || r.magnetUrl);

  cache.set(key, { time: Date.now(), data: results });
  return results;
}

module.exports = { searchProwlarr, extractInfoHash };
