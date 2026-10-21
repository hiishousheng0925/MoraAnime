import { listAnime, myStats, WATCHED, WATCHED_EPS } from '$lib/server/queries.js';
import { num, pickQ, hideNsfw, pickTypes, pickGenres, yearFacets, pickPer } from '$lib/server/loaderUtil.js';
import { ALL_TYPES, DEFAULT_SORT, pickSort2 } from '$lib/constants.js';
import { GENRES } from '$lib/genres.js';
import { getDb } from '$lib/server/db.js';
import { episodeStatus } from '$lib/server/episodes.js';

/**
 * 番单里实际出现过的年份 / 类型 / 题材 —— 有货就只列有货的（带数量）。
 * 一条记录都没有时回退到全量选项：筛选栏要一直显示，
 * 而一排点开全是空的下拉比不显示更糟。
 */
function myFacets(status) {
  const db = getDb();
  // 「全部」= 五种状态都算（和页头「共 N 部」同一个数）
  const cond = status === 'active' ? '1 = 1' : 'ue.status = ?';
  const args = status === 'active' ? [] : [status];
  const q = (sql) => db.prepare(sql).all(...args);
  return {
    years: q(`SELECT a.year, count(*) c FROM user_entry ue JOIN anime a ON a.id=ue.anime_id
              WHERE ${cond} AND a.year IS NOT NULL GROUP BY a.year ORDER BY a.year DESC`),
    types: q(`SELECT a.type, count(*) c FROM user_entry ue JOIN anime a ON a.id=ue.anime_id
              WHERE ${cond} GROUP BY a.type ORDER BY c DESC`),
    // 题材按番剧去重计数：一个中文题材对应多个 AOD 标签，
    // 「各标签计数取 max」会漏掉跨标签的番（统计页同一个 bug 实测偏低 32%）
    genreCounts: (() => {
      const perAnime = new Map();
      for (const r of q(`SELECT DISTINCT ue.anime_id id, t.tag FROM user_entry ue
                          JOIN anime_tag t ON t.anime_id = ue.anime_id WHERE ${cond}`)) {
        let set = perAnime.get(r.id);
        if (!set) perAnime.set(r.id, (set = new Set()));
        set.add(r.tag);
      }
      return GENRES
        .map(([cn, tags]) => [cn, [...perAnime.values()].filter((set) => tags.some((t) => set.has(t))).length])
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    })()
  };
}

const COVER_COLS = `a.id, a.title, a.title_ja, a.title_cn, a.type, a.year, a.episodes, a.picture, a.thumbnail, a.cover_dead`;

/**
 * 页头 hero 的数字 + 氛围封面，和「继续看」书架。
 * 口径和统计页一致（queries/stats.js 的 WATCHED / WATCHED_EPS）：
 * 观看时长 = 看过的集数 × 单集时长（缺省 24 分钟），均分只算 status <> 'plan' 且打过分的。
 */
function myHero(db) {
  const w = db.prepare(`
    SELECT coalesce(sum(eps * coalesce(duration_sec, 1440)), 0) secs FROM (
      SELECT ${WATCHED_EPS} AS eps, a.duration_sec
      FROM user_entry ue JOIN anime a ON a.id = ue.anime_id WHERE ${WATCHED})`).get();
  const avg = db.prepare(`SELECT avg(ue.my_score) v FROM user_entry ue
                          WHERE ${WATCHED} AND ue.my_score IS NOT NULL`).get().v;
  // 最近动过的几部（有封面的），给 hero 的氛围背景和封面扇
  const recent = db.prepare(`SELECT ${COVER_COLS} FROM user_entry ue JOIN anime a ON a.id = ue.anime_id
    WHERE coalesce(a.cover_dead, 0) = 0 AND coalesce(a.picture, a.thumbnail) IS NOT NULL
    ORDER BY ue.updated_at DESC LIMIT 5`).all();
  return { days: w.secs / 86400, avg: avg == null ? null : Math.round(avg * 10) / 10, recent };
}

/**
 * 「继续看」：在看的番，最近动过的在前。
 * 带上已播集数（和详情页 / 首页同一口径，server/episodes.js）：追平了的卡写「已追平」而不是一个百分比（#7）
 */
function continueShelf(db) {
  const rows = db.prepare(`SELECT ${COVER_COLS}, a.bgm_weekday, ue.status AS my_status, ue.current_episode, ue.my_score
    FROM user_entry ue JOIN anime a ON a.id = ue.anime_id
    WHERE ue.status = 'watching' ORDER BY ue.updated_at DESC LIMIT 12`).all();
  const st = episodeStatus(rows.map((r) => r.id));
  return rows.map((r) => {
    const s = st.get(r.id);
    return s?.total ? { ...r, episodes: s.total, aired: s.aired < s.total ? s.aired : null, next: s.next } : r;
  });
}

export function load({ url }) {
  const s = url.searchParams;
  const status = s.get('status') || 'active';
  const f = {
    watch: status,
    q: pickQ(s),
    ...pickTypes(s),
    ...pickGenres(s),      // 之前这里没处理 gm=or，同一个链接在目录页和番单页行为不同
    yearMin: num(s.get('from')),
    yearMax: num(s.get('to')),
    season: s.get('season') || null,
    isShort: s.get('short') === '1' ? 1 : null,
    scoreMin: num(s.get('smin')),
    // 我的评分：ms=none 未评分 / ms=has 已评分
    myScore: ['none', 'has'].includes(s.get('ms')) ? s.get('ms') : null,
    // 番单是主人自己标过的记录，不该因为改了设置页的年份窗口就凭空消失
    skipYearWindow: true,
    epMax: num(s.get('epmax')),
    hideNsfw: hideNsfw()
  };
  /**
   * 和目录页同一套：搜索默认忽略类型/题材/年份/放送这些收窄条件
   * （见 listAnime），想叠上去用筛选栏最左边的开关。
   * 原来这一页有同样的行为、却既没有开关也没有置灰 —— 主人在
   * 「在此分类中搜索」里搜一下，筛选就悄悄失效了，界面上一点提示都没有。
   * 分类（watch）不受影响 —— 靠 scopeKeys 显式豁免，见 listAnime 的 SEARCH_OFF。
   */
  const applyFilters = s.get('qf') === '1';
  f.applyFilters = applyFilters;
  f.scopeKeys = ['watch'];
  const sort = s.get('sort') || DEFAULT_SORT;   // 年份+季度，新 → 旧
  const sort2 = pickSort2(s.get('s2'));
  // 原来是一次取 300 条、没有分页 —— 番单过 300 条就看不到后面的了。
  // 默认 24 = 一排 8 张 × 3 排（和目录一致）；可选 30/50/100
  const { per, perIsDefault } = pickPer(s, 24);
  let page = Math.max(1, num(s.get('p')) || 1);
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

  const mine = myFacets(status);
  const empty = !mine.types.length;              // 这个分类下一条记录都没有
  // 番单为空时回退到全量选项（数量给 null，UI 不显示计数）
  const facets = empty
    ? { years: yearFacets(),
        types: ALL_TYPES.map((t) => ({ type: t })),
        genreCounts: GENRES.map(([cn]) => [cn, null]) }
    : mine;
  const db = getDb();
  const hero = myHero(db);
  /**
   * 空状态的装饰封面：优先用自己最近的几部；番单整个是空的就拿最热门的几部
   * （隐藏 NSFW 时也只取全年龄的 —— 最热门那几部本来也都是）
   */
  const deco = rows.length ? [] : hero.recent.length ? hero.recent.slice(0, 3)
    : db.prepare(`SELECT ${COVER_COLS} FROM anime a WHERE a.is_jp = 1 AND coalesce(a.is_nsfw, 0) = 0
        AND coalesce(a.cover_dead, 0) = 0 AND coalesce(a.picture, a.thumbnail) IS NOT NULL
        ORDER BY a.bgm_votes DESC NULLS LAST LIMIT 3`).all();
  return { rows, total, page, per, perIsDefault, status, sort, sort2, f,
           hero, deco, shelf: status === 'active' ? continueShelf(db) : [],
           filtersMuted: !!f.q && !applyFilters,
           stats: myStats(), facets, facetsAreGlobal: empty };
}
