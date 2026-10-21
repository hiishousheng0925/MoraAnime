import { json } from '@sveltejs/kit';
import { addAllow, removeAllow, listAllow } from '$lib/server/auth.js';

/** 注册白名单：只有名单里的邮箱能注册（hooks.server.js 已挡掉非管理员） */
export async function POST({ request }) {
  const b = await request.json().catch(() => ({}));
  if (b.op === 'add') { const err = addAllow(b.email); if (err) return json({ error: err }, { status: 400 }); }
  else if (b.op === 'remove') removeAllow(b.email);
  else return json({ error: 'unknown op' }, { status: 400 });
  return json({ ok: true, list: listAllow() });
}
