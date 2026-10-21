import { json } from '@sveltejs/kit';
import { getAnime } from '$lib/server/queries.js';
import { saveShot, grabShot, grabPng } from '$lib/server/screenshot.js';
import { dispTitle } from '$lib/format.js';

/**
 * POST /api/screenshot?id=<番剧>&ep=<集>&t=<秒>
 *   body = image/png             浏览器截好的画面
 *   body = {"token": "<mp4 令牌>"} 浏览器截不了（直连 mp4），服务端 ffmpeg 截
 * 管理员：存到设置页配的目录（见 lib/server/screenshot.js）。
 * 其他人（多账号，2026-10-19）：存到主人电脑上对他们没意义 —— ffmpeg 截到的 PNG 原样回给浏览器下载；
 * 浏览器自己截得到的那种前端直接下载，不会发到这里
 */
const MAX = 40 * 1024 * 1024;   // 4K PNG 也就十几 MB
export async function POST({ request, url, locals }) {
  const q = url.searchParams;
  const a = getAnime(+q.get('id'));
  if (!a) return json({ error: '找不到这部番' }, { status: 404 });
  const meta = { title: dispTitle(a), ep: +q.get('ep') || null, t: +q.get('t') || 0 };
  const admin = locals.user?.role === 'admin';
  try {
    if (!admin) {
      if ((request.headers.get('content-type') ?? '').startsWith('image/png')) return json({ error: '参数不对' }, { status: 400 });
      const b = await request.json();
      if (typeof b.token !== 'string' || !/^[\w-]{8,40}$/.test(b.token)) return json({ error: '参数不对' }, { status: 400 });
      return new Response(await grabPng({ ...meta, token: b.token }), { headers: { 'content-type': 'image/png' } });
    }
    if ((request.headers.get('content-type') ?? '').startsWith('image/png')) {
      if (+(request.headers.get('content-length') ?? 0) > MAX) return json({ error: '图片太大' }, { status: 413 });
      const png = Buffer.from(await request.arrayBuffer());
      if (png.length > MAX) return json({ error: '图片太大' }, { status: 413 });
      return json({ ok: true, file: await saveShot({ ...meta, png }) });
    }
    const b = await request.json();
    if (typeof b.token !== 'string' || !/^[\w-]{8,40}$/.test(b.token)) return json({ error: '参数不对' }, { status: 400 });
    return json({ ok: true, file: await grabShot({ ...meta, token: b.token }) });
  } catch (e) {
    return json({ error: String(e.message ?? e) }, { status: 400 });
  }
}
