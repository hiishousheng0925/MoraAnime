/**
 * 目录页的「我的默认」：无参数进入时套用「我的筛选」里被标为默认的那一套，
 * 做法是服务端重定向。
 *
 * 为什么用重定向而不是静默套用：
 *   ① 地址栏和实际筛选一致，可以直接复制分享
 *   ② 「重置」按钮指向的就是无参数 URL，会再次落到默认上 ——
 *      正好是「重置 = 回到我的默认」这个语义，不用额外写逻辑
 *   ③ 现有的筛选解析、已选 chip 全都不用改
 *
 * 想看出厂状态用 ?raw=1（界面上是「系统默认」）。
 *
 * 只有目录页有这个机制。季度浏览曾经也有一份，已删 —— 它的天然默认
 * 「当前年+当前季」会自己跟着时间走，存快照反而把年份冻住
 * （在 2026夏 设了默认，2027 年点进去还是 2026夏）。
 */
import { redirect } from '@sveltejs/kit';
import { getDefaultFilter } from './queries.js';

export const getCatalogDefault = () => getDefaultFilter()?.filter_json ?? '';

/** 在 loader 最开头调用。命中默认时直接抛重定向。 */
export function applyCatalogDefault(url) {
  const saved = getCatalogDefault();
  if (!saved) return { active: false };
  if ([...url.searchParams.keys()].length)
    return { active: url.searchParams.get('raw') !== '1' };
  redirect(302, `${url.pathname}?${saved}`);
}
