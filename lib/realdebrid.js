/**
 * lib/realdebrid.js — Real-Debrid 适配层
 *
 * Real-Debrid（RD）是一个多网盘/离线下载服务：
 *  - 把磁力链接提交给 RD，RD 云端已有缓存时"秒"出直链（instant availability）
 *  - 直链可直接被播放器拉流，实现"云端秒播"
 *
 * 本模块负责：
 *  1. 批量查询 infoHash 在 RD 云端的即时可用性（instantAvailability）
 *  2. 提交磁力链接 → 选中文件 → 换取 HTTPS 直链（resolveMagnet）
 */

'use strict';

const axios = require('axios');

const RD_API_BASE = 'https://api.real-debrid.com/rest/1.0';

/**
 * 构造带鉴权的 RD 客户端。
 * @param {string} apiKey Real-Debrid API Key（https://real-debrid.com/apitoken）
 */
function rdClient(apiKey) {
  return axios.create({
    baseURL: RD_API_BASE,
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 30000
  });
}

/**
 * 查询一组 infoHash 在 RD 云端是否已有缓存（秒播判定）。
 * RD 接口：GET /torrents/instantAvailability/{hash1}/{hash2}/...
 * 返回结构：{ "<hash>": { "rd": [ { "files": { "1": { id, path, bytes } } } ] } }
 * 只要某个 hash 下 rd 数组非空，就说明云端已有完整缓存。
 *
 * @param {string} apiKey
 * @param {string[]} infoHashes 小写 40 位 hex hash 列表（最多 ~100 个/次）
 * @returns {Promise<Set<string>>} 云端已有的 hash 集合
 */
async function getInstantHashes(apiKey, infoHashes) {
  const available = new Set();
  if (!infoHashes.length) return available;
  try {
    const client = rdClient(apiKey);
    const { data } = await client.get(
      `/torrents/instantAvailability/${infoHashes.join('/')}`
    );
    for (const [hash, entry] of Object.entries(data || {})) {
      if (entry && Array.isArray(entry.rd) && entry.rd.length > 0) {
        available.add(hash.toLowerCase());
      }
    }
  } catch (err) {
    // RD 查询失败不阻塞整个流程，只是降级为非秒播流
    console.error('[RD] instantAvailability 查询失败:', err.message);
  }
  return available;
}

/**
 * 把磁力链接解析成一组可播放的 RD 直链。
 * 流程：
 *   POST /torrents/addMagnet   → 拿到 RD 内部 torrent id
 *   GET  /torrents/info/{id}   → 拿到文件列表
 *   POST /torrents/selectFiles → 选中视频文件（全选，RD 会过滤小文件）
 *   GET  /torrents/info/{id}   → 再次获取，links 里就是直链数组
 *
 * @param {string} apiKey
 * @param {string} magnetUrl 完整 magnet 链接（带 infoHash）
 * @returns {Promise<{links: Array<{name:string,url:string,size:number}>}>}
 */
async function resolveMagnet(apiKey, magnetUrl) {
  const client = rdClient(apiKey);

  // 1. 提交磁力链接
  const added = await client.post('/torrents/addMagnet', null, {
    params: { magnet: magnetUrl }
  });
  const torrentId = added.data.id;

  // 2. 获取文件列表
  const info = await client.get(`/torrents/info/${torrentId}`);

  // 3. 选中全部文件（RD 自动忽略 .txt/.nfo 等小文件）
  const fileIds = (info.data.files || []).map((f) => f.id);
  if (fileIds.length > 0) {
    await client.post('/torrents/selectFiles/${torrentId}', null, {
      params: { files: fileIds.join(',') }
    });
  }

  // 4. 重新拉取 info，links 即直链数组
  const final = await client.get(`/torrents/info/${torrentId}`);
  const links = (final.data.links || []).map((url, i) => ({
    name: (final.data.files[i] && final.data.files[i].path) || `文件 ${i + 1}`,
    url,
    size: (final.data.files[i] && final.data.files[i].bytes) || 0
  }));
  return { links, torrentId };
}

module.exports = { getInstantHashes, resolveMagnet };
