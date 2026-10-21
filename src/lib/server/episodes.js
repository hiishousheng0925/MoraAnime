/**
 * 分集数据（#49 分集列表、#47 今天更新）：Bangumi 的正片分集（type 0），每集标题 / 中文标题 / 播出日期。
 *
 * 用在三处：观看页选集（每集中文标题 + 日期）、首页「今天更新」、「我在追的」的「未看 N 集」。
 *
 * 两条来源，写同一张表 bgm_episode（按 Bangumi 的分集 id upsert）：
 *   · 每周导出的 episode.jsonlines —— 全量（ingest-bgm.js，dump 换了才重灌）
 *   · 每日 API /v0/episodes —— 只刷正在放送的（sync-episodes.js）：周导出最多晚一周，
 *     新番临时改档、补录标题都赶不上「今天更新」
 *
 * 第几集 = 该条目正片按 sort 排的序号（1 起），不是 sort 本身：续作的 sort 常接着上一季编
 * （第二季 sort 13–24），而番单里的进度是「这一季看到第几集」。
 *
 * 播出日期是日本的日期，「今天」也按东京时间算 —— 否则深夜档会差一天。
 */
import { getDb } from './db.js';

/** 东京时间的今天，YYYY-MM-DD */
export const tokyoToday = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
/** YYYY-MM-DD 加减天数 */
export const addDays = (ymd, k) => new Date(Date.parse(ymd + 'T00:00:00Z') + k * 86400000).toISOString().slice(0, 10);

export function upsertEpisodes(db, list) {
  const st = db.prepare(`INSERT INTO bgm_episode (id, subject_id, sort, name, name_cn, airdate, duration)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET subject_id = excluded.subject_id, sort = excluded.sort, name = excluded.name,
      name_cn = excluded.name_cn, airdate = excluded.airdate, duration = excluded.duration`);
  for (const e of list)
    st.run(e.id, e.subject_id, e.sort ?? null, e.name || null, e.name_cn || null, e.airdate || null, e.duration || null);
  return list.length;
}

/** 一部番的正片分集（观看页选集用）：第几集、标题、播出日期 */
export function episodeList(animeId) {
  const db = getDb();
  const a = db.prepare('SELECT bgm_id FROM anime WHERE id = ?').get(animeId);
  if (!a?.bgm_id) return [];
  return db.prepare(`SELECT row_number() OVER (ORDER BY sort, id) AS n, name, name_cn, airdate
    FROM bgm_episode WHERE subject_id = ? ORDER BY sort, id`).all(a.bgm_id);
}

/**
 * 往后多算 AIRED_AHEAD 天：网络先行配信比 Bangumi 记的电视播出日早一两天 —— 转生就是剑 第二季
 * 第 3 集 bgm 记 10/21，10/20 片源站上已经有了，详情页上限却还是 2（#98，主人 2026-10-20 报）。
 * 首页「未看 N 集」和详情页进度上限必须是同一个口径（#103：原来只有详情页加了容差）
 */
export const AIRED_AHEAD = 2;

/**
 * 每部番：已播几集、总共几集（按 Bangumi 正片分集算），以及今天（东京时间）播的那一集。
 *
 * 总集数 / 已播怎么和 anime.episodes 对齐（#104：「已看 0/6 · 未看 12 集」）：
 *   · 这个 bgm 条目只挂着这一张卡 → 以 Bangumi 为准（AOD 已停更，「在超市后门吸烟的二人」它记 6 集，实际播了 12 集）
 *   · 多张卡共用一个 bgm 条目（Fate/Zero 两季合成一个条目共 25 集，AOD 拆成 13 + 12）→ 分集表说不清是哪一季的，
 *     总集数用这张卡自己的，已播封顶到它
 * @param {number[]} ids
 * next：下一集（第 aired + 1 集）的集号和播出日，「已追到第 N 集 · 10/28 周三更新」用（$lib/nextEp.js）
 * @returns {Map<number, { aired: number, total: number|null, todayEp: { n, name, name_cn } | null,
 *                        next: { n: number, airdate: string|null } | null }>}
 */
export function episodeStatus(ids, today = tokyoToday()) {
  const out = new Map();
  if (!ids.length) return out;
  const db = getDb();
  const cards = db.prepare(`SELECT a.id, a.episodes, a.bgm_id, coalesce(a.status_eff, a.status) AS st,
      (SELECT count(*) FROM anime b WHERE b.bgm_id = a.bgm_id AND b.is_stub = 0) AS shared
    FROM anime a WHERE a.id IN (${ids.map(() => '?').join(',')}) AND a.bgm_id IS NOT NULL`).all(...ids);
  const eps = db.prepare(`SELECT row_number() OVER (ORDER BY sort, id) AS n, name, name_cn, airdate
    FROM bgm_episode WHERE subject_id = ? ORDER BY sort, id`);
  const until = addDays(today, AIRED_AHEAD);
  for (const c of cards) {
    const list = eps.all(c.bgm_id);
    if (!list.length) continue;
    const own = c.episodes > 0 ? c.episodes : null;
    const total = c.shared > 1 ? own : Math.max(own ?? 0, list.length);
    // 没有播出日期的分集：作品已完结就算已播。老作品（1995 年的攻壳剧场版）Bangumi 分集常常没有日期，
    // 原来一律不算 → 已播 0 → 详情页写「尚未开播」（2026-10-21）。有日期的照旧按日期（#98 先行配信容差）
    const done = c.st === 'FINISHED';
    const aired = Math.min(list.filter((e) => (e.airdate ? e.airdate <= until : done)).length, total ?? Infinity);
    const t = list.find((e) => e.airdate === today && (!total || e.n <= total));
    const nx = list[aired] && (!total || list[aired].n <= total) ? list[aired] : null;
    out.set(c.id, { aired, total, todayEp: t ? { n: t.n, name: t.name, name_cn: t.name_cn } : null,
                    next: nx ? { n: nx.n, airdate: nx.airdate ?? null } : null });
  }
  return out;
}

/**
 * 详情页进度条 / 观看页起始集用：连载中（已播 < 总集数）→ { aired, total, next }；没有分集数据或已经播完 → null（照旧用 anime.episodes）
 */
export function airedCount(animeId, today = tokyoToday()) {
  const s = episodeStatus([animeId], today).get(animeId);
  return s && s.total && s.aired < s.total ? { aired: s.aired, total: s.total, next: s.next } : null;
}

/**
 * 我番单里（在看 / 想看）每部番的已播 / 总集数 / 今天那一集。
 * 首页「今天更新」和「我在追的」的「未看 N 集」都用它（后者原来拿总集数减进度，在播的番会把还没播的也算进去）
 */
export function airedForMine(today = tokyoToday()) {
  const ids = getDb().prepare(`SELECT ue.anime_id AS id FROM user_entry ue WHERE ue.status IN ('watching', 'plan')`).all().map((r) => r.id);
  return episodeStatus(ids, today);
}

/** 今天更新：我在看 / 想看的番里，今天（东京时间）播出新一集的 */
export function todayUpdates() {
  const aired = airedForMine();
  const ids = [...aired].filter(([, v]) => v.todayEp).map(([id]) => id);
  if (!ids.length) return [];
  const rows = getDb().prepare(`
    SELECT a.id, a.title, a.title_ja, a.title_cn, a.type, a.year, a.episodes, a.thumbnail, a.picture, a.cover_dead,
           a.bgm_score, a.bgm_votes, a.is_short, coalesce(a.status_eff, a.status) AS status_eff,
           ue.status AS my_status, ue.current_episode, ue.my_score
    FROM anime a JOIN user_entry ue ON ue.anime_id = a.id
    WHERE a.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return rows.map((r) => ({ ...r, ep: aired.get(r.id).todayEp }))
    .sort((x, y) => (x.my_status === 'watching' ? 0 : 1) - (y.my_status === 'watching' ? 0 : 1));
}
