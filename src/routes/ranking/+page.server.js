import { listAnime, yearCounts } from '$lib/server/queries.js';
import { num, hideNsfw, pickPer } from '$lib/server/loaderUtil.js';
import { ALL_TYPES, yearCeil } from '$lib/constants.js';

// 榜单只到前 300 名。每页默认 30（三列 × 每列 10），可选 30/50/100
const MAX_RANK = 300;
// 去重前多取一些：实测前 300 名里 41% 是重复的 Bangumi 条目
const FETCH = 1200;

/**
 * 同一个 Bangumi 条目只留一张卡。
 * AOD 把一部作品拆成本篇 + 番外 + 总集篇，它们匹到同一个 bgm_id、共用同一个榜位，
 * 于是榜单上 CLANNAD AS 和它的番外并列第 2/3、钢炼 FA 连占三名。
 * 名次按组里第一次出现的位置；代表取收录站数最多的那条（本篇通常被收录得最全）。
 */
function dedupByBangumi(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = r.bgm_id ?? `#${r.id}`;
    const g = groups.get(k);
    if (!g) groups.set(k, r);
    else if ((r.source_count ?? 0) > (g.source_count ?? 0)) groups.set(k, r);
  }
  return [...groups.values()];
}

export function load({ url }) {
  const s = url.searchParams;
  // ⚠️ 只认真实类型值。曾经用 URLSearchParams({type: null}) 生成出字面量
  // "null" 塞进 URL，导致按「null」这个类型去筛、结果永远为空。
  const type = ALL_TYPES.includes(s.get('type')) ? s.get('type') : null;
  const decade = num(s.get('decade'));
  const year = num(s.get('year'));
  const season = s.get('season') || null;
  const { per: PER_PAGE, perIsDefault } = pickPer(s, 30);

  const f = {
    types: type ? [type] : null,
    jpOnly: true, rankedOnly: true,
    hideNsfw: hideNsfw(),
    season
  };
  if (year) { f.yearMin = year; f.yearMax = year; }
  else if (decade) { f.yearMin = decade; f.yearMax = decade + 9; }

  const fetched = listAnime(f, { limit: FETCH, sort: 'score' });
  const rows = dedupByBangumi(fetched.rows);
  // 没取满时 rows 就是全部；取满了说明去重后远超 300，封顶即可
  const total = fetched.rows.length < FETCH ? rows.length : Math.max(rows.length, MAX_RANK);
  const capped = Math.min(total, MAX_RANK);
  // 按筛选后的实际条数夹页码 —— 夹到 300/每页 时，筛完只剩 2 页还能停在第 5 页（空页、页头「5/2」）
  const pages = Math.max(1, Math.ceil(capped / PER_PAGE));
  const page = Math.max(1, Math.min(pages, num(s.get('p')) || 1));
  const start = (page - 1) * PER_PAGE;
  return {
    rows: rows.slice(start, start + PER_PAGE),
    startRank: start + 1,
    page, per: PER_PAGE, perIsDefault,
    pages,
    total: capped, allTotal: total,
    type, decade, year, season,
    /**
     * 年份胶囊：只数这张榜上会出现的（进榜 + 当前类型 / 季度 + 按 Bangumi 条目去重），
     * 并且只到明年 —— 原来用全库计数，2027 写 128 部点进去只有 1 部，还列出 2028 / 2029（主人 2026-10-21）
     */
    years: yearCounts({ ...f, yearMin: null, yearMax: null }, { byBangumi: true }).filter((y) => y.year <= yearCeil())
  };
}
