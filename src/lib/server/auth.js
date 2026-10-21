/**
 * 多账号鉴权（2026-10-19，取代原来的「一个环境变量密码 + 无状态签名 cookie」）。
 *
 * 设计：
 *   · 不登录也能逛（目录 / 排行 / 放送表 / 详情 / 站内播放），只有和自己有关的（番单、评分、
 *     统计、快速标记…）才要登录 —— 闸门在接口上（hooks.server.js），不在页面上
 *   · 账号 = 用户名 + 邮箱 + 密码；用户名或邮箱都能登录
 *   · 注册要邮箱在白名单里（设置页由管理员维护）；库里还没有任何账号时，第一个注册的就是管理员
 *   · 会话存服务端（session 表，cookie 里只放随机令牌，库里只存它的 sha256）：
 *     登出能真正作废、能「让所有设备下线」；90 天滑动续期，常用就不会突然被踢
 */
import { createHash, randomBytes } from 'node:crypto';
import { getDb } from './db.js';
import { hashPassword, verifyPassword } from './password.js';

/**
 * 测试站换一个名字（#89）：cookie 只认域名不认端口，正式站（:443）和测试站（:8443）同域，
 * 同名时测试站收到正式站的令牌、在自己库里查不到就删掉 —— 打开一次 TEST 标签正式站就被登出
 */
export const COOKIE = process.env.J_ANIME_STAGING === '1' ? 'j_anime_sid_test' : 'j_anime_sid';
export const MAX_AGE = 90 * 24 * 3600;
/** 剩余有效期少于这个就续满（= 距上次续期超过 10 天）：不必每个请求都写库、都回 Set-Cookie */
const RENEW_BELOW = 80 * 24 * 3600;

const sha = (t) => createHash('sha256').update(t).digest('hex');
const db = () => getDb();

// ── 请求来源 ────────────────────────────────────────────────
/**
 * tailscale serve（https 入口）从 127.0.0.1 转进来，真实来源在 X-Forwarded-For / -Proto 里。
 * 只信回环地址发来的这两个头 —— tailnet 直连（http）的请求谁都能伪造它们。
 * 原来一律按 getClientAddress() 限流：走 https 的所有人都是 127.0.0.1，共用一个失败名额。
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function viaServe(event) {
  try { return LOOPBACK.has(event.getClientAddress()); } catch { return false; }
}
export function clientIp(event) {
  if (viaServe(event)) return event.request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'serve';
  try { return event.getClientAddress(); } catch { return 'unknown'; }
}
/** 站点按 ORIGIN（http://IP:端口）推协议，经 serve 来的请求要看转发头才知道其实是 https */
export const isHttps = (event) => event.url.protocol === 'https:'
  || (viaServe(event) && event.request.headers.get('x-forwarded-proto') === 'https');

export function cookieOpts(event) {
  return { path: '/', httpOnly: true, sameSite: /** @type {'lax'} */ ('lax'), secure: isHttps(event), maxAge: MAX_AGE };
}

// ── 账号 ───────────────────────────────────────────────────
const PUBLIC_COLS = 'id, username, email, role, created_at';
export const accountById = (id) => db().prepare(`SELECT ${PUBLIC_COLS} FROM account WHERE id = ?`).get(id) ?? null;
export const accountCount = () => db().prepare('SELECT count(*) c FROM account').get().c;

/** 用户名或邮箱都行（含 @ 的按邮箱找），不分大小写 */
const findLogin = (ident) => db().prepare(
  `SELECT id, pw_hash, role FROM account WHERE ${String(ident).includes('@') ? 'email' : 'username'} = ?`
).get(String(ident).trim()) ?? null;

export const USERNAME_RE = /^[\p{L}\p{N}_.-]{2,24}$/u;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PW_MIN = 8;

/**
 * 注册和改资料共用同一套校验（2026-10-21 审核：updateAccount 原来自己抄了一份，漏了邮箱 120 字符上限）
 * @returns {string|null} 不合格的原因
 */
const checkUsername = (username) => (USERNAME_RE.test(username ?? '') ? null : '用户名 2–24 位，只能是文字、数字、_ . -');
const checkEmail = (email) => (EMAIL_RE.test(email ?? '') && email.length <= 120 ? null : '邮箱格式不对');

/** @returns {string|null} 不合格的原因 */
function checkFields({ username, email, password }) {
  const bad = checkUsername(username) ?? checkEmail(email);
  if (bad) return bad;
  if (String(password ?? '').length < PW_MIN) return `密码至少 ${PW_MIN} 位`;
  if (String(password).length > 200) return '密码太长';
  return null;
}

export const allowedToSignup = (email) =>
  accountCount() === 0 || !!db().prepare('SELECT 1 FROM signup_allow WHERE email = ?').get(String(email).trim());

/** @returns {{ user?: object, error?: string }} */
export function register({ username, email, password }) {
  username = String(username ?? '').trim(); email = String(email ?? '').trim().toLowerCase();
  const bad = checkFields({ username, email, password });
  if (bad) return { error: bad };
  const d = db();
  // 先查「已经有账号」：主人拿自己的邮箱去注册时该被引导去登录，而不是被白名单挡住（2026-10-19 实测）
  if (d.prepare('SELECT 1 FROM account WHERE email = ?').get(email)) return { error: '这个邮箱已经有账号了，直接登录即可' };
  if (!allowedToSignup(email)) return { error: '这个邮箱还不能注册，请联系管理员' };
  if (d.prepare('SELECT 1 FROM account WHERE username = ?').get(username)) return { error: '用户名已被使用' };
  const role = accountCount() === 0 ? 'admin' : 'user';
  const id = Number(d.prepare('INSERT INTO account (username, email, pw_hash, role) VALUES (?, ?, ?, ?)')
    .run(username, email, hashPassword(password), role).lastInsertRowid);
  return { user: accountById(id) };
}

/**
 * 用户名 / 邮箱 + 密码。
 * 迁移过来的管理员账号（id 1）在 run-app 没带上 J_ANIME_PASSWORD 时会是空密码 ——
 * 兜底：空密码的管理员认原来那个环境变量密码，认过一次就写进库。
 */
export function login(ident, password) {
  const a = findLogin(ident);
  if (a && !a.pw_hash && a.role === 'admin' && process.env.J_ANIME_PASSWORD
      && String(password) === process.env.J_ANIME_PASSWORD) {
    db().prepare('UPDATE account SET pw_hash = ? WHERE id = ?').run(hashPassword(password), a.id);
    return accountById(a.id);
  }
  const ok = verifyPassword(password, a?.pw_hash);   // 账号不存在也算一遍，不让耗时泄露「有没有这个人」
  return a && ok ? accountById(a.id) : null;
}

/** @returns {string|null} 出错原因 */
export function updateAccount(id, { username, email }) {
  const d = db();
  if (username !== undefined) {
    username = String(username).trim();
    const bad = checkUsername(username);
    if (bad) return bad;
    if (d.prepare('SELECT 1 FROM account WHERE username = ? AND id <> ?').get(username, id)) return '用户名已被使用';
    d.prepare('UPDATE account SET username = ? WHERE id = ?').run(username, id);
  }
  if (email !== undefined) {
    email = String(email).trim().toLowerCase();
    const bad = checkEmail(email);
    if (bad) return bad;
    if (d.prepare('SELECT 1 FROM account WHERE email = ? AND id <> ?').get(email, id)) return '这个邮箱已被其他账号使用';
    d.prepare('UPDATE account SET email = ?, email_verified_at = NULL WHERE id = ?').run(email, id);
  }
  return null;
}

/** 改密码要先验旧密码（没设过密码的账号除外） */
export function changePassword(id, oldPw, newPw) {
  const a = db().prepare('SELECT pw_hash FROM account WHERE id = ?').get(id);
  if (!a) return '账号不存在';
  if (a.pw_hash && !verifyPassword(oldPw, a.pw_hash)) return '原密码不对';
  if (String(newPw ?? '').length < PW_MIN) return `密码至少 ${PW_MIN} 位`;
  db().prepare('UPDATE account SET pw_hash = ? WHERE id = ?').run(hashPassword(newPw), id);
  return null;
}

// ── 会话 ───────────────────────────────────────────────────
export function createSession(userId, userAgent = '') {
  const token = randomBytes(32).toString('base64url');
  // 顺手清掉所有账号已过期的会话（2026-10-21 审核）：sessionUser 只删「拿着过期令牌来的」，
  // 换了设备 / 清了 cookie 的那些永远不会再来，原来会一直留在表里。
  // expires_at 是 datetime('now', ...) 写的 UTC 'YYYY-MM-DD HH:MM:SS' 文本，和 datetime('now') 直接按字符串比
  db().prepare("DELETE FROM session WHERE expires_at < datetime('now')").run();
  db().prepare(`INSERT INTO session (token_hash, user_id, expires_at, user_agent)
                VALUES (?, ?, datetime('now', '+${MAX_AGE} seconds'), ?)`)
    .run(sha(token), userId, String(userAgent).slice(0, 200));
  return token;
}

/**
 * 认 cookie。过期的顺手删掉。
 * @returns {{ user: object, renew: boolean } | null} renew = 刚续了期，调用方要重发 cookie
 */
export function sessionUser(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const d = db(), h = sha(token);
  const s = d.prepare(`SELECT user_id, (julianday(expires_at) - julianday('now')) * 86400 AS left FROM session WHERE token_hash = ?`).get(h);
  if (!s) return null;
  if (s.left <= 0) { d.prepare('DELETE FROM session WHERE token_hash = ?').run(h); return null; }
  const user = accountById(s.user_id);
  if (!user) return null;
  const renew = s.left < RENEW_BELOW;
  if (renew) d.prepare(`UPDATE session SET expires_at = datetime('now', '+${MAX_AGE} seconds'), last_seen_at = datetime('now')
                        WHERE token_hash = ?`).run(h);
  return { user, renew };
}

export const endSession = (token) => token && db().prepare('DELETE FROM session WHERE token_hash = ?').run(sha(token));
/** 让这个账号的所有设备下线（keepToken 那一个除外 —— 「下线其他设备」时留着自己） */
export function endAllSessions(userId, keepToken = null) {
  return db().prepare('DELETE FROM session WHERE user_id = ? AND token_hash <> ?').run(userId, keepToken ? sha(keepToken) : '').changes;
}
export const sessionCount = (userId) => db().prepare("SELECT count(*) c FROM session WHERE user_id = ? AND expires_at > datetime('now')").get(userId).c;

// ── 注册白名单（管理员维护）────────────────────────────────
export const listAllow = () => db().prepare(`SELECT email, datetime(created_at, 'localtime') created_at,
  EXISTS(SELECT 1 FROM account a WHERE a.email = s.email) AS registered FROM signup_allow s ORDER BY created_at DESC`).all();
export function addAllow(email) {
  email = String(email ?? '').trim().toLowerCase();
  const bad = checkEmail(email);   // 超长的邮箱反正注册不了，白名单里也不收
  if (bad) return bad;
  db().prepare('INSERT OR IGNORE INTO signup_allow (email) VALUES (?)').run(email);
  return null;
}
export const removeAllow = (email) => db().prepare('DELETE FROM signup_allow WHERE email = ?').run(String(email ?? '').trim());

// ── 登录限流 ───────────────────────────────────────────────
/**
 * 进程内 Map 足够（单机站）。两个维度一起管：
 *   · 按来源 IP：同一处连错 10 次锁 10 分钟（挡对很多账号的撒网）
 *   · 按账号：同一账号连错 5 次锁 10 分钟（挡对一个账号的定点爆破，换 IP 也没用）
 */
const tries = new Map();
const WINDOW = 10 * 60 * 1000;
const LIMIT = { ip: 10, acct: 5 };
const keyOf = (kind, v) => `${kind}:${String(v ?? '').trim().toLowerCase()}`;

export function throttled(ip, ident) {
  const hit = (k, n) => { const t = tries.get(k); return !!t && t.n >= n && Date.now() < t.until; };
  return hit(keyOf('ip', ip), LIMIT.ip) || (ident ? hit(keyOf('acct', ident), LIMIT.acct) : false);
}
export function noteFail(ip, ident) {
  const now = Date.now();
  for (const k of [keyOf('ip', ip), ...(ident ? [keyOf('acct', ident)] : [])]) {
    const t = tries.get(k);
    if (!t || now >= t.until) tries.set(k, { n: 1, until: now + WINDOW });
    else t.n++;
  }
}
export function noteOk(ip, ident) { tries.delete(keyOf('ip', ip)); if (ident) tries.delete(keyOf('acct', ident)); }

/**
 * 登录后跳回的地址，只放行站内路径。
 * 只看 startsWith('/') 不够：`//evil.com`、`/\evil.com`、中间夹制表符的 `/%09/evil.com`（解码后）
 * 浏览器都会当成协议相对地址跳出站外。按浏览器同一套规则解析后比 origin。
 */
export function safeNext(to) {
  const base = 'http://j-anime.invalid';
  try {
    const u = new URL(String(to || '/'), base);
    return u.origin === base ? u.pathname + u.search + u.hash : '/';
  } catch { return '/'; }
}
