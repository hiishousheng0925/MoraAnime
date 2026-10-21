/**
 * 季度浏览专用的查询（2026-10 UI 大改：季度 hero 的切换条）。
 *
 * 和 seasonGrid 用同一套条件（日本番、非折叠、类型、收录站数门槛、NSFW），
 * 这样切换条上写的「春 122」点进去就正好是 122 部 —— 数字和点进去看到的对不上，比不写还糟。
 */
import { getDb } from '../db.js';

const ORDER = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

/** 第 i 季（从某个起点算）→ { year, season }；跨年进位 */
export function shiftSeason(year, season, n) {
  const idx = year * 4 + ORDER.indexOf(season) + n;
  return { year: Math.floor(idx / 4), season: ORDER[((idx % 4) + 4) % 4] };
}

/**
 * 若干年里每一季各有几部。返回 { 'YYYY-SEASON': count }，没有的键 = 0 部。
 * 一条 GROUP BY 查完，不按季逐个查。
 */
export function seasonCounts(yearFrom, yearTo, { types = ['TV'], minSources = 4, hideNsfw = false } = {}) {
  const ph = types.map(() => '?').join(',');
  const rows = getDb().prepare(`
    SELECT year, season, count(*) c FROM anime
    WHERE is_stub = 0 AND is_jp = 1 AND season IS NOT NULL AND year BETWEEN ? AND ?
      AND type IN (${ph}) AND source_count >= ?
      ${hideNsfw ? 'AND is_nsfw = 0' : ''}
    GROUP BY year, season`).all(yearFrom, yearTo, ...types, minSources);
  return Object.fromEntries(rows.map((r) => [`${r.year}-${r.season}`, r.c]));
}
