/**
 * addon.js — Stremio 插件核心逻辑
 *
 * 这里把 manifest 定义和两个核心 handler 组装起来：
 *
 *  1. defineCatalogHandler — 目录/搜索
 *     用户在 Stremio 里打开"成人影片 (18+)"或"电影搜索"目录并输入关键词时，
 *     我们把关键词转发给 Prowlarr（成人目录自动走分类 6000，命中 Sukebei 等
 *     成人索引器），把每条 release 变成一个 Stremio meta 条目。
 *
 *     关键设计：条目 id 直接用 "rd:<infoHash>" 而不是 IMDb id。
 *     成人内容在 Cinemeta 里没有元数据，拿不到海报/简介，但好处是
 *     用户点进去时 stream handler 能精确回到这一条 release，
 *     不需要再做标题模糊搜索。
 *
 *  2. defineStreamHandler — 播放流
 *     用户点开一部影片时：
 *       - 如果 id 是 "rd:<infoHash>"（来自我们自己的目录）→ 直接对该 hash 建流
 *       - 如果 id 是 IMDb id（如 tt0137523，来自 Cinemeta 官方目录）→
 *         先查 Cinemeta 拿标题/年份，再用标题搜 Prowlarr
 *     然后对每条 release：
 *       - 配置了 Real-Debrid 时，先批量查 RD 云端缓存（instant availability），
 *         命中的标 "⚡ 秒播"，直链通过 /proxy 路由转发
 *       - 未命中的回退为裸 infoHash 流（Stremio 内置引擎可离线下载播放）
 */

'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const { searchProwlarr } = require('./lib/prowlarr');
const { getInstantHashes, resolveMagnet } = require('./lib/realdebrid');
const { buildManifest } = require('./manifest');

/**
 * 用户配置解析：把 URL 里的 base64url 段还原成配置对象。
 * 配置 JSON 结构：{ prowlarrUrl, prowlarrKey, rdKey, enableAdult }
 * @param {string} encoded
 */
function parseConfig(encoded) {
  // base64url → base64
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const json = Buffer.from(b64, 'base64').toString('utf8');
  const config = JSON.parse(json);
  if (!config.prowlarrUrl || !config.prowlarrKey) {
    throw new Error('配置缺少 prowlarrUrl / prowlarrKey');
  }
  return {
    prowlarrUrl: String(config.prowlarrUrl),
    prowlarrKey: String(config.prowlarrKey),
    rdKey: config.rdKey ? String(config.rdKey) : '',
    enableAdult: Boolean(config.enableAdult)
  };
}

/** 配置对象 → base64url（配置页面生成安装链接时用） */
function encodeConfig(config) {
  return Buffer.from(JSON.stringify(config)).toString('base64url');
}

/** 从标题里提取清晰度标签，作为流名称前缀，方便用户在列表里筛选 */
function qualityTag(title) {
  const m = title.match(/(2160p|4k|1080p|720p|480p|bluray|web[- ]?dl|webrip|remux|hdtv)/i);
  return m ? m[1].toUpperCase() : '未知画质';
}

/** 字节数 → 人类可读大小 */
function humanSize(bytes) {
  if (!bytes) return '未知大小';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

/** 查 Stremio 官方 Cinemeta，把 IMDb id 翻译成 标题 + 年份 */
async function cinemetaLookup(type, imdbId) {
  try {
    const axios = require('axios');
    const { data } = await axios.get(
      `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`,
      { timeout: 10000 }
    );
    const meta = data && data.meta;
    if (!meta) return null;
    return { name: meta.name, year: meta.year };
  } catch {
    return null;
  }
}

// ---- catalog → stream 的结果暂存 ----
// 用户在目录里点条目时，stream handler 收到的只有 "rd:<hash>"，
// 需要找回这条 release 的标题/tracker（尤其私有 PT 站的 passkey tracker）。
// 两个 handler 跑在同一进程，用模块级 Map 共享，TTL 1 小时。
const catalogMemory = new Map(); // infoHash -> { release, time }

function rememberReleases(releases) {
  for (const r of releases) {
    if (r.infoHash) catalogMemory.set(r.infoHash, { release: r, time: Date.now() });
  }
}

function recallRelease(hash) {
  const entry = catalogMemory.get(hash);
  if (entry && Date.now() - entry.time < 60 * 60 * 1000) return entry.release;
  catalogMemory.delete(hash);
  return null;
}

/**
 * 构建一个绑定到指定用户配置的 addon 实例。
 * 每次请求都调用本函数重建（配置在 URL 里，理论上每个用户配置都不同）。
 */
function buildAddon(config) {
  const builder = new addonBuilder(buildManifest(config));

  /**
   * 目录 handler：args = { type, id, extra }
   * extra.search 存在 → 用户在这个目录下点了搜索框
   * 我们不提供"首页推荐"（extra.search 为空直接返回空列表），
   * 因为这个插件的定位是"检索型"，不是"推荐型"。
   */
  builder.defineCatalogHandler(async ({ type, id, extra }) => {
    const query = extra && extra.search;
    if (!query || !query.trim()) return { metas: [] };

    // 目录 id 决定检索目标：成人目录走分类 6000，其余按 type 走
    let target = 'movie';
    if (id.includes('adult')) {
      if (!config.enableAdult) return { metas: [] }; // 双重保险：开关关了就拒绝
      target = 'adult';
    } else if (id.includes('series') || type === 'series') {
      target = 'series';
    }

    const releases = await searchProwlarr({
      baseUrl: config.prowlarrUrl,
      apiKey: config.prowlarrKey,
      query: query.trim(),
      type: target,
      limit: 20
    });

    rememberReleases(releases); // 供 stream handler 回溯标题/tracker

    return {
      metas: releases
        // 只有能拿到 infoHash 的条目才进目录（保证点进去一定有流）
        .filter((r) => r.infoHash)
        .map((r) => ({
          id: `rd:${r.infoHash}`,
          type: 'movie',
          name: r.title,
          // 用文本徽标充当封面（成人内容没有海报源，避免外链 404）
          poster: null,
          description:
            `索引器: ${r.indexer}\n大小: ${humanSize(r.size)}\n做种: ${r.seeders}`
        }))
    };
  });

  /**
   * 元数据 handler：Stremio 点开目录条目时先请求它渲染详情页。
   * 我们只为自己目录创建的 rd:<hash> 条目提供 meta（从 catalogMemory 回溯），
   * IMDb 条目（tt...）返回 null，交给官方 Cinemeta。
   */
  builder.defineMetaHandler(async ({ type, id }) => {
    if (!id.startsWith('rd:')) return { meta: null };
    const hash = id.slice(3).toLowerCase();
    const r = recallRelease(hash);
    return {
      meta: {
        id,
        type: 'movie',
        name: r ? r.title : hash,
        description: r
          ? `索引器: ${r.indexer}\n大小: ${humanSize(r.size)}\n做种: ${r.seeders}`
          : '',
        poster: null // 无海报源，Stremio 会显示占位图
      }
    };
  });

  /**
   * 播放流 handler：args = { type, id }
   * id 两种形态：'rd:<infoHash>'（本插件目录）或 IMDb id（官方 Cinemeta 目录）
   */
  builder.defineStreamHandler(async ({ type, id }) => {
    let infoHashes; // 直接确定要播的 hash
    let releases = null; // 或直接拿到一组候选 release

    if (id.startsWith('rd:')) {
      // 来自我们自己的目录：先查 catalog 暂存找回完整信息，没有再退化为裸 hash
      const h = id.slice(3).toLowerCase();
      infoHashes = [h];
      const remembered = recallRelease(h);
      if (remembered) {
        releases = [remembered];
      }
    } else {
      // IMDb id（剧集 id 形如 tt1234567:1:3，去掉季季后缀）
      const imdbId = id.split(':')[0];
      const meta = await cinemetaLookup(type, imdbId);
      if (!meta) return { streams: [] };

      // 剧集拼上 SxxEyy 提高命中率，例如 "The Last of Us S01E05"
      let query = meta.name;
      const parts = id.split(':');
      if (parts.length >= 3) {
        const s = String(parts[1]).padStart(2, '0');
        const e = String(parts[2]).padStart(2, '0');
        query += ` S${s}E${e}`;
      } else if (meta.year) {
        query += ` ${meta.year}`;
      }

      releases = await searchProwlarr({
        baseUrl: config.prowlarrUrl,
        apiKey: config.prowlarrKey,
        query,
        type: type === 'series' ? 'series' : 'movie',
        limit: 15
      });
      infoHashes = releases.map((r) => r.infoHash).filter(Boolean);
    }

    const streams = [];
    const byHash = new Map();
    if (releases) {
      for (const r of releases) if (r.infoHash) byHash.set(r.infoHash, r);
    }

    // ---- Real-Debrid 秒播路径 ----
    if (config.rdKey && infoHashes.length) {
      const instant = await getInstantHashes(config.rdKey, infoHashes.slice(0, 20));

      for (const hash of infoHashes) {
        if (!instant.has(hash)) continue; // 只给秒播的出 RD 流，其余走下面的回退
        const r = byHash.get(hash) || { title: hash, size: 0, seeders: 0, indexer: 'RD' };
        const magnet =
          r.magnetUrl ||
          `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(r.title)}`;
        try {
          const { links } = await resolveMagnet(config.rdKey, magnet);
          for (let i = 0; i < links.length; i++) {
            streams.push({
              name: `⚡RD ${qualityTag(r.title)}`,
              title:
                `${r.title}\n📦 ${humanSize(r.size)} · 做种 ${r.seeders} · ${r.indexer}`,
              // 直链走本插件 /proxy 转发（RD 直链必须带 Authorization，
              // 播放器不会带，所以由代理 302 跳转，详见 server.js）
              url: `/proxy/${encodeConfig(config)}/${hash}/${i}`,
              behaviorHints: { bingeGroup: `rd-${hash}` }
            });
          }
        } catch (err) {
          console.error(`[RD] 解析 ${hash} 失败:`, err.message);
        }
      }
    }

    // ---- 回退：裸 infoHash 磁力流（Stremio 内置 BitTorrent 引擎可播） ----
    const DEFAULT_TRACKERS = ['udp://open.tracker.cl:1337/announce'];
    for (const hash of infoHashes) {
      const r = byHash.get(hash) || {};
      // 私有 PT 站的 tracker 带 passkey，带上它 Stremio 引擎才能找到做种者
      const trackers = (r.trackers && r.trackers.length ? r.trackers : DEFAULT_TRACKERS)
        .map((t) => `tracker:${t}`);
      streams.push({
        name: `磁力 ${qualityTag(r.title || '')}`,
        title: `${r.title || hash}\n📦 ${humanSize(r.size)} · 做种 ${r.seeders} · ${r.indexer || '未知'}`,
        infoHash: hash,
        sources: trackers
      });
    }

    return { streams };
  });

  return builder.getInterface();
}

module.exports = { buildAddon, parseConfig, encodeConfig };
