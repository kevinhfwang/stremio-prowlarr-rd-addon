/**
 * manifest.js — Stremio 插件清单（Manifest）构建器
 *
 * Manifest 是 Stremio 认识这个插件的"身份证"，包含：
 *  - 基本信息（id / name / version / description / icon）
 *  - 声明的 resources：本插件提供 catalog（目录/搜索）和 stream（视频流）
 *  - catalogs 列表：本插件提供的目录（这里根据用户配置动态决定要不要挂成人目录）
 *
 * 注意：Manifest 无法只在启动时生成一次，因为"是否启用成人目录"取决于
 * 用户在 /configure 页面里的开关。Stremio 的安装 URL 形如：
 *   stremio://<host>/<base64配置>/manifest.json
 * 所以每次请求 manifest 时我们从 URL 里的配置实时构建。
 */

'use strict';

// Prowlarr / Torznab 标准分类号（newznab 规范）
const CATEGORIES = {
  movie: 2000, // Movies（含 2010 等子类，Prowlarr 会自动展开）
  series: 5000, // TV
  adult: 6000 // XXX / Adult（成人内容总类，含 6010/6020/6030... 子类）
};

/**
 * 根据用户配置构建 manifest 对象。
 * @param {object} config 解析后的用户配置（来自 URL 中的 base64 段）
 * @param {string} config.prowlarrUrl   Prowlarr 服务地址
 * @param {string} config.prowlarrKey   Prowlarr API Key
 * @param {string} config.rdKey         Real-Debrid API Key（可选，不填则回退普通磁力流）
 * @param {boolean} config.enableAdult  是否启用成人分类
 */
function buildManifest(config) {
  // 常规目录：电影 + 剧集
  const catalogs = [
    {
      type: 'movie',
      id: 'prowlarr-movie',
      name: 'Prowlarr 电影搜索'
    },
    {
      type: 'series',
      id: 'prowlarr-series',
      name: 'Prowlarr 剧集搜索'
    }
  ];

  // 用户打开开关后，才在 manifest 里声明成人目录。
  // 类型仍声明为 'movie'（Stremio 目录类型只有 movie/series 两种），
  // 用目录 id 里的 'adult' 标记在 catalog handler 里区分检索目标。
  if (config.enableAdult) {
    catalogs.push({
      type: 'movie',
      id: 'prowlarr-adult',
      name: '成人影片 (18+)'
    });
  }

  return {
    id: 'com.kevin.stremio-prowlarr-rd',
    version: '1.0.0',
    name: 'Prowlarr + Real-Debrid 聚合',
    description:
      '通过 Prowlarr 聚合 BT 索引器，Real-Debrid 云端秒播' +
      (config.enableAdult ? '（已启用成人分类）' : ''),
    logo: 'https://stremio.com/website/stremio-logo.png',
    // 支持的媒体类型：movie 与 series（成人目录挂在 movie 下）
    types: ['movie', 'series'],
    // 提供的资源类型：目录（catalog）+ 播放流（stream）
    resources: ['catalog', 'stream'],
    catalogs: catalogs,
    // idPrefixes 不限制，因为成人目录条目用 "rd:<infoHash>" 自建 id
    behaviorHints: {
      configurable: true // 声明本插件有配置页（安装后显示配置按钮）
      // 注意：不要写 configurationRequired:true —— 那会阻止 Stremio 直接安装，
      // 变成永远往配置页踢的死循环。本插件配置已编码在安装 URL 里，无需此标记。
    }
  };
}

module.exports = { buildManifest, CATEGORIES };
