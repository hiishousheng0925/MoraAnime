/**
 * 库里的番：检索、详情、筛选器选项、季度、放送表、推荐。
 * 只读 anime 及其附属表；不碰个人记录（那在 user.js / triage.js）。
 */
import { getDb } from '../db.js';
import { yearWindow } from './prefs.js';
import { GENRE_MAP } from '../../genres.js';
import { dispStudio } from '../../format.js';
import { toFtsQuery } from '../text.js';
import { normTitle, ensureNorm } from '../normTitle.js';
import { SORTS, orderBy } from './sorts.js';

function buildWhere(f) {
  const w = ['a.is_stub = 0'];
  const p = [];
  if (f.q) { /* FTS 在外层 join 处理 */ }
  if (f.types?.length) { w.push(`a.type IN (${f.types.map(() => '?').join(',')})`); p.push(...f.types); }
  if (f.yearMin) { w.push('a.year >= ?'); p.push(f.yearMin); }
  if (f.yearMax) { w.push('a.year <= ?'); p.push(f.yearMax); }
  if (f.season) { w.push('a.season = ?'); p.push(f.season); }
  // 用 status_eff（由 scripts/fix-status.js 按季度推导），不用 AOD 的原始 status ——
  // 快照过期会让「未播出」筛出早已播完的番。coalesce 是为了没跑过修正脚本时能兜住。
  if (f.status) { w.push('coalesce(a.status_eff, a.status) = ?'); p.push(f.status); }
  if (f.statuses?.length) {
    w.push(`coalesce(a.status_eff, a.status) IN (${f.statuses.map(() => '?').join(',')})`);
    p.push(...f.statuses);
  }
  // 默认把未上映（950 条）排除在外 —— 否则「最新」排序的首屏全是 2027 年的公告番。
  // 只有目录页设这个默认；番单、季度浏览、放送表都不能套（见各自 loader 的说明）。
  if (f.excludeUpcoming) w.push("coalesce(a.status_eff, a.status) <> 'UPCOMING'");
  if (f.isShort === 1) w.push('a.is_short = 1');
  if (f.isShort === 0) w.push('a.is_short = 0');
  if (f.jpOnly) w.push('a.is_jp = 1');
  /**
   * 显示年份窗口（设置页配置）。和 URL 上的年份筛选是「交集」关系：
   * 窗口是硬边界，用户在筛选栏里选的年份只能在窗口内收窄。
   * 番单和统计不走这里的窗口（见 prefs.js: yearWindow 的说明），
   * 所以由调用方传 skipYearWindow 决定。
   */
  if (f.beforeWindow) {
    // 只数窗口下限之前的 —— 目录搜索给「含 1995 年前 N 部」那个开关算数用
    w.push('a.year < ?');
    p.push(yearWindow().min);
  } else if (!f.skipYearWindow) {
    const { min, max } = yearWindow();
    // requireYear 已经排除了无年份的，再写 `year IS NULL OR` 会诱发 MULTI-INDEX OR，
    // 目录首屏的列表和总数各慢一截
    w.push(f.requireYear ? 'a.year >= ? AND a.year <= ?' : '(a.year IS NULL OR (a.year >= ? AND a.year <= ?))');
    p.push(min, max);
  }
  if (f.epMax) { w.push('a.episodes IS NOT NULL AND a.episodes <= ?'); p.push(f.epMax); }
  if (f.scoreMin) { w.push('a.bgm_score >= ?'); p.push(f.scoreMin); }
  if (f.rankedOnly) w.push('a.bgm_rank > 0');
  if (f.votesMin) { w.push('a.bgm_votes >= ?'); p.push(f.votesMin); }
  if (f.weekday) { w.push('a.bgm_weekday = ?'); p.push(f.weekday); }
  if (f.watch === 'none') w.push('ue.anime_id IS NULL');
  else if (f.watch === 'active') {
    // 番单「全部」页：五种状态都含。原来只含想看 / 在看 / 看完，于是页头「共 338 部」、
    // 「全部」tab 却是 337 —— 叫「全部」就该是全部（2026-10-18）
    w.push('ue.anime_id IS NOT NULL');
  } else if (f.watch) { w.push('ue.status = ?'); p.push(f.watch); }
  // 我的评分：'none' 只看还没打分的、'has' 只看打过分的。
  // 必须要求在番单里 —— 否则「未评分」会把全库四万条没记录的番全算进来。
  if (f.myScore === 'none') w.push('ue.anime_id IS NOT NULL AND ue.my_score IS NULL');
  else if (f.myScore === 'has') w.push('ue.my_score IS NOT NULL');
  /**
   * 题材三槽位（每个题材本身由多个英文 tag 组成，组内恒为 OR）：
   *   genres     必须全部包含   → 每个题材一个 EXISTS，彼此 AND
   *   genresAny  至少包含一个   → 所有 tag 并成一个 EXISTS
   *   genresNot  排除          → NOT EXISTS
   * 组合示例：校园 且 (喜剧 或 奇幻) 且非 后宫
   */
  for (const g of (f.genres ?? []).filter((x) => GENRE_MAP[x]?.length)) {
    const tags = GENRE_MAP[g];
    w.push(`EXISTS (SELECT 1 FROM anime_tag t WHERE t.anime_id=a.id AND t.tag IN (${tags.map(() => '?').join(',')}))`);
    p.push(...tags);
  }
  const anyGs = (f.genresAny ?? []).filter((x) => GENRE_MAP[x]?.length);
  if (anyGs.length) {
    const tags = [...new Set(anyGs.flatMap((g) => GENRE_MAP[g]))];
    w.push(`EXISTS (SELECT 1 FROM anime_tag t WHERE t.anime_id=a.id AND t.tag IN (${tags.map(() => '?').join(',')}))`);
    p.push(...tags);
  }
  for (const g of f.genresNot ?? []) {
    const tags = GENRE_MAP[g];
    if (!tags?.length) continue;
    w.push(`NOT EXISTS (SELECT 1 FROM anime_tag t WHERE t.anime_id=a.id AND t.tag IN (${tags.map(() => '?').join(',')}))`);
    p.push(...tags);
  }
  if (f.requireYear) w.push('a.year IS NOT NULL');
  // NSFW：AOD 没有 isAdult 字段，改用标签判定（见 genres.js 的 NSFW_TAGS）
  if (f.hideNsfw) w.push('a.is_nsfw = 0');
  if (f.tag) {
    w.push('EXISTS (SELECT 1 FROM anime_tag t WHERE t.anime_id = a.id AND t.tag = ?)');
    p.push(f.tag);
  }
  if (f.tagNot) {
    w.push('NOT EXISTS (SELECT 1 FROM anime_tag t WHERE t.anime_id = a.id AND t.tag = ?)');
    p.push(f.tagNot);
  }
  if (f.studio) {
    // 按归一名筛选，这样 toei animation 的几种写法能一并命中
    w.push('EXISTS (SELECT 1 FROM anime_studio s WHERE s.anime_id = a.id AND s.studio_norm = ?)');
    p.push(f.studio);
  }
  return { where: w.join(' AND '), params: p };
}

/**
 * 搜索时要卸掉的收窄条件 —— 必须覆盖筛选栏能设的【全部】字段。
 *
 * 界面上 `filtersMuted` 已经把筛选栏置灰、并写着「不生效」，这里漏一个就是骗人。
 * 实测漏了 `watch`：搜「叹气」时「我的 = 未标记」还挂着，已经看完的
 * 《叹气的亡灵想隐退 第2部分》被筛掉，两部只出一部。漏了 `genres` / `scoreMin` /
 * `studio` / `myScore` / `epMax` 同理。
 *
 * 不卸的只有两类：
 * · `jpOnly` / `hideNsfw` —— 站点口径与安全，不是筛选栏给的
 * · `skipYearWindow` 与年份窗口 —— 设置页的硬边界
 *
 * 页面自己的作用域要靠 `f.scopeKeys` 声明豁免（番单页把 watch 当分类用）。
 */
const SEARCH_OFF = {
  types: null, requireYear: false, yearMin: null, yearMax: null, season: null,
  statuses: null, status: null, excludeUpcoming: false, isShort: null, weekday: null,
  watch: null, myScore: null, genres: null, genresAny: null, genresNot: null,
  tag: null, tagNot: null, scoreMin: null, votesMin: null, rankedOnly: false,
  studio: null, epMax: null
};

export function listAnime(f = {}, { limit = 60, offset = 0, sort = 'popular', sort2 = 'popular' } = {}) {
  const db = getDb();
  // 有搜索词时卸掉全部收窄条件 ——
  // 否则搜一部 OVA/SP 会得到 0 结果，看起来像坏了
  // （实测主人把「2026夏+连载中·已完结」存成默认后，搜「刀剑神域」得 0 部）。
  // f.applyFilters 为真时才把筛选叠到搜索结果上 —— 界面上是筛选栏最后那个开关。
  if (f.q && !f.applyFilters) {
    const off = { ...SEARCH_OFF };
    // 页面作用域豁免：番单页的 watch 是分类（想看/在看/看完），不是筛选栏给的
    for (const k of f.scopeKeys ?? []) delete off[k];
    f = { ...f, ...off };
  }
  const { where, params } = buildWhere(f);
  const fts = f.q ? toFtsQuery(f.q) : null;
  const ftsJoin = fts ? 'JOIN anime_fts ft ON ft.rowid = a.id' : '';
  const ftsWhere = fts ? 'AND ft.seg MATCH ?' : '';
  /**
   * 排序一律走 SORTS，搜索时也不例外。
   *
   * 原来这里是 `fts && !f.sort ? 'a.source_count DESC, a.year DESC' : SORTS[sort]`，
   * 想让搜索结果按「相关度」（拿 source_count 当代理指标）排。两个问题：
   *   ① f.sort 这个字段【从来没有被赋值过】—— f 是筛选对象，排序走的是第二个参数。
   *      于是 `!f.sort` 恒为真，只要带搜索词，排序选项就完全失效：
   *      主人在搜索状态下点「最新」「人气」「评分」，结果一动不动。
   *   ② 就算能生效，主人要的也不是相关度 ——「所有筛选输入栏查询时，
   *      排序需要是默认最新到最旧的」。FTS 已经按 phrase 精确匹配过了，
   *      再按收录站数排一遍只会让 2018 年的本篇压在 2026 年的新番前面。
   */
  /**
   * 例外只有一条：标题 / 中文名 / 日文名【完全等于】搜索词（规范化后）的条目置顶，
   * 其余仍按所选排序（默认最新）。长寿系列的本篇原来沉底 ——
   * 搜「名侦探柯南」TV 本篇排 68/69、「ONE PIECE」TV 排 106/109（2026-10-18 体检时定的折中，待主人确认：
   * 默认排序不改，只把完全匹配提到最前）。
   */
  const nq = fts ? normTitle(f.q) : null;
  if (nq) ensureNorm(db);
  const pin = nq ? `CASE WHEN ? IN (norm_title(a.title), norm_title(a.title_cn), norm_title(a.title_ja))
                    THEN 0 ELSE 1 END, ` : '';
  const order = pin + orderBy(sort, sort2);
  const args = fts ? [...params, fts] : params;

  const rows = db.prepare(`
    SELECT a.id, a.title, a.title_ja, a.title_cn, a.type, a.year, a.season, a.episodes,
           a.status, coalesce(a.status_eff, a.status) AS status_eff, a.is_short, a.thumbnail, a.picture, a.cover_dead, a.bgm_score, a.bgm_votes,
           a.bgm_rank, a.bgm_id, a.bgm_collection, a.source_count,
           ue.status AS my_status, ue.current_episode, ue.my_score
    FROM anime a
    ${ftsJoin}
    LEFT JOIN user_entry ue ON ue.anime_id = a.id
    WHERE ${where} ${ftsWhere}
    ORDER BY ${order}
    LIMIT ? OFFSET ?`).all(...args, ...(nq ? [nq] : []), limit, offset);

  /**
   * ⚡ 总数这一遍不带 LEFT JOIN user_entry —— 除非 WHERE 里真的用到了 ue。
   *
   * 列表那一遍要 join 是为了取 my_status / current_episode 显示在卡片上；
   * 数总数不需要这些列，可 join 还是要对 41,537 行每行做一次主键查找。
   * 实测（无题材筛选）12.9ms → 9.6ms。
   *
   * 用正则探 where 里有没有 `ue.`，而不是让 buildWhere 额外返回一个标志位 ——
   * 以后谁加了新的 ue 条件（watch / myScore 之外的）不用记得同步改这里，
   * 漏改的后果是 SQL 直接报 no such column，不会悄悄数错。
   */
  const usesEntry = /\bue\./.test(where);
  const total = db.prepare(`
    SELECT count(*) c FROM anime a ${ftsJoin}
    ${usesEntry ? 'LEFT JOIN user_entry ue ON ue.anime_id = a.id' : ''}
    WHERE ${where} ${ftsWhere}`).get(...args).c;

  return { rows, total };
}
export function getAnime(id) {
  const db = getDb();
  const a = db.prepare(`
    SELECT a.*, ue.status AS my_status, ue.current_episode, ue.my_score, ue.my_note,
           ue.is_vague, ue.started_at, ue.finished_at
    FROM anime a LEFT JOIN user_entry ue ON ue.anime_id = a.id
    WHERE a.id = ?`).get(id);
  if (!a) return null;
  a.tags = db.prepare('SELECT tag FROM anime_tag WHERE anime_id = ? ORDER BY tag').all(id).map((r) => r.tag);
  // 同一家的几种写法（doga kobo / dōga kōbō）只留一个（#109），取最短的那种 —— 和筛选器下拉的取法一致
  const st = new Map();
  for (const r of db.prepare("SELECT studio, studio_norm FROM anime_studio WHERE anime_id = ? AND role='studio'").all(id)) {
    const k = r.studio_norm || r.studio, cur = st.get(k);
    if (!cur || r.studio.length < cur.length || (r.studio.length === cur.length && r.studio < cur)) st.set(k, r.studio);
  }
  a.studios = [...st.values()];
  a.aliases = db.prepare('SELECT alias FROM anime_alias WHERE anime_id = ? LIMIT 30').all(id).map((r) => r.alias);
  a.links = db.prepare('SELECT site, url FROM anime_source WHERE anime_id = ? ORDER BY site').all(id);
  // 同系列：优先用 franchise 表（已算好播出顺序 + 总集篇可跳过标记）
  const fm = db.prepare('SELECT franchise_id FROM franchise_member WHERE anime_id = ?').get(id);
  if (fm) {
    a.franchise = db.prepare('SELECT id, name, size FROM franchise WHERE id = ?').get(fm.franchise_id);
    a.related = db.prepare(`
      SELECT b.id, b.title, b.title_cn, b.title_ja, b.type, b.year, b.season, b.episodes,
             b.thumbnail, b.picture, b.cover_dead, b.bgm_score, b.bgm_votes, b.is_short,
             coalesce(b.status_eff, b.status) AS status_eff,
             coalesce(m.user_order, m.release_order) AS release_order,
             m.user_order, m.is_skippable, m.skip_reason,
             ue.status AS my_status, ue.current_episode, ue.my_score
      FROM franchise_member m JOIN anime b ON b.id = m.anime_id
      LEFT JOIN user_entry ue ON ue.anime_id = b.id
      WHERE m.franchise_id = ? AND b.is_stub = 0
      ORDER BY coalesce(m.user_order, m.release_order)`).all(fm.franchise_id);
    a.hasCustomOrder = db.prepare(
      'SELECT count(*) c FROM franchise_member WHERE franchise_id=? AND user_order IS NOT NULL'
    ).get(fm.franchise_id).c > 0;
  } else {
    // 回退：直接关联（那 43.8% 没进任何系列的条目）
    a.franchise = null;
    a.related = db.prepare(`
      SELECT DISTINCT b.id, b.title, b.title_cn, b.title_ja, b.type, b.year, b.season, b.episodes,
             b.thumbnail, b.picture, b.cover_dead, b.bgm_score, b.bgm_votes, b.is_short,
             coalesce(b.status_eff, b.status) AS status_eff,
             NULL AS release_order, 0 AS is_skippable, NULL AS skip_reason,
             ue.status AS my_status, ue.current_episode, ue.my_score
      FROM anime_related_raw r
      JOIN anime_source s ON s.url = r.url
      JOIN anime b ON b.id = s.anime_id
      LEFT JOIN user_entry ue ON ue.anime_id = b.id
      WHERE r.anime_id = ? AND b.is_stub = 0 AND b.id != ?
      ORDER BY b.year, b.type`).all(id, id);
  }
  return a;
}
/** 重算筛选器选项并物化。只在灌库后需要跑一次。 */
export function rebuildFacets() {
  const db = getDb();
  /**
   * ⚠️ 筛选器的计数必须和目录页的默认口径一致，否则会出现「胶囊上写着有 2 部、
   * 点进去 0 部」。实测踩过：2028/2029 那几条全是 is_jp=0（中国动画「龙族」、
   * 欧美片「Boo」「Sunny」），而年份计数没按 is_jp 过滤，胶囊上就显示 2028=4、2029=2。
   * 目录默认 jpOnly=true，所以这里也必须加 is_jp=1。
   */
  const BASE = 'a.is_stub = 0 AND a.is_jp = 1';
  const data = {
    years: db.prepare(`SELECT year, count(*) c FROM anime a
      WHERE ${BASE} AND year IS NOT NULL GROUP BY year ORDER BY year DESC`).all(),
    tags: db.prepare(`SELECT t.tag, count(*) c FROM anime_tag t JOIN anime a ON a.id=t.anime_id
                      WHERE ${BASE} GROUP BY t.tag HAVING c >= 30 ORDER BY c DESC LIMIT 120`).all(),
    // 按归一名聚合，展示名取该组里最短的原始写法（通常是最干净的那个）
    studios: db.prepare(`
      SELECT s.studio_norm AS key, count(DISTINCT s.anime_id) c,   -- 同一部番挂着同一家的几种写法时只算一次（#109 合并后 8bit 原来算出 200）
             min(length(s.studio) || '\u0001' || s.studio) AS pick
      FROM anime_studio s JOIN anime a ON a.id = s.anime_id
      WHERE ${BASE} AND s.role = 'studio' AND s.studio_norm IS NOT NULL AND s.studio_norm != ''
      GROUP BY s.studio_norm HAVING c >= 8 ORDER BY c DESC LIMIT 200`).all()
      // 缓存里存原始写法（全小写：toei animation / j.c.staff），展示名读的时候再过 dispStudio ——
      // 写法规则改了（#109 加缩写表）不用作废缓存
      .map((r) => ({ studio: r.key, raw: r.pick.split('\u0001')[1], c: r.c }))
  };
  db.prepare(`INSERT INTO facet_cache (key,json,built_at) VALUES ('v1',?,datetime('now'))
              ON CONFLICT(key) DO UPDATE SET json=excluded.json, built_at=excluded.built_at`)
    .run(JSON.stringify(data));
  _facetMem = withLabels(data);
  _facetAt = db.prepare("SELECT built_at FROM facet_cache WHERE key='v1'").get().built_at;
  return _facetMem;
}
/** 公司展示名在读的时候算（老缓存只有 label 没有 raw，也照样过一遍） */
const withLabels = (d) => ({ ...d, studios: d.studios.map((s) => ({ studio: s.studio, label: dispStudio(s.raw ?? s.label), c: s.c })) });
let _facetMem = null;
let _facetAt = null;
export function facets() {
  const db = getDb();
  // ⚠️ 必须比 built_at：灌库是另一个进程干的，只认进程内缓存的话，
  // 常驻的 web 进程会永远拿着部署那一刻的筛选器选项，新番入库了也不更新。
  // 这一次 SELECT 实测 0.0037ms，比省下的 16.8KB JSON.parse 便宜得多。
  const at = db.prepare("SELECT built_at FROM facet_cache WHERE key='v1'").get()?.built_at;
  if (!at) return rebuildFacets();
  if (_facetMem && _facetAt === at) return _facetMem;
  _facetMem = withLabels(JSON.parse(db.prepare("SELECT json FROM facet_cache WHERE key='v1'").get().json));
  _facetAt = at;
  return _facetMem;
}
/** ⚡ 读物化的筛选器选项。原本每次请求现算，冷启动 3.6 秒，是「卡卡的」主因。 */
/** 当前季度（AOD 的 animeSeason 口径：1-3冬 4-6春 7-9夏 10-12秋）*/
export function currentSeason(d = new Date()) {
  const m = d.getMonth() + 1;
  return { year: d.getFullYear(), season: m <= 3 ? 'WINTER' : m <= 6 ? 'SPRING' : m <= 9 ? 'SUMMER' : 'FALL' };
}
export const SCHED_COLS = `a.id, a.title, a.title_ja, a.title_cn, a.type, a.year, a.season, a.episodes,
  a.status, coalesce(a.status_eff, a.status) AS status_eff, a.is_short, a.thumbnail, a.picture, a.cover_dead, a.bgm_score, a.bgm_votes,
  a.bgm_weekday, a.bgm_collection, a.source_count`;
/** 季度浏览：某一年四个季度各有哪些番 */
export function seasonGrid(year, { types = ['TV'], minSources = 4, hideNsfw = false, sort = 'popular' } = {}) {
  const db = getDb();
  const ph = types.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT ${SCHED_COLS}, ue.status AS my_status, ue.current_episode, ue.my_score
    FROM anime a LEFT JOIN user_entry ue ON ue.anime_id = a.id
    WHERE a.is_stub = 0 AND a.is_jp = 1 AND a.year = ? AND a.season IS NOT NULL
      AND a.type IN (${ph}) AND a.source_count >= ?
      ${hideNsfw ? 'AND a.is_nsfw = 0' : ''}
    ORDER BY ${SORTS[sort] || SORTS.popular}, a.source_count DESC`).all(year, ...types, minSources);
  const out = { WINTER: [], SPRING: [], SUMMER: [], FALL: [] };
  for (const r of rows) out[r.season]?.push(r);
  return out;
}
/** 有数据的年份列表（季度浏览的导航用）*/
export function seasonYears() {
  // 只给显示窗口内的年份 —— 年份胶囊、季度导航都用这份列表
  const { min, max } = yearWindow();
  return getDb().prepare(`
    SELECT year, count(*) c FROM anime
    WHERE is_stub=0 AND is_jp=1 AND season IS NOT NULL AND year >= ? AND year <= ?
    GROUP BY year ORDER BY year DESC`).all(Math.max(1963, min), max);
}
