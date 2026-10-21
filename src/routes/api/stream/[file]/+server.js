import { error } from '@sveltejs/kit';
import { streamFile, streamMp4 } from '$lib/server/sources/stream.js';

/** GET /api/stream/<令牌>.m3u8 | .key | .mp4 —— 片源代理，见 sources/stream.js（.mp4 只在开超分时用） */
export async function GET({ params, request }) {
  const m = /^([\w-]{8,40})\.(m3u8|key|mp4)$/.exec(params.file);
  if (!m) throw error(404, 'not found');
  if (m[2] === 'mp4') {
    let res;
    try { res = await streamMp4(m[1], request.headers.get('range')); } catch (e) { throw error(502, String(e.message ?? e)); }
    if (!res) throw error(410, '链接已过期，请重新打开这一集');
    return res;
  }
  let r;
  try { r = await streamFile(m[1]); } catch (e) { throw error(502, String(e.message ?? e)); }
  if (!r) throw error(410, '链接已过期，请重新打开这一集');
  return new Response(r.body, { headers: { 'Content-Type': r.type, 'Cache-Control': 'no-store' } });
}
