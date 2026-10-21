/**
 * 各页 loader 的公共零件。
 *
 * 重构前：catalog / mine / seasons / ranking 四个 loader 各自手写一遍
 * searchParams 解析 —— `const num` 抄了 3 份、hide_nsfw 抄了 4 份、
 * 类型列表在 seasons 一个函数里抄了两遍。而且已经开始跑偏：
 * catalog 处理了 `gm=or` 这个旧参数，mine 没处理，同一个链接在两页行为不同。
 *
 * 这里只提供零件、不提供「一把梭的 parseFilters」——
 * 四个页面的默认值是刻意不同的（catalog 有 1950 年下限且强制要求年份，
 * mine 没有），硬统一会把这份意图藏起来。
 */
import { GENRE_NAMES } from '../genres.js';
import { PER_OPTS } from '../perOpts.js';

import { facets, yearWindow } from './queries.js';

/** 空字符串和缺失都当没填；"0" 也当没填（筛选里 0 无意义） */
export const num = (v) => (v ? +v : null);
/**
 * 搜索词：去掉首尾空白；一个字母 / 数字 / 汉字都没有（只有空格、%、标点）就当没搜（#108）——
 * 原来「   」「%」算作搜索词，搜索模式下默认筛选全部失效，又什么都匹配，显示 22,231 部（不搜时 11,003）
 */
export const pickQ = (s) => { const q = (s.get('q') ?? '').trim(); return /[\p{L}\p{N}]/u.test(q) ? q : null; };

// 定义在 queries/prefs.js（queries 自己也要用），这里转出，loader 照旧从 loaderUtil 拿
export { hideNsfw } from './queries/prefs.js';

/**
 * 多选类型。
 *   没给 type 参数        → 用 dflt（目录页是 TV/剧场版/OVA，排除碎片型的 ONA/SP）
 *   type=all             → 全部类型（显式要看碎片时用）
 *   type=TV&type=MOVIE   → 就这些
 * typesAreDefault 让 UI 知道当前是不是默认态（默认态下胶囊不显示为已激活）。
 */
export function pickTypes(s, dflt = null) {
  const raw = s.getAll('type');
  if (raw.includes('all')) return { types: null, typesAreDefault: false, typesAreAll: true };
  if (!raw.length) return { types: dflt, typesAreDefault: true, typesAreAll: !dflt };
  return { types: raw, typesAreDefault: false, typesAreAll: false };
}

const STATUSES = ['ONGOING', 'FINISHED', 'UPCOMING', 'UNKNOWN'];
/** 默认：除未上映以外都要。直接给出这三种，UI 上就是三个 chip 亮着 —— 不需要文字解释 */
const STATUS_DEFAULT = ['ONGOING', 'FINISHED', 'UNKNOWN'];

/**
 * 完结状态。多选。
 *   没给 status  → STATUS_DEFAULT（不含未上映）
 *   status=all   → 四种全含
 *   可多选：status=ONGOING&status=FINISHED
 */
export function pickStatus(s) {
  const raw = s.getAll('status').filter((x) => x !== '');
  if (raw.includes('all')) return { statuses: null, statusIsAll: false, statusIsDefault: false };
  const ok = raw.filter((x) => STATUSES.includes(x));
  if (!ok.length) return { statuses: STATUS_DEFAULT, statusIsAll: false, statusIsDefault: true };
  return { statuses: ok, statusIsAll: false, statusIsDefault: false };
}

/**
 * 三槽题材：g = 必须全部包含（AND）、any = 至少包含一个（OR）、ng = 排除。
 * 只认清单里的名字，挡掉 URL 里的乱写。
 */
export function pickGenres(s) {
  const pick = (k) => s.getAll(k).filter((g) => GENRE_NAMES.includes(g));
  let genres = pick('g');
  let genresAny = pick('any');
  // 兼容旧的 gm=or：把「必须全部包含」整组挪到「至少包含一个」
  if (s.get('gm') === 'or' && genres.length) { genresAny = [...genresAny, ...genres]; genres = []; }
  return { genres, genresAny, genresNot: pick('ng') };
}

/**
 * 每页条数。ps 只认清单里的值，别的（包括乱写和超大值）都当没给 ——
 * 否则 ?ps=100000 会把一整个库塞进一页。
 */
export function pickPer(s, dflt) {
  const n = +(s.get('ps') ?? 0);
  return PER_OPTS.includes(n) ? { per: n, perIsDefault: false } : { per: dflt, perIsDefault: true };
}

/**
 * 年份筛选器的可选项 —— 只给设置页配置的显示窗口内的年份。
 * 原来写死「1950 到明年」，于是筛选栏里能选到窗口外的年份、选了却是 0 部。
 */
export const yearFacets = () => {
  const { min, max } = yearWindow();
  return facets().years.filter((y) => y.year >= min && y.year <= max);
};
