import { triageQueue, triageStats, triageYears } from '$lib/server/queries.js';

export function load({ url }) {
  const year = url.searchParams.get('year') ? +url.searchParams.get('year') : null;
  return {
    queue: triageQueue({ limit: 24, yearMin: year, yearMax: year }),
    // stats.notSeen 按同一个年份范围算 —— 重置按钮显示的数字要和实际放回的一致
    stats: triageStats({ yearMin: year, yearMax: year }),
    years: triageYears(),
    year
  };
}
