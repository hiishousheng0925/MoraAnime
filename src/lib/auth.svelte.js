/**
 * 登录弹窗的全局状态（2026-10-19 多账号）。
 *
 * 主人的要求：不强制登录，只有用到和自己有关的功能时才弹登录框。所以：
 *   · 接口回 401（api.js 的 post）→ requireLogin() 弹框 → 登录成功后自动重发原请求，
 *     点「想看」→ 登录 → 直接标好，不用再点一次
 *   · 页面上的「登录」按钮、侧栏左下角 → 直接 requireLogin()
 * 登录 / 登出之后 invalidateAll()：所有 loader 按新身份重跑，个人数据当场换掉 / 清空。
 */
import { invalidateAll } from '$app/navigation';

let open = $state(false);
let mode = $state(/** @type {'login'|'register'} */ ('login'));
/** @type {((ok: boolean) => void)[]} */
let waiters = [];

export const authDialog = {
  get open() { return open; },
  get mode() { return mode; },
  set mode(v) { mode = v; }
};

/** 弹登录框；登录 / 注册成功 resolve(true)，关掉 resolve(false)。同时多处等待的一起放行 */
export function requireLogin(m = 'login') {
  // 桌面客户端：内置账号的密码是随机的，弹登录框用户也登不进去（2026-10-22 审查）。
  // 会话失效时让主进程重新建会话并刷新页面（preload 的 window.mora.relogin）
  if (typeof window !== 'undefined' && window.mora?.relogin) return window.mora.relogin().then(Boolean).catch(() => false);
  mode = m; open = true;
  return new Promise((resolve) => waiters.push(resolve));
}

/**
 * 离线缓存（src/service-worker.js）里存着整页 HTML，里面有当时那个身份的个人数据。
 * 换身份（登录 / 登出）时清掉，同一台设备换人用、断网时也看不到上一个人的番单（#53）
 */
async function clearPageCache() {
  try { for (const k of await caches.keys()) if (k.startsWith('pages-')) await caches.delete(k); }
  catch { /* 没有 Cache API（http 入口）就没有离线缓存，不用清 */ }
}

/** 弹窗内部调：结束这一轮 */
export async function finishLogin(ok) {
  open = false;
  const w = waiters; waiters = [];
  if (ok) { await clearPageCache(); await invalidateAll(); }
  for (const r of w) r(ok);
}

export async function logout() {
  await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'logout' }) }).catch(() => {});
  await clearPageCache();
  await invalidateAll();
}
