import { stats, timeline } from '$lib/server/queries.js';
import { pickPer } from '$lib/server/loaderUtil.js';

// 题材聚合在 queries.js 里 —— 需要按番剧去重，不是把标签计数拿来取最大值
export function load({ url }) {
  const asked = Math.max(1, +(url.searchParams.get('tl') || 1) || 1);
  const { per, perIsDefault } = pickPer(url.searchParams, 10);   // 时间线默认 10 条
  // 先按 offset 0 拿总数，再把页码夹进范围 —— 否则 ?tl=99999 会显示「99999 / 13」和一片空白
  const total = timeline({ limit: 1 }).total;
  const pages = Math.max(1, Math.ceil(total / per));
  const tl = Math.min(asked, pages);
  const { days } = timeline({ limit: per, offset: (tl - 1) * per });
  return { ...stats(), days, tl, tlPages: pages, tlTotal: total, tlPer: per, tlPerIsDefault: perIsDefault };
}
