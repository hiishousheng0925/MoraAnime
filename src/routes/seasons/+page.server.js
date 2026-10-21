import { seasonGrid, seasonYears, currentSeason, yearWindow, seasonCounts, shiftSeason } from '$lib/server/queries.js';
import { num, hideNsfw, pickTypes, pickPer } from '$lib/server/loaderUtil.js';
import { yearCeil, ALL_TYPES, SEASON_SORT_OPTS, SEASON_DEFAULT_SORT } from '$lib/constants.js';
import { pickWatches } from '$lib/urlBuild.js';

export function load({ url, locals }) {
  const s = url.searchParams;
  const years = seasonYears().filter((y) => y.year <= yearCeil());
  const cur = currentSeason();
  /**
   * 年份要夹进显示窗口 —— 否则 URL 里带着窗口外的年份（比如收窄到 2000-2010 之后
   * 还停在 ?year=2026）时，页面会一直是空的，而年份胶囊里根本没有 2026 可点回来。
   */
  const win = yearWindow();
  const asked = num(s.get('year')) ?? cur.year;
  const year = Math.max(win.min, Math.min(win.max, asked));
  const { typesAreDefault } = pickTypes(s);
  const types = typesAreDefault ? ALL_TYPES : s.getAll('type');
  const min = num(s.get('min')) ?? 4;
  // 默认当前季。想看四季网格要显式选「全部」（season=all）——
  // 缺省若等于「全部」，就没法把「当前季」做成默认了
  // 只认清单里的键，挡掉 URL 里的乱写（?season=foo / 小写 winter 曾直接 500）
  const ORDER = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
  const seasonRaw = s.get('season');
  const season = seasonRaw === 'all' ? null : (ORDER.includes(seasonRaw) ? seasonRaw : cur.season);
  const sort = SEASON_SORT_OPTS.some(([v]) => v === s.get('sort')) ? s.get('sort') : SEASON_DEFAULT_SORT;
  /**
   * 分页只作用在【单季】视图（也就是默认态）。
   * season=all 是「一年四季总览」，要的就是四个块并排看 —— 一分页就只剩冬季那块，
   * 总览的意义没了。所以那个模式下不分页、也不显示分页栏。
   * 单季每页默认 24 = 一排 8 张 × 3 排，和目录/番单一致。
   */
  const nsfw = hideNsfw();
  // 「我的」多选：和目录页同一套参数与 SQL 条件；访客没有番单，不筛
  const watches = locals.user ? pickWatches(s.getAll('watch')) : null;
  const full = seasonGrid(year, { types, minSources: min, sort, hideNsfw: nsfw, watches });
  const shown = season ? [season] : ORDER;
  const counts = Object.fromEntries(ORDER.map((k) => [k, full[k].length]));
  const total = shown.reduce((n, k) => n + full[k].length, 0);

  const paged = !!season;
  const { per, perIsDefault } = pickPer(s, 24);
  const pages = paged ? Math.max(1, Math.ceil(total / per)) : 1;
  const page = Math.min(Math.max(1, num(s.get('p')) || 1), pages);

  /**
   * 单季：正常分页。
   * 四季总览（season=all）：不分页，但每块只出一屏 —— 不封顶的话一页会渲染上千张卡，
   * 实测把 SSR 进程的内存吃爆、连接被重置（测试服务器直接挂了）。
   * 想看某一季的全部就点那块标题旁的链接进单季视图。
   */
  const grid = Object.fromEntries(ORDER.map((k) => [k, paged ? [] : full[k].slice(0, per)]));
  if (paged) grid[season] = full[season].slice((page - 1) * per, page * per);

  /**
   * hero 的季度切换条。单季：前 3 季 + 本季 + 后 1 季（往回翻的多）；四季总览：这一年的四季。
   * 每格的部数是真查的、和点进去的条件一致；超出显示窗口的季不出现。
   * 箭头 = 单季时前 / 后一季，四季总览时前 / 后一年。
   */
  const inWin = (x) => x.year >= win.min && x.year <= win.max;
  const strip = (season
    ? [-3, -2, -1, 0, 1].map((n) => shiftSeason(year, season, n))
    : ORDER.map((k) => ({ year, season: k }))).filter(inWin);
  const step = season
    ? [shiftSeason(year, season, -1), shiftSeason(year, season, 1)]
    : [{ year: year - 1, season: null }, { year: year + 1, season: null }];
  const cnt = seasonCounts(Math.min(...strip.map((x) => x.year)), Math.max(...strip.map((x) => x.year)),
                           { types, minSources: min, hideNsfw: nsfw, watches });
  const hero = {
    strip: strip.map((x) => ({ ...x, c: cnt[`${x.year}-${x.season}`] ?? 0 })),
    prev: inWin(step[0]) ? step[0] : null,
    next: inWin(step[1]) ? step[1] : null,
    // 封面：本季（总览时全年）Bangumi 分最高的 3 部；票数 ≥100 才算数（和封面角标同一口径），
    // 不够 3 部时按当前排序补。第一张做 hero 的氛围背景。
    covers: pickCovers(shown.flatMap((k) => full[k]))
  };

  return {
    hero,
    year, years, cur, min, season, types, typesAreDefault, sort, watches,
    seasonIsAll: seasonRaw === 'all',
    grid, counts, total, page, pages, per: paged ? per : null, perIsDefault
  };
}

/** hero 扇形封面：有封面的、Bangumi 分高的在前（同 showScore 的 ≥100 票门槛） */
function pickCovers(rows) {
  const ok = rows.filter((a) => !a.cover_dead && (a.picture || a.thumbnail));
  const rated = ok.filter((a) => a.bgm_votes >= 100 && a.bgm_score)
    .sort((x, y) => y.bgm_score - x.bgm_score);
  const out = [...rated.slice(0, 3)];
  for (const a of ok) { if (out.length >= 3) break; if (!out.includes(a)) out.push(a); }
  return out.map((a) => ({ id: a.id, title: a.title, title_cn: a.title_cn, title_ja: a.title_ja }));
}
