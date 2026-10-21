import { error } from '@sveltejs/kit';
import { getAnime, manualLinks } from '$lib/server/queries.js';
import { airedCount } from '$lib/server/episodes.js';
import { coverHueFor } from '$lib/server/coverHue.js';
import { coverTint } from '$lib/coverTint.js';

export async function load({ params }) {
  const a = getAnime(+params.id);
  if (!a) throw error(404, '找不到这部番');
  // tint：按封面主色相换强调色的容器变量（$lib/coverTint.js；没有可用色相时 null）。服务端算好随 SSR 下发，首屏不闪
  return { a, manualLinks: manualLinks(a.id), aired: airedCount(a.id), tint: coverTint(await coverHueFor(a.id)) };
}
