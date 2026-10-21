import { watching, triageStats, myStats, recommend, recentlySeen } from '$lib/server/queries.js';
import { getDb } from '$lib/server/db.js';
import { todayUpdates, airedForMine } from '$lib/server/episodes.js';

export function load({ locals }) {
  const stats = myStats();
  /**
   * 「未看 N 集」按【已播出】的集数算（#47）：原来拿总集数减进度，在播的番把还没播的也算成没看
   * （第 3 集刚播完就显示「未看 9 集」）。没有分集数据的番照旧用总集数。
   */
  const aired = locals.user ? airedForMine() : new Map();
  // 总集数也按同一口径（#104：AOD 记 6 集、实际播了 12 集，原来显示「已看 0/6 · 未看 12 集」）
  // next：下一集哪天播（追平时 hero 写「已追到第 N 集 · 10/28 周三更新」，$lib/nextEp.js）
  const mine = watching().map((a) => {
    const s = aired.get(a.id);
    return s?.aired ? { ...a, episodes: s.total ?? a.episodes, aired: s.aired, behind: s.aired - (a.current_episode ?? 0),
                        next: s.next } : a;
  })
    // SQL 按「总集数 − 进度」排，换成已播口径后要重排：否则追平了的连载（总 12 看 3）排在真有 5 集没看的前面
    .sort((x, y) => (y.behind ?? -Infinity) - (x.behind ?? -Infinity));
  const libraryTotal = getDb().prepare('SELECT count(*) c FROM anime WHERE is_stub=0').get().c;
  return {
    libraryTotal,
    watching: mine,
    // 今天更新（#47）：在看 / 想看的番里今天（东京时间）播出新一集的
    today: locals.user ? todayUpdates() : [],
    // 16 = 一排 8 张 × 2 排（原来是 12，第二排会缺两个）；多取 1 条：第一部上首屏 hero 时网格从第二部起
    recommend: recommend(17),      // 保证任何状态下都不为空
    recentlySeen: recentlySeen(16),
    stats,
    triage: triageStats()
  };
}
