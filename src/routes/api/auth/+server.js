import { json } from '@sveltejs/kit';
import { COOKIE, cookieOpts, clientIp, login, register, createSession, endSession, endAllSessions,
         throttled, noteFail, noteOk, updateAccount, changePassword } from '$lib/server/auth.js';

/**
 * 登录 / 注册 / 登出 / 账号设置。都是弹窗里调的（主人要求不做单独的登录页）。
 *   login     { ident, password }          ident = 用户名或邮箱
 *   register  { username, email, password }
 *   logout                                  只下线这台设备
 *   logout-others                           其他设备全部下线（改过密码时也会顺带做）
 *   profile   { username?, email? }         改用户名 / 邮箱
 *   password  { old, password }
 */
export async function POST(event) {
  const { request, cookies, locals } = event;
  const b = await request.json().catch(() => ({}));
  const ip = clientIp(event);
  const signIn = (user) => {
    cookies.set(COOKIE, createSession(user.id, request.headers.get('user-agent') ?? ''), cookieOpts(event));
    return json({ ok: true, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
  };

  switch (b.op) {
    case 'login': {
      const ident = String(b.ident ?? '').trim();
      if (!ident || !b.password) return json({ error: '请输入账号和密码' }, { status: 400 });
      if (throttled(ip, ident)) return json({ error: '尝试次数过多，请 10 分钟后再试' }, { status: 429 });
      const user = login(ident, String(b.password));
      if (!user) { noteFail(ip, ident); return json({ error: '账号或密码不对' }, { status: 401 }); }
      noteOk(ip, ident);
      return signIn(user);
    }
    case 'register': {
      if (throttled(ip)) return json({ error: '尝试次数过多，请 10 分钟后再试' }, { status: 429 });
      const r = register(b);
      if (r.error) { noteFail(ip); return json({ error: r.error }, { status: 400 }); }
      return signIn(r.user);
    }
    case 'logout': {
      endSession(cookies.get(COOKIE));
      cookies.delete(COOKIE, { path: '/' });
      return json({ ok: true });
    }
  }

  // 以下要登录
  const me = locals.user;
  if (!me) return json({ error: '请先登录' }, { status: 401 });
  switch (b.op) {
    case 'logout-others':
      return json({ ok: true, ended: endAllSessions(me.id, cookies.get(COOKIE)) });
    case 'profile': {
      const err = updateAccount(me.id, { username: b.username, email: b.email });
      return err ? json({ error: err }, { status: 400 }) : json({ ok: true });
    }
    case 'password': {
      if (throttled(ip, me.username)) return json({ error: '尝试次数过多，请 10 分钟后再试' }, { status: 429 });
      const err = changePassword(me.id, b.old, b.password);
      if (err) { if (err === '原密码不对') noteFail(ip, me.username); return json({ error: err }, { status: 400 }); }
      // 改了密码，别处登录着的一律下线（可能就是因为密码泄露才改的）
      const ended = endAllSessions(me.id, cookies.get(COOKIE));
      return json({ ok: true, ended });
    }
  }
  return json({ error: 'unknown op' }, { status: 400 });
}
