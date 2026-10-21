import { json } from '@sveltejs/kit';
import { listDirs, quickPlaces } from '$lib/server/dirBrowse.js';

/** 设置页截图位置的文件夹浏览（hooks.server.js 已挡掉非管理员：/api/admin/ 在 ADMIN_WRITE 里） */
export async function POST({ request }) {
  const b = await request.json().catch(() => ({}));
  return json({ ...listDirs(typeof b.path === 'string' ? b.path : ''), quick: quickPlaces() });
}
