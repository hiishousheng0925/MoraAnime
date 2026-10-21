import { error } from '@sveltejs/kit';
import { getAnime, getWatchPick, listWatchSites } from '$lib/server/queries.js';
import { episodeList, airedCount } from '$lib/server/episodes.js';
import { coverHueFor } from '$lib/server/coverHue.js';
import { coverTint } from '$lib/coverTint.js';

/**
 * http 访问时，给超分菜单一个「切到 https 地址」的链接（超分要 WebGPU，WebGPU 只在 https 下有）。
 * https 地址来自 ~/.j-anime.env 的 TRUSTED_ORIGINS（run-app 会读进环境变量）：测试站取带 :8443 的那个，正式站取不带端口的
 */
function httpsUrlFor(url) {
  if (url.protocol === 'https:') return null;
  const list = (process.env.TRUSTED_ORIGINS ?? '').split(',').map((x) => x.trim()).filter((x) => x.startsWith('https://'));
  const staging = process.env.J_ANIME_STAGING === '1';
  const o = list.find((x) => (staging ? /:\d+$/.test(x) : !/:\d+$/.test(x)));
  return o ? o + url.pathname : null;
}

export async function load({ params, url }) {
  const a = getAnime(+params.id);
  if (!a) throw error(404, '找不到这部番');
  return { a, pick: getWatchPick(a.id), watchSites: listWatchSites(true), httpsUrl: httpsUrlFor(url),
           // 选集里每集的中文标题 + 播出日期（#49；主人 2026-10-19 定：放观看页，不放详情页）
           episodes: episodeList(a.id),
           // 已播集数（和详情页进度条同一口径）：追平时起始集停在最新一集，不跳到还没播的下一集（#7）
           aired: airedCount(a.id),
           // 封面主色相 → 强调色跟着封面走（同详情页）
           tint: coverTint(await coverHueFor(a.id)) };
}
