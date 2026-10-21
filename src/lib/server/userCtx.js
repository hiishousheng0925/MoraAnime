/**
 * 「当前是哪个账号」—— 多账号（2026-10-19）的单一来源。
 *
 * hooks.server.js 按会话 cookie 认出账号，用 withUser 把整个请求包起来；
 * 之后任何地方（loader、API、queries/*）都能拿到当前账号，不用一层层传参数。
 * 数据库里注册了 SQL 函数 uid()（见 db.js）—— 个人数据的视图就是按它过滤的
 * （见 multiUser.js），所以查询代码本身不需要知道「多账号」这回事。
 *
 * 不在请求里的调用（同步脚本、测试进程）：缺省 uid = 0 = 访客，看不到任何人的数据。
 * 测试进程要模拟某个账号就设 J_ANIME_AS_USER（只在 scripts/test.js 起的进程里用）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();
const fallbackUid = Number(process.env.J_ANIME_AS_USER) || 0;

/** ctx = { user: { id, username, email, role } | null, prefs: 访客偏好（cookie） } */
export const withUser = (ctx, fn) => als.run(ctx, fn);
/** 临时以某个账号的身份跑一段同步查询（只读分享页用：看的是分享人的番单） */
export const asUser = (id, fn) => als.run({ user: { id }, prefs: {} }, fn);

export const currentCtx = () => als.getStore() ?? null;
export const currentUser = () => als.getStore()?.user ?? null;
export const currentUid = () => als.getStore() ? (als.getStore().user?.id ?? 0) : fallbackUid;
export const isAdmin = () => currentUser()?.role === 'admin';
