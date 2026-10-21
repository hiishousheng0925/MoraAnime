import { json } from '@sveltejs/kit';
import { getSetting, setSetting } from '$lib/server/queries.js';
import { randomBytes } from 'node:crypto';

/** 只读分享：生成一个随机 token，凭链接能看我的番单（只读，不能改） */
export async function POST({ request }) {
  const { op } = await request.json();
  if (op === 'revoke') { setSetting('share_token', ''); return json({ ok: true, token: '' }); }
  let t = getSetting('share_token', '');
  if (op === 'rotate' || !t) { t = randomBytes(9).toString('base64url'); setSetting('share_token', t); }
  return json({ ok: true, token: t });
}
