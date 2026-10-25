/**
 * lib/jav.js — 成人影片（JAV）封面补全
 *
 * Sukebei 的种子标题里几乎都带番号（如 SSIS-950、FC2-PPV-1234567、HEYZO-1234），
 * JavDB（javdb.com）按番号搜索的结果页直接内嵌高清封面图。
 * 本模块做两件事：
 *   1. 从种子标题提取规范化番号
 *   2. 查 JavDB 拿封面 URL（永久缓存）
 *
 * 注意：这是网页结构正则解析，JavDB 改版会失效——失效时返回 null，
 * 上游自动退化为无封面，不影响其他功能。
 */

'use strict';

const axios = require('axios');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// 番号字母部分的黑名单：这些 "看起来像番号" 的其实是编码/画质词
const CODE_BLOCKLIST = new Set([
  'X264', 'X265', 'H264', 'H265', 'HEVC', 'AVC', 'MP4', 'MKV', 'AVI',
  'WEB', 'HDR', 'SDR', 'UHD', 'AAC', 'FLAC', 'DTS', 'DDP', 'EAC3',
  'REMUX', 'NF', 'AMZN', 'WEBRIP', 'HDTV', 'BDMV', 'ISO', 'GB', 'MB',
  'VOL', 'EP', 'SP', 'DVD'
]);

// 结果缓存：番号 → 封面 URL 或 null（番号-封面映射永不过期）
const coverCache = new Map();

/**
 * 从种子标题提取规范番号（大写字母 + 连字符 + 数字）。
 * @param {string} title 种子标题
 * @returns {string|null} 如 "SSIS-950"，提取不到返回 null
 */
function extractCode(title) {
  let t = String(title || '');
  // 先去括号内容（[发布组] 之类的干扰）——但保留 FC2-PPV 这类本身无括号的
  t = t.replace(/[\[\]【】()（）]/g, ' ');
  // 统一分隔符
  t = t.replace(/[._]+/g, ' ');

  // FC2-PPV-1234567 / FC2 PPV 1234567
  let m = t.match(/\bFC2[- ]?PPV[- ]?(\d{6,7})\b/i);
  if (m) return `FC2-PPV-${m[1]}`;

  // HEYZO-1234
  m = t.match(/\bHEYZO[- ]?(\d{4})\b/i);
  if (m) return `HEYZO-${m[1]}`;

  // Caribbean/1Pondo 风格的 012345-678（6位-3位纯数字）
  m = t.match(/\b(\d{6})[-_](\d{3})\b/);
  if (m) return `${m[1]}-${m[2]}`;

  // 常规番号：2~6 个大写字母 + 连字符 + 3~5 位数字（允许无连字符/下划线/空格分隔）
  m = t.match(/\b([A-Za-z]{2,6})[-_ ]?(\d{3,5})\b/);
  if (m) {
    const letters = m[1].toUpperCase();
    if (!CODE_BLOCKLIST.has(letters)) {
      return `${letters}-${m[2]}`;
    }
  }
  return null;
}

/**
 * 查 JavDB 搜索页，返回第一个结果的封面 URL。
 * @param {string} code 规范番号
 * @returns {Promise<string|null>} 封面图 URL 或 null
 */
async function javdbCover(code) {
  if (coverCache.has(code)) return coverCache.get(code);
  let url = null;
  try {
    const { data } = await axios.get('https://javdb.com/search', {
      params: { q: code, f: 'all' },
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      timeout: 12000,
      maxRedirects: 3
    });
    // 结果页封面都托管在 c0.jdbstatic.com/covers/ 下，抓第一张
    const match = data.match(/https:\/\/c0\.jdbstatic\.com\/covers\/[a-z0-9]+\/[a-zA-Z0-9]+\.jpg/);
    url = match ? match[0] : null;
  } catch (err) {
    // JavDB 不可达/改版/被 CF 拦：静默降级为无封面
    console.error(`[jav] JavDB 查询 ${code} 失败:`, err.message);
  }
  coverCache.set(code, url);
  return url;
}

/**
 * 一步到位：种子标题 → 封面 URL。
 * @param {string} title 种子标题
 * @returns {Promise<string|null>}
 */
async function coverForTitle(title) {
  const code = extractCode(title);
  if (!code) return null;
  return javdbCover(code);
}

module.exports = { extractCode, coverForTitle };
