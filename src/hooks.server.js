/**
 * 鉴权闸门（多账号，2026-10-19）。
 *
 * 页面一律不挡：不登录也能逛目录、排行、放送表、详情、站内播放。
 * 和自己有关的数据靠两层隔离：
 *   1. 数据层：个人表是按 uid() 过滤的视图（见 multiUser.js），访客看到的就是空的
 *   2. 接口层：写操作（非 GET 的 /api/*）要登录，下面 OPEN_WRITE 里的除外；
 *      公共修正（观看站 / 系列顺序 / 手动关联 / 白名单）只有管理员能改
 *
 * 每个请求用 withUser 包起来，之后 loader / 接口 / queries 都能拿到当前账号（见 userCtx.js）。
 */
import { COOKIE, sessionUser, cookieOpts } from '$lib/server/auth.js';
import { withUser } from '$lib/server/userCtx.js';

/** 访客也能写的接口 */
const OPEN_WRITE = ['/api/auth', '/api/client-error', '/api/sources', '/api/screenshot', '/api/settings'];
/** 只有管理员能写的接口 */
const ADMIN_WRITE = ['/api/watch-sites', '/api/order', '/api/relation', '/api/admin/'];
/** 访客也能读的接口（其余 GET /api/* 要登录：导出的是个人数据） */
const OPEN_READ = ['/api/sources', '/api/stream/', '/api/auth', '/api/health', '/api/search'];

/** 访客偏好：只收这几个键，存 cookie（不进库） */
const GUEST_PREF_KEYS = ['hide_nsfw', 'year_min', 'year_max'];
const PREFS_COOKIE = 'j_prefs';
function readPrefs(cookies) {
  try {
    const o = JSON.parse(cookies.get(PREFS_COOKIE) ?? '{}');
    return Object.fromEntries(GUEST_PREF_KEYS.filter((k) => o[k] != null).map((k) => [k, String(o[k]).slice(0, 8)]));
  } catch { return {}; }
}

/**
 * 按路径段匹配，不按字符串前缀（2026-10-21 审核）：'/api/settings' 原来会把将来的 '/api/settings-site'
 * 也当成访客可写。清单里以 / 结尾的（'/api/admin/'、'/api/stream/'）本来就只管子路径，照旧按前缀
 */
const starts = (p, list) => list.some((x) => (x.endsWith('/') ? p.startsWith(x) : p === x || p.startsWith(x + '/')));
const deny = (status, msg) => new Response(JSON.stringify({ error: msg }), {
  status, headers: { 'content-type': 'application/json' }
});

export async function handle({ event, resolve }) {
  const token = event.cookies.get(COOKIE);
  const s = sessionUser(token);
  if (token && !s) event.cookies.delete(COOKIE, { path: '/' });   // 过期 / 已登出的残留
  if (s?.renew) event.cookies.set(COOKIE, token, cookieOpts(event));
  const user = s?.user ?? null;
  event.locals.user = user;

  const p = event.url.pathname;
  if (p.startsWith('/api/')) {
    const write = event.request.method !== 'GET' && event.request.method !== 'HEAD';
    if (write && !user && !starts(p, OPEN_WRITE)) return deny(401, '请先登录');
    if (write && starts(p, ADMIN_WRITE) && user?.role !== 'admin') return deny(403, '只有管理员能改');
    if (!write && !user && !starts(p, OPEN_READ)) return deny(401, '请先登录');
  }

  const ctx = { user, prefs: user ? {} : readPrefs(event.cookies) };
  const before = JSON.stringify(ctx.prefs);
  const res = await withUser(ctx, () => resolve(event));

  // 访客在这次请求里改了偏好（/api/settings 走 setSetting → ctx.prefs）→ 写回 cookie
  if (!user && JSON.stringify(ctx.prefs) !== before) {
    const keep = Object.fromEntries(GUEST_PREF_KEYS.filter((k) => ctx.prefs[k] != null).map((k) => [k, ctx.prefs[k]]));
    res.headers.append('set-cookie', event.cookies.serialize(PREFS_COOKIE, JSON.stringify(keep),
      { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 3600, secure: false }));
  }

  /**
   * 页面 HTML 和 __data.json 一律禁止「不问就用缓存」。
   *
   * 实测事故：主人点侧栏「设置」，标签标题是「设置」（说明整页加载成功了）
   * 但页面整片空白。无头 Chrome 里同一个产物水合完全正常
   * （DOM 从 18,268 涨到 22,105 字节，各区块都在），所以不是代码问题。
   *
   * 根因是响应头：HTML 只带 etag、【没有 cache-control】，浏览器就按启发式
   * 规则自己决定缓存多久。而 SSR 出来的 HTML 里嵌着带哈希的资源名
   * （/_app/immutable/entry/app.DmQ-1DcO.js 这种），发布后那批文件就被删了 ——
   * 于是缓存里的旧 HTML 去拉已经不存在的 chunk，水合直接炸，表现就是整页空白。
   *
   * 用 no-cache 而不是 no-store：no-cache 是「每次都回来问一句」，
   * 配合已有的 etag，没变化时服务端回 304，几乎没有额外开销；
   * no-store 则连 304 都不给，白扔掉一次协商。
   *
   * immutable 资源相反 —— 文件名带哈希，adapter-node 给的
   * `public,max-age=31536000,immutable` 是对的，这里不动它。
   *
   * 多账号后还多一层理由：同一个地址登录前后内容不同，绝不能被缓存成别人的版本。
   */
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/html') || p.endsWith('/__data.json')) {
    res.headers.set('cache-control', 'no-cache');
    res.headers.append('vary', 'Cookie');
  }
  return res;
}
