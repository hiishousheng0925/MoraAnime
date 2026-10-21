import { myStats, triageStats } from '$lib/server/queries.js';
import { hideNsfw } from '$lib/server/loaderUtil.js';
import { getDb } from '$lib/server/db.js';
import { memoByDb } from '$lib/server/memo.js';
import { DRAWER_COOKIE } from '$lib/constants.js';

/**
 * 「裸页」= 不套主壳的路由：登录页、只读分享页。
 * 它们不该读个人统计 —— 侧栏那三行（在看 N / 累计 N 集 / 中文名已补）
 * 会顺着分享链接泄给拿到链接的人。
 */
const isBare = (p) => p.startsWith('/share/');

/**
 * 侧栏展开状态存 cookie 而不是 localStorage。
 * localStorage 只有浏览器里有 —— SSR 时读不到，只能先按收起渲染，
 * 等 JS 跑起来再展开，于是每次刷新都能看见「收起 → 弹出」那一下。
 * cookie 服务端就能读到，首屏直接渲染成正确的状态，没有跳变。
 * 没有 cookie 时默认展开。
 */
/** 测试站由 run-app.sh 传 J_ANIME_STAGING=1 —— 前端据此显示环境标识 */
const ENV = process.env.J_ANIME_STAGING === '1' ? 'test' : 'prod';
/** 页头 / 标签页标题上的品牌名：桌面客户端（MoraAnime）启动服务时传 J_ANIME_BRAND，网站不设 */
const BRAND = process.env.J_ANIME_BRAND || 'j-anime';
/** 桌面客户端（MoraAnime，单机单用户、免登录）：隐藏账号 / 注册白名单 / 分享 / 登出。网站不设 */
const DESKTOP = process.env.J_ANIME_DESKTOP === '1';
/** 客户端版本号（MoraAnime 主进程传进来），显示在侧栏左下角；网站不设 */
const APP_VERSION = DESKTOP ? process.env.J_ANIME_APP_VERSION || null : null;

export function load({ url, cookies, depends, locals }) {
  /**
   * 侧栏和页头的数字（看完 / 在看 / 累计集数 / 待标记）都在这里算。
   * 声明一个依赖名，页面改完记录后可以只让这个 load 重跑：
   *   快速标记的「下一批」是 API 调用、不导航，布局数据不会自动重取 ——
   *   实测页头写着「待判定 480」而侧栏还挂着 504。
   * 用 invalidate('app:stats') 而不是 invalidateAll()：后者会把快速标记页刚从
   * 接口拿到的新队列也一起重置掉。
   */
  depends('app:stats');
  const drawerOpen = cookies.get(DRAWER_COOKIE) !== '0';   // 缺省 = 展开
  if (isBare(url.pathname))
    return { env: ENV, brand: BRAND, desktop: DESKTOP, appVersion: APP_VERSION, bare: true, drawerOpen, user: null, stats: {}, triage: {}, gateCovers: [], hideNsfw: false };
  // 当前账号（多账号，2026-10-19）：只给前端要用的几项。访客 = null，侧栏不显示个人统计
  const u = locals.user;
  const user = u ? { id: u.id, username: u.username, email: u.email, role: u.role } : null;

  /**
   * 访客在个人页（番单 / 统计 / 快速标记）看到的 LoginGate 背后铺一面热门封面墙。
   * 只给访客算；收藏数最高、有本地封面、非成人内容的 24 部，库不变就走缓存。
   * 「中文名已补 N」原来也在这里算、挂在侧栏 —— 2026-10 移到设置页「数据」区（访客不该看到运维数字）。
   */
  const gateCovers = user ? [] : memoByDb('layout:gateCovers', () => getDb().prepare(
    `SELECT id FROM anime WHERE is_stub = 0 AND is_nsfw = 0 AND cover_dead = 0 AND cover_local_path IS NOT NULL
     ORDER BY bgm_collection DESC LIMIT 24`).all().map((r) => r.id));
  return { env: ENV, brand: BRAND, desktop: DESKTOP, appVersion: APP_VERSION, bare: false, drawerOpen, user, stats: user ? myStats() : {}, triage: user ? triageStats() : {}, gateCovers,
           hideNsfw: hideNsfw() };
}
