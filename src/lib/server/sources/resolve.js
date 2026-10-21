/**
 * 播放页 → 真实视频地址（m3u8 / mp4）。尽力而为：
 * 站点把地址藏在哪种位置各不相同，这里只认三种常见写法，认不出就返回 null，
 * 界面退回「去原站打开」。Kazumi 是用内嵌 WebView 嗅探网络请求，服务端做不到那一步。
 *
 *   1. 页面源码里直接出现的 .m3u8 / .mp4 地址
 *   2. 苹果 CMS 的 player_aaaa = {"url": …, "encrypt": 0|1|2|3}
 *   3. iframe 里套的播放器页（最多再进两层）—— 地址常常就挂在 iframe 的 ?url= 参数上
 */
import { fetchText } from './scrape.js';

const MEDIA = /https?:(?:\\?\/){2}[^"'\s<>\\]+?(?:\\?\.)(?:m3u8|mp4)(?:\?[^"'\s<>\\]*)?/gi;

const clean = (u) => u.replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');

/**
 * 片头广告 / 占位视频：文件名带这些词的不要（AGE 的页面里就挂着一个 adposter.mp4）。
 * sniff.js 也用这一份（原来各抄一份，2026-10-21 审核）
 */
export const AD = /(?:^|[/_.-])(?:ads?|adposter|advert|preroll|loading|logo)(?:[/_.-]|\d|$)/i;
const isMedia = (u) => /\.(?:m3u8|mp4)(?:\?|$)/i.test(u) && !AD.test(new URL(u).pathname);

/** 苹果 CMS 的 encrypt：0 明文；1 escape()；2 base64 后再 escape()；3 先 base64 再逐字符偏移（不支持） */
function cmsUrl(html) {
  const m = html.match(/player_[a-z]+\s*=\s*(\{[^<]*?\})\s*(?:<\/script>|;|$)/i);
  if (!m) return null;
  let o; try { o = JSON.parse(m[1]); } catch { return null; }
  let u = String(o.url ?? '');
  try {
    if (+o.encrypt === 1) u = unescape(u);
    else if (+o.encrypt === 2) u = unescape(Buffer.from(unescape(u), 'base64').toString('latin1'));
    else if (+o.encrypt >= 3) return null;
  } catch { return null; }
  return /^https?:/i.test(u) ? u : null;
}

/**
 * 页面里的视频地址；player_aaaa 给的若是另一张播放器页，就不算「直链」，交给下一跳。
 * player_aaaa.url 就是这一集，先认它：xfdmneo 的页面里还有一段脚本明文写着下一集的地址
 * （"next": "…说出11.mp4"），原来先扫源码，每一集都播成了下一集
 */
export function direct(s) {
  const c = cmsUrl(s);
  if (c && isMedia(c)) return { url: c };
  const hits = (s.match(MEDIA) ?? []).map(clean).filter(isMedia);
  const found = hits.find((u) => /\.m3u8/i.test(u)) ?? hits[0];
  return found ? { url: found } : { page: c };
}

/** iframe 地址 / 页面里 ?url= 参数里挂的视频 */
const fromQuery = (src) => {
  try {
    const v = new URL(src).searchParams.get('url');
    return v && /^https?:/i.test(v) && isMedia(v) ? v : null;
  } catch { return null; }
};

/**
 * @returns {Promise<{url:string,referer:string}|null>} referer：拉流时要带的来源，
 *   很多 CDN 校验它，不带就 403
 * signal：限时到了 / 浏览器走了就停（原来 budget 到点后这条链还在后台把两层 iframe 抓完，2026-10-21 审核）
 */
export async function resolvePlay(rule, playUrl, { depth = 0, signal } = {}) {
  const { text, url } = await fetchText(playUrl, rule, undefined, signal);
  const hit = direct(text);
  if (hit.url) return { url: hit.url, referer: url };
  if (depth >= 2) return null;
  const frames = [...(hit.page ? [hit.page] : []),
      ...[...text.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1])]
    .map((u) => { try { return new URL(clean(u), url).href; } catch { return ''; } })
    .filter((u) => /^https?:/.test(u) && !/(?:ads?|banner|google|facebook)/i.test(new URL(u).hostname));
  for (const f of frames.slice(0, 3)) {
    const q = fromQuery(f);
    if (q) return { url: q, referer: f };
    try {
      const r = await resolvePlay(rule, f, { depth: depth + 1, signal });
      if (r) return r;
    } catch { if (signal?.aborted) return null; /* 这一层不通就试下一个 iframe；被取消了就别再试 */ }
  }
  return null;
}
