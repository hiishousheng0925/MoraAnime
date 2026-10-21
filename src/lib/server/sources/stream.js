/**
 * m3u8 播放列表代理。
 *
 * 为什么要代理：DM84 的播放列表不带 CORS 头，桌面 Chrome 没有原生 HLS，hls.js 跨站拉列表直接被浏览器拦下
 * （实测 2026-10-19：列表 CORS=null，分片 CORS=*）。所以只代理【列表】—— 服务端拉下来，
 * 把里面的相对地址改成绝对地址交给浏览器；分片仍然由浏览器直连对方 CDN，几百 MB 的视频流量不经过这台机器。
 *   · 子列表（多码率 master → 具体码率）同样走代理
 *   · #EXT-X-KEY 的密钥：密钥小、又常常不带 CORS，也走代理
 *
 * ⚠️ 只代理我们自己发出去的地址：令牌 → {url, referer}，一小时过期。浏览器不能借这个接口让服务器请求任意地址；
 * 每一跳仍然过 assertPublic（内网拦截）。
 */
import { randomBytes } from 'node:crypto';
import { assertPublic, headersFor } from './scrape.js';

const TTL = 60 * 60_000;
const MAX_BYTES = 2_000_000;
/** mp4 中转等响应头的上限：对方站挂住不回时别让连接一直吊着（2026-10-21 审核） */
const HEAD_MS = 15_000;
const tokens = new Map();   // token → { url, referer, ua, kind, exp }

function issue(url, referer, ua, kind) {
  const now = Date.now();
  for (const [k, v] of tokens) if (v.exp <= now) tokens.delete(k);
  const t = randomBytes(12).toString('base64url');
  tokens.set(t, { url, referer, ua, kind, exp: now + TTL });
  return t;
}

/** 给前端的播放地址：m3u8 走代理，mp4 原样（<video> 播 mp4 不受 CORS 限制） */
export function playableUrl(url, referer, ua) {
  return /\.m3u8(?:\?|$)/i.test(new URL(url).pathname + new URL(url).search)
    ? `/api/stream/${issue(url, referer, ua, 'm3u8')}.m3u8` : url;
}

/**
 * 开超分时用的地址：直连 mp4 是跨站且不带 CORS 的，WebGPU 读不了它的画面（SecurityError），
 * 只能经本站中转（视频流量会经过这台机器，所以只在开超分时用）。m3u8 本来就是同源代理 + hls.js，不需要。
 */
export function superResUrl(url, referer, ua) {
  return /^\/api\/stream\//.test(url) ? null : `/api/stream/${issue(url, referer, ua, 'mp4')}.mp4`;
}

/** mp4 中转：带上浏览器的 Range 透传，拖进度条才不用从头下；每一跳照样过 assertPublic */
export async function streamMp4(token, range) {
  const entry = tokens.get(token);
  if (!entry || entry.kind !== 'mp4' || entry.exp <= Date.now()) return null;
  let u = new URL(entry.url);
  // 只限「连上 + 等到响应头」这一段（整条重定向链共用）：拿到头就撤掉计时器，
  // 不能用 AbortSignal.timeout —— 它到点会连正在传的视频流一起掐断，一集 24 分钟的中转不可能 15 秒传完
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(new Error('片源响应超时')), HEAD_MS);
  try {
    return await mp4Hops(u, entry, range, ac.signal);
  } finally { clearTimeout(timer); }
}

async function mp4Hops(u, entry, range, signal) {
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(u);
    // 不带 Referer：7sefun 的腾讯 CDN 带了外站来源就 404（和观看页的 no-referrer 同一个原因）
    const { referer: _drop, ...base } = headersFor({ userAgent: entry.ua }, null);
    const res = await fetch(u, { headers: { ...base, ...(range ? { range } : {}) }, redirect: 'manual', signal });
    const loc = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (loc) { await res.body?.cancel(); u = new URL(loc, u); continue; }
    if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
    const h = new Headers({ 'Content-Type': res.headers.get('content-type') || 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    for (const k of ['content-length', 'content-range']) if (res.headers.get(k)) h.set(k, res.headers.get(k));
    return new Response(res.body, { status: res.status, headers: h });
  }
  throw new Error('重定向过多');
}

async function get(entry) {
  const signal = AbortSignal.timeout(10_000);
  let u = new URL(entry.url);
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(u);
    const res = await fetch(u, { headers: headersFor({ userAgent: entry.ua }, entry.referer), redirect: 'manual', signal });
    const loc = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (loc) { await res.body?.cancel(); u = new URL(loc, u); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('太大');
    return { buf, url: u.href, type: res.headers.get('content-type') ?? '' };
  }
  throw new Error('重定向过多');
}

/** 播放列表里的地址全改成绝对地址；子列表和密钥换成代理令牌 */
function rewrite(text, base, entry) {
  const abs = (x) => new URL(x, base).href;
  const viaProxy = (x, kind) => `/api/stream/${issue(abs(x), entry.referer, entry.ua, kind)}.${kind}`;
  return text.split(/\r?\n/).map((line) => {
    const l = line.trim();
    if (!l) return line;
    if (l.startsWith('#')) {
      return /^#EXT-X-(?:KEY|SESSION-KEY)/i.test(l)
        ? l.replace(/URI="([^"]+)"/i, (_, x) => `URI="${viaProxy(x, 'key')}"`)
        : l.replace(/URI="([^"]+)"/i, (_, x) => `URI="${abs(x)}"`);     // #EXT-X-MAP 等
    }
    return /\.m3u8(?:\?|$)/i.test(l) ? viaProxy(l, 'm3u8') : abs(l);
  }).join('\n');
}

/** @returns {Promise<{body:string|Buffer, type:string}|null>} null = 令牌无效 / 过期 */
export async function streamFile(token) {
  const entry = tokens.get(token);
  if (!entry || entry.exp <= Date.now()) return null;
  const { buf, url, type } = await get(entry);
  if (entry.kind === 'key') return { body: buf, type: 'application/octet-stream' };
  const text = buf.toString('utf8');
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('不是 m3u8');
  return { body: rewrite(text, url, entry), type: 'application/vnd.apple.mpegurl' };
}

/** 截图用：mp4 中转令牌 → 原地址和 UA（只认 mp4 令牌、没过期的） */
export function mp4Target(token) {
  const e = tokens.get(token);
  return e && e.kind === 'mp4' && e.exp > Date.now() ? { url: e.url, ua: e.ua } : null;
}
