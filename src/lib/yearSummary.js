/**
 * 年份胶囊（YearPill）上的摘要文字。抽成纯函数是为了能单测 ——
 * 原来写在组件里的三元表达式把 `year ?` 放在区间判断前面，
 * 于是 from=2015&to=2020 时胶囊只写「2015」，下面的已选标签却是「2015–2020」，区间分支永远走不到。
 *
 * 判断顺序：季度+年份 → 年份区间（上限 ≠ 下限）→ 单个年份 → 年代 → 只有季度。
 */
import { SEASON_CN } from './constants.js';

export function yearSummary({ year = null, yearMax = null, season = null, decade = null,
                              yearFloor = null, isDefault = false } = {}) {
  if (isDefault) return null;
  if (season && year) return `${year}${SEASON_CN[season]}`;
  if (yearMax && yearMax !== year) {
    const lo = year ?? yearFloor;
    return lo ? `${lo}–${yearMax}` : `≤${yearMax}`;
  }
  if (year) return String(year);
  if (decade) return `${decade}s`;
  if (season) return `${SEASON_CN[season]}季`;
  return null;
}
