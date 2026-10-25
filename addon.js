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
const { coverForTitle } = require('./lib/jav');
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

// ---- 海报补全 ----
// 目录条目是 rd:<hash> 自建 id，Cinemeta 官方库查不到、Stremio 显示占位图。
// 但片名已知：清洗掉 release 后缀（画质/编码/俄语段），拿干净片名去 Cinemeta
// 的 top 目录搜，把海报/背景图补进 meta。
const posterCache = new Map();
const POSTER_CACHE_TTL = 24 * 60 * 60 * 1000;

/** 从 release 标题提取干净的搜索片名 + 年份 */
function cleanTitle(raw) {
  let t = String(raw || '');
  // 多语种子标题取拉丁字母最多的段：「Начало / Inception (2010) ...」→「Inception (2010) ...」
  if (t.includes('/')) {
    const segs = t.split('/').map((s) => s.trim());
    const latin = (s) => (s.match(/[a-zA-Z]/g) || []).length;
    const best = segs.reduce((a, b) => (latin(b) > latin(a) ? b : a));
    if (latin(best) > 0) t = best;
  }
  // 从画质/编码标记处截断（这些后缀全是种子信息，不是片名）
  t = t.replace(
    /\b(2160p|1080p|720p|480p|4k|uhd|bluray|bdrip|brrip|web[- ]?dl|webrip|hdtv|hdrip|remux|cam|hdcam|telesync|dvdscr|dvdrip|xvid|x26[45]|h26[45]|hevc|avc|mp4|mkv|dub|licension|лицензия)\b.*$/i,
    ''
  );
  const ym = t.match(/\b(19|20)\d{2}\b/);
  const year = ym ? ym[0] : null;
  t = t
    .replace(/[\[\(（【].*?[\]\)）】]/g, ' ') // 去括号内容
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { query: t, year };
}

/** 拿片名去 Cinemeta 搜海报，24h 缓存 */
async function cinemetaPoster(rawTitle) {
  const { query, year } = cleanTitle(rawTitle);
  if (query.length < 2) return null;
  const key = `${query}|${year || ''}`;
  const hit = posterCache.get(key);
  if (hit && Date.now() - hit.t < POSTER_CACHE_TTL) return hit.poster;
  try {
    const axios = require('axios');
    const { data } = await axios.get(
      `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(query)}.json`,
      { timeout: 8000 }
    );
    const metas = (data && data.metas) || [];
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const nq = norm(query);
    // 优先「标准化片名完全相等 + 年份一致」，其次只比片名，最后前缀匹配
    const best =
      metas.find((m) => norm(m.name) === nq && year && String(m.year) === year) ||
      metas.find((m) => norm(m.name) === nq) ||
      metas.find((m) => nq && (norm(m.name).startsWith(nq) || nq.startsWith(norm(m.name))));
    const poster = best ? { poster: best.poster, background: best.background } : null;
    posterCache.set(key, { t: Date.now(), poster });
    return poster;
  } catch {
    return null;
  }
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

    const metas = releases
      // 只有能拿到 infoHash 的条目才进目录（保证点进去一定有流）
      .filter((r) => r.infoHash)
      .map((r) => ({
        id: `rd:${r.infoHash}`,
        type: 'movie',
        name: r.title,
        poster: null,
        description:
          `索引器: ${r.indexer}\n大小: ${humanSize(r.size)}\n做种: ${r.seeders}`
      }));

    // 补海报：前 8 条并发。成人目录（Cinemeta 无成人内容）先从种子标题提取番号
    // 查 JavDB 拿封面；常规目录及成人未命中番号时走 Cinemeta。均有缓存。
    await Promise.all(
      metas.slice(0, 8).map(async (meta) => {
        let p = null;
        if (target === 'adult') {
          const jav = await coverForTitle(meta.name);
          if (jav) p = { poster: jav };
        }
        if (!p) p = await cinemetaPoster(meta.name);
        if (p) {
          meta.poster = p.poster;
          if (p.background) meta.background = p.background;
        }
      })
    );

    return { metas };
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
    // 详情页海报：番号条目优先 JavDB（成人内容 Cinemeta 没有），其余走 Cinemeta
    let p = null;
    if (r) {
      const jav = await coverForTitle(r.title);
      p = jav ? { poster: jav } : await cinemetaPoster(r.title);
    }
    return {
      meta: {
        id,
        type: 'movie',
        name: r ? r.title : hash,
        description: r
          ? `索引器: ${r.indexer}\n大小: ${humanSize(r.size)}\n做种: ${r.seeders}`
          : '',
        poster: p ? p.poster : null,
        background: p ? p.background : null
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

    // ---- 回退：磁力流（Stremio 内置 BitTorrent 引擎可播） ----
    // 注意：有完整 magnet 时优先直接给 url——Stremio 会把它原样交给
    // 引擎，dn/tr 参数保真。只给 infoHash+sources 的话，Stremio 会自己
    // 拼 magnet，sources 里的地址被原样塞进 tr= 导致非法（不能带 tracker: 前缀）。
    for (const hash of infoHashes) {
      const r = byHash.get(hash) || {};
      if (r.magnetUrl) {
        streams.push({
          name: `磁力 ${qualityTag(r.title || '')}`,
          title: `${r.title || hash}\n📦 ${humanSize(r.size)} · 做种 ${r.seeders} · ${r.indexer || '未知'}`,
          url: r.magnetUrl,
          behaviorHints: { bingeGroup: `mg-${hash}` }
        });
        continue;
      }
      // 实测：Stremio 会把 sources 原样拼进 magnet 的 tr= 参数，
      // 所以这里必须给裸地址，不能带 tracker: 前缀
      const sources = (r.trackers && r.trackers.length ? r.trackers : [])
        .map((t) => t.replace(/^tracker:/, ''));
      streams.push({
        name: `磁力 ${qualityTag(r.title || '')}`,
        title: `${r.title || hash}\n📦 ${humanSize(r.size)} · 做种 ${r.seeders} · ${r.indexer || '未知'}`,
        infoHash: hash,
        sources
      });
    }

    return { streams };
  });

  return builder.getInterface();
}

module.exports = { buildAddon, parseConfig, encodeConfig };
