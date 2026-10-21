/**
 * 片源门面：并发搜所有规则、取剧集、解析播放地址。API 路由只认这里。
 *
 * 两道防护：
 *   · 带缓存 —— 同一个关键词反复点不会反复打别人的站（10 分钟）
 *   · 只认「我们自己吐出去过的链接」—— episodes / resolve 收到的 url 必须是前面搜索或
 *     取剧集时返回过的，浏览器不能借这个接口让服务器去请求任意地址
 */
import { loadRules, getRule } from './rules.js';
import { search, episodes } from './scrape.js';
import { resolvePlay } from './resolve.js';
import { sniffPlay } from './sniff.js';
import { playableUrl, superResUrl } from './stream.js';
import { UA, sameSite } from './scrape.js';

const TTL = 10 * 60_000;
export const HTML_BUDGET = 6000;
/** 限时：到点还没结果就当 null（#100）。要停掉原来那条请求，调用方自己在到点后 abort（见 resolveEpisode） */
export const budget = (p, ms) => Promise.race([p, new Promise((ok) => setTimeout(() => ok(null), ms))]);
const memo = new Map();               // key → { at, value }
const inflight = new Map();           // key → { p, ac, waiters, pinned }
const issued = new Map();             // url → 过期时间

/** 存的时候顺手清掉过期项 —— 原来只判断不删除，常驻进程里这张表只增不减 */
const remember = (urls) => {
  const now = Date.now();
  for (const [u, exp] of issued) if (exp <= now) issued.delete(u);
  for (const u of urls) issued.set(u, now + 60 * 60_000);
};
const known = (u) => (issued.get(u) ?? 0) > Date.now();
/**
 * 白名单之外再放行「规则所属站点自己的页面」（#91）：白名单只记一小时、服务器一重启就清空，
 * 开着观看页看完两三集再点下一集就是「链接已过期」。只认和规则 baseURL 同一个主域名的 http(s) 地址 ——
 * 浏览器照样没法借这个接口让服务器去请求任意地址（每一跳还有 assertPublic 内网拦截）
 */
const allowed = (rule, u) => known(u) || sameSite(rule, u);

/**
 * keep(value) 为假就不缓存：失败的解析不能缓存 10 分钟，否则「重新加载」拿到的还是那次失败（#90）。
 *
 * 同一个 key 同时只跑一次（2026-10-21 审核）：两个标签页 / 连点同一集，原来各打一遍对方的站、各开一个嗅探页。
 * fn 收到的 signal 只在「所有等它的请求都取消了」时才 abort —— 一个人走了不能连累同时在等的另一个人；
 * 不带 signal 来等的（搜索）视为一直在等，那一次就跑到底。
 */
export async function cached(key, fn, { fresh = false, keep = () => true, signal } = {}) {
  const hit = memo.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.value;
  let run = inflight.get(key);
  if (!run) {
    const ac = new AbortController();
    run = { ac, waiters: 0, pinned: false };
    run.p = (async () => {
      try {
        const value = await fn(ac.signal);
        if (ac.signal.aborted || !keep(value)) { memo.delete(key); return value; }
        memo.set(key, { at: Date.now(), value });
        if (memo.size > 500) for (const [k, v] of memo) if (Date.now() - v.at > TTL) memo.delete(k);
        return value;
      } finally { if (inflight.get(key) === run) inflight.delete(key); }
    })();
    run.p.catch(() => {});        // 等它的人都走了时没人接这个 rejection
    inflight.set(key, run);
  }
  if (!signal) { run.pinned = true; return run.p; }
  signal.throwIfAborted();
  run.waiters++;
  return new Promise((ok, no) => {
    let gone = false;
    const leave = () => { if (gone) return false; gone = true; signal.removeEventListener('abort', onAbort); run.waiters--; return true; };
    const onAbort = () => { if (leave() && run.waiters === 0 && !run.pinned) run.ac.abort(); no(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    run.p.then((v) => { leave(); ok(v); }, (e) => { leave(); no(e); });
  });
}

/** 每个站一项：搜到的候选；某个站失败只影响它自己 */
export async function searchAll(keyword) {
  const rules = await loadRules();
  return Promise.all(rules.map(async (r) => {
    try {
      // 网络层失败（fetch failed）再试一次：一次抖动就让站从片源列表里整个消失（7sefun）
      const once = () => search(r, keyword);
      // 空结果不缓存：对方回了反爬页 / 验证页时也是 0 条，原来会被记成「没有」10 分钟（2026-10-21 审核）
      const hits = await cached(`s:${r.name}:${keyword}`,
        () => once().catch((e) => (e.message === 'fetch failed' ? once() : Promise.reject(e))),
        { keep: (v) => v.length > 0 });
      remember(hits.map((h) => h.url));
      return { site: r.name, hits };
    } catch (e) {
      return { site: r.name, hits: [], error: e.message };
    }
  }));
}

export async function getEpisodes(site, url) {
  const rule = await getRule(site);
  if (!rule || !allowed(rule, url)) return { error: '链接已过期，请重新搜索' };
  let roads;
  try { roads = await cached(`e:${site}:${url}`, () => episodes(rule, url), { keep: (v) => v.length > 0 }); }
  catch (e) { return { error: e.message }; }
  remember(roads.flatMap((r) => r.eps.map((e) => e.url)));
  return { roads };
}

/**
 * @returns {Promise<{url:string, via?:string}|{error:string}>} 解析不出来就报错，界面退回「去原站打开」
 *
 * 两步：先读 HTML（快、便宜）；读不出来再用无头浏览器嗅探（sniff.js，1–6 秒）——
 * 7sefun / DM84 的地址是脚本算出来的，只有第二步拿得到。
 * m3u8 一律换成本站代理地址（stream.js）：列表常常不带 CORS，hls.js 跨站拉不下来。
 */
export async function resolveEpisode(site, url, { fresh = false, signal } = {}) {
  const rule = await getRule(site);
  if (!rule || !allowed(rule, url)) return { error: '链接已过期，请重新搜索' };
  try {
    const r = await cached(`r:${site}:${url}`, async (sig) => {
      // 读 HTML 这一步限时（#100）：它会进两层 iframe、每次抓取各有 9 秒超时，最坏要等二三十秒才轮到嗅探。
      // 到点就 abort 掉 —— 原来到点只是不等了，那条链还在后台把 iframe 抓完（2026-10-21 审核）
      const html = AbortSignal.any([sig, AbortSignal.timeout(HTML_BUDGET)]);
      const s = await budget(resolvePlay(rule, url, { signal: html }).catch(() => null), HTML_BUDGET);
      if (s) return { ...s, via: 'html' };
      if (sig.aborted) return null;
      const b = await sniffPlay(url, rule.userAgent || UA, sig);
      return b ? { ...b, via: 'browser' } : null;
    }, { fresh, keep: (v) => v != null, signal });
    if (!r) return { error: '没找到可直接播放的地址' };
    const ua = rule.userAgent || UA, play = playableUrl(r.url, r.referer, ua);
    // srUrl：开超分时换用的同源地址（直连 mp4 跨站不可读，见 stream.js: superResUrl）；m3u8 本来就是同源，不给。
    // ⚠️ 别叫 url —— 和参数 url（播放页地址）同名，块级声明会让上面的 cached(`r:…:${url}`) 落进暂时性死区
    return { url: play, srUrl: superResUrl(play, r.referer, ua), via: r.via };
  } catch (e) {
    // 取消的、排队满的不是这个站的问题：transient 让路由别记进站点战绩
    if (signal?.aborted) return { error: '已取消', transient: true };
    return e.code === 'BUSY' ? { error: e.message, transient: true } : { error: e.message };
  }
}
