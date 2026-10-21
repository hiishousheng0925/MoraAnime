/**
 * 统计与时间线。
 *
 * ⚠️ 这一页所有分布类图表必须用同一个人群条件（WATCHED）——
 * 曾经集数/年份/题材各用一套、制作公司完全不过滤，
 * 同一部弃番的番在一个页面里被算了两种账。详见 REQUIREMENTS.md §6.7
 */
import { getDb } from '../db.js';
import { GENRE_MAP } from '../../genres.js';
import { dispStudio } from '../../format.js';
import { longestRun } from '../../heatmap.js';
/** 统计的统一口径：「看过的」= 番单里除「想看」以外的全部。
 *  搁置和弃番也确实看了一部分，算进分布里；想看的一集没看，不能算。
 *  ⚠️ 所有分布类图表都必须用这一个条件 —— 之前集数/年份/题材各用一套，
 *  同一部弃番的番在一个页面里被算了两种账（年份图没它、制作公司有它）。 */
export const WATCHED = "ue.status <> 'plan'";

/**
 * 「已看集数」的统一算法。侧栏和统计页必须用这一份 —— 曾经各写一套，
 * 侧栏显示 4389 集、统计页显示 4359 集，差 30 集，主人看到两个数字对不上。
 *
 * 差额来自两处口径不同：
 *   ① 人群：侧栏只算「看完 + 在看」，漏掉弃番和搁置 —— 那两类也确实看了一部分
 *   ② 补集数：侧栏对「在看」也 coalesce(current_episode, a.episodes)，
 *      于是三部没填进度的在看番（12+6+12 集）被当成全看完，凭空多出 30 集
 *
 * 正确口径：只有「看完」在没填进度时才按总集数补 —— 在看/搁置/弃番
 * 没填进度就是不知道看到哪，按 0 算。
 */
export const WATCHED_EPS = `
  CASE WHEN ue.status = 'completed' THEN coalesce(ue.current_episode, a.episodes, 0)
       ELSE coalesce(ue.current_episode, 0) END`;
/** 年度总结 + 观看时间线的数据 */
export function stats() {
  const db = getDb();
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  const byStatus = Object.fromEntries(
    db.prepare('SELECT status, count(*) c FROM user_entry GROUP BY status').all().map((r) => [r.status, r.c]));
  const total = Object.values(byStatus).reduce((x, y) => x + y, 0);
  const watchedCount = total - (byStatus.plan ?? 0);

  // 集数与时长：只有「看完」才在没填进度时按总集数补 ——
  // 「在看/搁置/弃番」没填进度就是不知道看到哪，按 0 算；否则一部 24 集的在看会被当成全看完
  const watched = one(`
    SELECT coalesce(sum(eps),0) eps, coalesce(sum(eps * coalesce(duration_sec, 1440)),0) secs FROM (
      SELECT ${WATCHED_EPS} AS eps, a.duration_sec
      FROM user_entry ue JOIN anime a ON a.id = ue.anime_id WHERE ${WATCHED})`);

  // 按「番剧年份」分布（不是观看年份 —— 我们没有历史观看日期）
  const byYear = db.prepare(`
    SELECT a.year, count(*) c FROM user_entry ue JOIN anime a ON a.id = ue.anime_id
    WHERE ${WATCHED} AND a.year IS NOT NULL
    GROUP BY a.year ORDER BY a.year`).all();

  const byType = db.prepare(`
    SELECT a.type, count(*) c FROM user_entry ue JOIN anime a ON a.id = ue.anime_id
    WHERE ${WATCHED} GROUP BY a.type ORDER BY c DESC`).all();

  // 评分也归到同一口径：想看的番还没看，理论上不该有分，真有也不该进平均
  const scoreDist = db.prepare(`
    SELECT cast(ue.my_score AS INTEGER) s, count(*) c FROM user_entry ue
    WHERE ${WATCHED} AND ue.my_score IS NOT NULL GROUP BY s ORDER BY s`).all();

  const avgScore = one(`SELECT round(avg(ue.my_score),2) v FROM user_entry ue
                        WHERE ${WATCHED} AND ue.my_score IS NOT NULL`).v;

  // 题材：一个中文题材对应多个 AOD 标签，必须按番剧去重计数。
  // 早先用「各标签计数取 max」，实测 51 个题材有 23 个偏低（青春少 32%、悬疑少 29%）
  const perAnime = new Map();
  for (const r of db.prepare(`
    SELECT DISTINCT ue.anime_id id, t.tag FROM user_entry ue
    JOIN anime_tag t ON t.anime_id = ue.anime_id WHERE ${WATCHED}`).all()) {
    let s = perAnime.get(r.id);
    if (!s) perAnime.set(r.id, (s = new Set()));
    s.add(r.tag);
  }
  const genres = Object.entries(GENRE_MAP)
    .map(([cn, tags]) => {
      let n = 0;
      for (const tset of perAnime.values()) if (tags.some((t) => tset.has(t))) n++;
      return [cn, n];
    })
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 16);

  // 制作公司：按 studio_norm 分组（原始值带 "co., ltd." 这类噪音），
  // norm 本身丢了标点（j.c.staff → "j c staff"），所以展示名取该 norm 下最短的原始写法。
  // 链接必须传 norm —— 目录页的 studio 筛选比的是 studio_norm
  const counted = db.prepare(`
    SELECT s.studio_norm key, count(DISTINCT ue.anime_id) c
    FROM user_entry ue JOIN anime_studio s ON s.anime_id = ue.anime_id
    WHERE ${WATCHED} AND s.role = 'studio' AND s.studio_norm IS NOT NULL AND s.studio_norm != ''
    GROUP BY s.studio_norm ORDER BY c DESC, key LIMIT 12`).all();
  const studios = counted.length ? (() => {
    // 展示名要在全库范围内找最短写法：番单里可能只存了长的那条
    // （Clannad 那行就只有 "kyoto animation co., ltd."）
    const best = new Map();
    for (const r of db.prepare(`SELECT studio_norm k, studio FROM anime_studio
      WHERE role='studio' AND studio_norm IN (${counted.map(() => '?').join(',')})`)
      .all(...counted.map((x) => x.key))) {
      const cur = best.get(r.k);
      if (!cur || r.studio.length < cur.length) best.set(r.k, r.studio);
    }
    return counted.map((r) => ({ studio: r.key, label: dispStudio(best.get(r.key) ?? r.key), c: r.c }));
  })() : [];

  // 活动热力：按日聚合 watch_log。窗口必须和前端渲染的 26 周对齐，否则最左两天永远是空的
  // watched_at 存的是 UTC（datetime('now')），按本地日期分组 —— 否则早上 8 点前的操作归到前一天
  const activity = db.prepare(`
    SELECT date(watched_at, 'localtime') d, count(*) c FROM watch_log
    WHERE watched_at >= date('now','-182 day') GROUP BY d ORDER BY d`).all();

  const top = db.prepare(`
    SELECT a.id, a.title, a.title_ja, a.title_cn, a.year, a.type, a.is_short, a.thumbnail, a.picture,
           a.cover_dead, a.episodes, a.bgm_score, a.bgm_votes, coalesce(a.status_eff,a.status) AS status_eff,
           ue.my_score, ue.status AS my_status, ue.current_episode
    FROM user_entry ue JOIN anime a ON a.id = ue.anime_id
    WHERE ${WATCHED} AND ue.my_score IS NOT NULL
    ORDER BY ue.my_score DESC, a.bgm_score DESC LIMIT 16`).all();   // 一排 8 张 × 2 排

  // ── 首屏「回顾 hero」的标签。口径同上：直接取上面同一人群的分布，不另写一套 SQL ──
  // 最多的题材：genres 已按「部数降序、同数按名字」排好
  const topGenre = genres.length ? { name: genres[0][0], c: genres[0][1] } : null;
  // 峰值年份：同数取更晚的那年（结果确定，也更贴近「最近在追」）
  const peakYear = byYear.reduce((m, r) => (!m || r.c >= m.c ? { year: r.year, c: r.c } : m), null);
  // 起始日期：番单 / 观看记录里最早的一天。两列都存 UTC，按本地日期算（同热力图）
  const since = one(`SELECT date(min(t), 'localtime') d FROM (
    SELECT min(created_at) t FROM user_entry UNION ALL SELECT min(watched_at) FROM watch_log)`).d;
  // 最长连续：有观看记录的本地日期里，逐日相连的最长一段。用全量日志，不受热力图 26 周窗口限制
  const longestStreak = longestRun(db.prepare(`
    SELECT DISTINCT date(watched_at, 'localtime') d FROM watch_log ORDER BY d`).all().map((r) => r.d));

  return {
    byStatus, total, watchedCount,
    episodes: watched.eps,
    hours: Math.round(watched.secs / 3600),
    byYear, byType, scoreDist, avgScore, genres, studios, activity, top,
    topGenre, peakYear, since, longestStreak
  };
}

/** 观看时间线：watch_log 按天分组 */
/**
 * 观看时间线。按天分组，分页返回。
 * 一次快速标记会写几十条日志，全量铺出来页面能拉出好几屏 —— 所以要分页。
 * total 是日志总条数（不是天数），用来算页数。
 */
export function timeline({ limit = 10, offset = 0 } = {}) {
  const db = getDb();
  /**
   * 折叠重复日志：同一部番、同一动作、同一集，5 分钟内的只显示第一条。
   *
   * 历史数据里已经有这种重复（主人拖进度条补集数时，同一部番留下了两条
   * 「第 12 集」，时间线上就是两行一样的，看着像重复动漫）。写入侧已经加了防重
   * （见 queries/user.js），这里负责把已经存在的那些收起来。
   * 用 LAG 取上一条同类记录的时间 —— 总数和分页都必须走同一个 CTE，否则
   * 页数算多了会出现空白页。
   */
  const DEDUP = `WITH t AS (
    SELECT w.*, LAG(w.watched_at) OVER (
      PARTITION BY w.anime_id, w.action, coalesce(w.episode, -1), coalesce(w.detail, '')
      ORDER BY w.watched_at
    ) AS prev
    FROM watch_log w
  ), d AS (
    SELECT * FROM t
    WHERE prev IS NULL OR (julianday(watched_at) - julianday(prev)) * 86400 > 300
  )`;
  const total = db.prepare(`${DEDUP}
    SELECT count(*) c FROM d JOIN anime a ON a.id = d.anime_id`).get().c;
  const rows = db.prepare(`${DEDUP}
    SELECT d.id, d.episode, d.action, d.detail, datetime(d.watched_at, 'localtime') AS watched_at,
           a.id AS anime_id, a.title, a.title_ja, a.title_cn, a.episodes,
           a.thumbnail, a.picture, a.cover_dead
    FROM d JOIN anime a ON a.id = d.anime_id
    ORDER BY d.watched_at DESC, d.id DESC LIMIT ? OFFSET ?`).all(limit, offset);
  // watched_at 上面已转成本地时间：按天分组和行内的「HH:MM」都按本地算
  const days = [];
  for (const r of rows) {
    const d = String(r.watched_at).slice(0, 10);
    if (!days.length || days.at(-1).date !== d) days.push({ date: d, items: [] });
    days.at(-1).items.push(r);
  }
  return { days, total };
}
