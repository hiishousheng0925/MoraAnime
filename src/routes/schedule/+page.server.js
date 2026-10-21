import { schedule, currentSeason } from '$lib/server/queries.js';
import { getDb } from '$lib/server/db.js';

export function load({ url }) {
  // 默认「本季全部」：番单空的时候「我在追的」是空屏，新用户第一眼不该看到空屏
  const scope = url.searchParams.get('scope') === 'mine' ? 'mine' : 'all';
  const wdRaw = url.searchParams.get('wd');
  const now = new Date();
  const today = ((now.getDay() + 6) % 7) + 1;      // JS 周日=0 → 转成周一=1
  // 默认只看今天。wd=all 看全周
  const wd = wdRaw === 'all' ? null : (+wdRaw >= 1 && +wdRaw <= 7 ? +wdRaw : today);
  // 日历条上本周七天的日期（「10.21」）。服务端算一次，水合时不会因时区 / 跨零点和客户端对不上
  const dates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (i + 1 - today));
    return `${d.getMonth() + 1}.${d.getDate()}`;
  });
  const lastSync = getDb().prepare(
    `SELECT datetime(finished_at, 'localtime') AS finished_at, items FROM sync_log WHERE kind='bgm_calendar' ORDER BY id DESC LIMIT 1`
  ).get();
  return { ...schedule(scope), scope, wd, today, dates, season: currentSeason(), lastSync };
}
