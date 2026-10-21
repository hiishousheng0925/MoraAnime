/**
 * 无头浏览器嗅探播放地址 —— 和 Kazumi 的思路一样：打开播放页，让对方的脚本自己跑，
 * 截下它发出去的 m3u8 / mp4 请求。
 *
 * 为什么要这一步（2026-10-19）：7sefun / DM84 的播放地址是页面脚本运行时才算出来的，
 * resolve.js 只读 HTML 永远拿不到，界面上只能「到原站看」；而这两家正好画质最好（DM84 3000k 码率）。
 * 实测四家站点 1.3–6 秒都能嗅到。
 *
 * 用本机已装的 Chrome（playwright-core 不自带浏览器）；找不到 Chrome 就整个跳过，退回原来的行为。
 * 浏览器常驻复用，空闲 5 分钟关掉；每次嗅探一个独立的 context，用完即关。
 *
 * ⚠️ 安全：这里在跑别人站点的脚本。每个请求都过 assertPublic（和服务端抓取同一套内网拦截），
 * 页面就没法借我们的浏览器去请求本机的正式站 / 数据库或 Tailscale 内网。
 */
import { existsSync } from 'node:fs';
import { assertPublic } from './scrape.js';
import { AD } from './resolve.js';
import { limiter } from './limit.js';

const CANDIDATES = [
  process.env.J_ANIME_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium'
].filter(Boolean);
const CHROME = CANDIDATES.find((p) => existsSync(p)) ?? null;

/** 实测嗅到的都在 1.3–6 秒内；12 秒等满再失败太久（#100） */
export const WAIT_MS = 8_000;
const IDLE_MS = 5 * 60_000;
const MAX_PARALLEL = 2;
/** 排队上限（2026-10-21 审核）：再多就直接回「繁忙」，排在第 7 个之后的等到也早过了解析预算 */
const MAX_QUEUE = 6;
const MEDIA = /\.(?:m3u8|mp4)(?:\?|$)/i;

let browser = null, idleTimer = null;

// 启动中的那次也要记住：MAX_PARALLEL=2，两个嗅探同时撞上冷启动会各开一个 Chrome，
// 先开的那个被覆盖后没人引用，空闲定时器也关不到它（审核发现，2026-10-21）
let launching = null;
async function getBrowser() {
  clearTimeout(idleTimer);
  if (browser?.isConnected()) return browser;
  launching ??= (async () => {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: CHROME, headless: true,
      args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-gpu'] });
    return browser;
  })().finally(() => { launching = null; });
  return launching;
}
const scheduleIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { browser?.close().catch(() => {}); browser = null; }, IDLE_MS); };

/** 同时最多 MAX_PARALLEL 个嗅探，多的排队（一屏点好几集时别同时开一堆浏览器页） */
const slot = limiter(MAX_PARALLEL, MAX_QUEUE, { onIdle: scheduleIdle });

/**
 * 嗅到的若是一张套壳播放器页（baimao 的 artplayer/index.html?url=…m3u8），取它参数里的地址。
 * isMedia：浏览器把它当媒体请求（resourceType=media）或响应是视频类型 —— 7sefun 线路 2 的 CDN 地址
 * 不带 .mp4 后缀（…/video/tos/alisg/…），只看后缀会漏
 */
function mediaOf(u, isMedia = false) {
  try {
    const x = new URL(u);
    if (AD.test(x.pathname)) return null;
    if (isMedia || /\.(?:m3u8|mp4)$/i.test(x.pathname)) return u;
    for (const v of x.searchParams.values()) if (/^https?:/i.test(v) && MEDIA.test(v)) return mediaOf(v);
  } catch { /* 坏地址 */ }
  return null;
}


/**
 * @param {AbortSignal} [signal] 浏览器断开 / 换了一集：排队中的直接出队，跑着的提前关页（2026-10-21 审核）
 * @returns {Promise<{url:string, referer:string}|null>} 队列满时抛 code = 'BUSY'
 */
export function sniffPlay(playUrl, userAgent, signal) {
  if (!CHROME) return Promise.resolve(null);
  return slot(async () => {
    if (signal?.aborted) return null;
    const b = await getBrowser();
    const ctx = await b.newContext({ userAgent, javaScriptEnabled: true });
    let onAbort;
    try {
      await ctx.route('**/*', async (route) => {
        const req = route.request();
        // 图片 / 字体 / 样式不需要，省时间也省流量
        if (['image', 'font', 'stylesheet'].includes(req.resourceType())) return route.abort();
        try { await assertPublic(new URL(req.url())); return route.continue(); } catch { return route.abort(); }
      });
      const found = new Promise((resolve) => {
        const hit = (u, ref, isMedia) => { const m = mediaOf(u, isMedia); if (m) resolve({ url: m, referer: ref || playUrl }); };
        ctx.on('request', (r) => hit(r.url(), r.headers().referer, r.resourceType() === 'media'));
        ctx.on('response', (r) => { if (/mpegurl|^video\//i.test(r.headers()['content-type'] ?? '')) hit(r.url(), r.request().headers().referer, true); });
      });
      const cancelled = new Promise((r) => { onAbort = () => r(null); signal?.addEventListener('abort', onAbort, { once: true }); });
      const page = await ctx.newPage();
      page.goto(playUrl, { waitUntil: 'domcontentloaded', timeout: WAIT_MS }).catch(() => {});
      return await Promise.race([found, cancelled, new Promise((r) => setTimeout(() => r(null), WAIT_MS))]);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await ctx.close().catch(() => {});
    }
  }, signal);
}
