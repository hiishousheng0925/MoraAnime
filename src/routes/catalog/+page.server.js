import { listAnime, listFilters, facets } from '$lib/server/queries.js';
import { applyCatalogDefault, getCatalogDefault } from '$lib/server/catalogDefault.js';
import { num, pickQ, hideNsfw, pickTypes, pickStatus, pickGenres, yearFacets, pickPer } from '$lib/server/loaderUtil.js';
import { yearWindow } from '$lib/server/queries.js';
import { normStudio } from '$lib/server/text.js';
import { DEFAULT_SORT, DEFAULT_TYPES, pickSort2 } from '$lib/constants.js';
import { pickWatches } from '$lib/urlBuild.js';

export function load({ url, locals }) {
  const pd = applyCatalogDefault(url);   // 命中「我的默认」时会直接重定向
  const s = url.searchParams;
  const fromRaw = num(s.get('from'));
  // 年份下限跟着设置页的显示窗口走，不再写死 1950
  const win = yearWindow();
  const st = pickStatus(s);
  // qf=1：把筛选条件叠到搜索结果上。默认关 —— 搜索时忽略全部筛选
  const applyFilters = s.get('qf') === '1';
  const f = {
    hideNsfw: hideNsfw(),
    q: pickQ(s),
    applyFilters,
    // 默认 TV/剧场版/OVA，排除碎片型的 ONA/SP —— 理由见 constants.js: DEFAULT_TYPES。
    // ⚠️ 这个默认曾被取消过，当时的理由是「默认排序是人气，冷门 SP 会自动沉底」。
    // 排序已改成「最新」，那个机制不再生效，所以默认又必须收窄。
    ...pickTypes(s, DEFAULT_TYPES),
    ...pickGenres(s),
    yearMin: fromRaw ?? win.min,
    yearMax: num(s.get('to')),
    yearIsDefault: fromRaw === null,
    requireYear: true,               // 1505 条无年份的条目一律不显示
    season: s.get('season') || null,
    ...st,          // statuses 多选；默认给出「除未上映以外」三种
    weekday: num(s.get('wd')),
    isShort: s.get('short') === '1' ? 1 : s.get('short') === '0' ? 0 : null,
    jpOnly: s.get('jp') !== '0',
    epMax: num(s.get('epmax')),
    scoreMin: num(s.get('smin')),
    myScore: ['none', 'has'].includes(s.get('ms')) ? s.get('ms') : null,
    votesMin: num(s.get('vmin')),
    // 「我的」多选（watch=none&watch=plan，旧的单值链接照样认）；访客没有番单，不筛
    watches: locals.user ? pickWatches(s.getAll('watch')) : null,
    // 过一遍 normStudio：#109 改了归一规则，旧链接里的 studio=8-bit 也要认得
    studio: s.get('studio') ? normStudio(s.get('studio')) : null,
    // 搜索时可以越过显示窗口（yw=0）：窗口设成 1995 起时，龙猫、AKIRA、高达 0079 原来完全搜不到
    skipYearWindow: !!pickQ(s) && s.get('yw') === '0'
  };
  let page = Math.max(1, num(s.get('p')) || 1);
  // 搜索与否都默认「最新」（年份+季度，新 → 旧）。
  // 原来搜索时留空走 FTS 相关度排序 —— 主人要的是搜出来也按年份新→旧。
  const sort = s.get('sort') || DEFAULT_SORT;
  const sort2 = pickSort2(s.get('s2'));
  // 默认 24 = 一排 8 张 × 3 排（和番单一致）；可选 30/50/100
  const { per, perIsDefault } = pickPer(s, 24);
  let { rows, total } = listAnime(f, { limit: per, offset: (page - 1) * per, sort, sort2 });
  /**
   * 页码要和末页夹一次 —— 只做 Math.max(1, p) 会让超出末页的请求返回空列表。
   * 实测：在「未评分」的最后一页把剩下的番都打了分，回到列表时这一页已经空了，
   * 界面显示「此分类暂无内容 / 去快速标记」，像是番单被清空了。
   * 越界时才多查一次（正常翻页不会走这条路）。/seasons 早就这么处理。
   */
  const pages = Math.max(1, Math.ceil(total / per));
  if (page > pages) {
    page = pages;
    ({ rows, total } = listAnime(f, { limit: per, offset: (page - 1) * per, sort, sort2 }));
  }


  // 空结果时看看「放宽状态」能不能救 —— 2027 年的作品全是未上映，
  // 而默认状态不含未上映，于是选了 2027 必然是 0 部，空屏上却看不出原因
  let relaxStatus = 0;
  if (!total && f.statuses)
    relaxStatus = listAnime({ ...f, statuses: null }, { limit: 1, sort, sort2 }).total;
  // 搜索词在窗口下限之前还能命中几部 —— 有才显示那个开关
  const beforeWindow = f.q
    ? listAnime({ ...f, skipYearWindow: false, beforeWindow: true }, { limit: 1, sort, sort2 }).total : 0;
  // 只发 UI 真正用到的：年份（≥下限）+ 制作公司。
  // raw tags 已被中文题材 chip 取代，不必再发 120 条给客户端。
  return {
    rows, total, page, per, perIsDefault, f, sort, sort2, yearFloor: win.min, relaxStatus, beforeWindow,
    // 有搜索词且开关没开 → 筛选栏置灰且不生效
    filtersMuted: !!f.q && !applyFilters,
    pageDefault: getCatalogDefault(),
    defaultActive: !!pd?.active,
    query: s.toString(),
    savedFilters: listFilters(),
    facets: { years: yearFacets(), studios: facets().studios }
  };
}
