/**
 * server.js — Express 入口
 *
 * 路由设计：
 *   GET /configure              → 精美的 HTML 配置页（输入 Prowlarr/Real-Debrid，勾选成人开关）
 *   ALL /:config/*              → Stremio SDK 路由（manifest.json / catalog / stream）
 *                                  :config 段是 base64url 编码的用户配置
 *   GET /proxy/:config/:hash/:idx → Real-Debrid 直链代理（带 RD 鉴权 302 跳转）
 *
 * 关于 RD 代理：RD 的直链必须带 Authorization: Bearer <key> 头，
 * 而 Stremio 播放器（以及 VLC/MPV 外链打开）不会替你带这个头。
 * 所以流地址指向我们自己的 /proxy 路由，由服务器带上 RD 鉴权
 * 向 RD 请求后 302 重定向到真实直链。RD 直链生成后短时间内在
 * 同 IP 下可直接访问，播放器跟随重定向即可播放。
 */

'use strict';

const path = require('path');
const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const { buildAddon, parseConfig, encodeConfig } = require('./addon');
const { resolveMagnet } = require('./lib/realdebrid');

const PORT = process.env.PORT || 7000;
const app = express();

// ---------------------------------------------------------------------------
// 1. RD 直链代理（必须在 /:config 通配之前注册，避免被 SDK 路由吃掉）
// ---------------------------------------------------------------------------

// 解析结果缓存：hash → { time, links }（RD 解析一次即可，5 分钟内复用）
const proxyCache = new Map();
const PROXY_CACHE_TTL = 5 * 60 * 1000;

app.get('/proxy/:config/:hash/:idx', async (req, res) => {
  try {
    const config = parseConfig(req.params.config);
    if (!config.rdKey) {
      return res.status(400).send('该配置未设置 Real-Debrid API Key');
    }
    const hash = req.params.hash.toLowerCase();
    const idx = parseInt(req.params.idx, 10) || 0;

    let entry = proxyCache.get(hash);
    if (!entry || Date.now() - entry.time > PROXY_CACHE_TTL) {
      // 用裸 magnet 重新提交 RD 换取直链（RD 对同 hash 是幂等的）
      const magnet = `magnet:?xt=urn:btih:${hash}`;
      const { links } = await resolveMagnet(config.rdKey, magnet);
      if (!links.length) {
        return res.status(404).send('Real-Debrid 未找到可播放文件');
      }
      entry = { time: Date.now(), links };
      proxyCache.set(hash, entry);
    }

    const target = entry.links[idx];
    if (!target) {
      return res.status(404).send('文件索引超出范围');
    }
    // 302 重定向到 RD 直链。这样播放器直接拉 RD 的 CDN，
    // 我们的服务器只承担跳转，不做中转带宽。
    res.redirect(target.url);
  } catch (err) {
    console.error('[proxy] 错误:', err.message);
    res.status(502).send(`代理失败: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// 2. 配置页面
// ---------------------------------------------------------------------------

app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// ---------------------------------------------------------------------------
// 3. Stremio SDK 路由（带用户配置前缀）
// ---------------------------------------------------------------------------

// 首页（不带配置访问根域名）→ 引导到配置页
app.get('/', (req, res) => {
  res.redirect('/configure');
});

// 简单健康检查（Docker HEALTHCHECK / 反向代理探活用）
// 注意必须在 /:config 通配之前注册，否则会被当成配置段解析
app.get('/health', (req, res) => res.json({ ok: true }));

// Stremio 安装含 configurable 声明的插件后，会自动打开
// <插件地址>/<config>/configure —— 重定向到根配置页
app.get('/:config/configure', (req, res) => res.redirect('/configure'));

// 关键：Express 的 app.use 支持路径参数，把 /:config 后面的所有子路径
// 转交给为该配置实时构建的 SDK 路由处理：
//   /<config>/manifest.json
//   /<config>/catalog/movie/prowlarr-adult/search=xxx.json
//   /<config>/stream/movie/rd:<hash>.json
app.use('/:config', (req, res, next) => {
  let config;
  try {
    config = parseConfig(req.params.config);
  } catch (err) {
    return res
      .status(400)
      .send('无效的配置段。请访问 /configure 生成安装链接。<br>' + err.message);
  }
  // 每个请求按配置构建 addon 实例（manifest 内容随成人开关变化）
  const router = getRouter(buildAddon(config));
  router(req, res, next);
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ Stremio Prowlarr+RD 插件已启动`);
  console.log(`   配置页面:  http://localhost:${PORT}/configure`);
  console.log(`   健康检查:  http://localhost:${PORT}/health`);
});
