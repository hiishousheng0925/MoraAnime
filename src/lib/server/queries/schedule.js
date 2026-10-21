/**
 * 放送表。两个口径：
 *  mine  = 我标为「在看」的（每天真正会看的那一屏）
 *  all   = 当季所有在播的（挑新番时才用）
 * 数据来自 bgm 实时放送表（AOD 离线库差约 2 个月，做不了这个）。
 *
 * 每条附上推算的放送进度（2026-10-18 主人要「看得出这周更新到第几集」）：
 *   aired      按开播日每周一集推算的「已更新到第几集」（未开播 = 0）；碰上停播 / 一次两集会偏，是推算值
 *   airsToday  今天是不是更新日（开播日起每 7 天）
 *   startsIn   还有几天开播（已开播为 null）
 *   finished   推算已经播完（连载长番不会是 true，见 airInfo）
 *   behind     在看的番：已更新 − 我的进度（> 0 才有）
 * 同一天里「在看」的排最前，其余按人气；hide_nsfw 开着时不列 NSFW。
 *
 * 国创（is_jp=0）不进「本季全部」—— 和目录 / 排行 / 季度一个口径（bgm 日历本身不分产地，
 * 周五里会冒出罗小黑战记）。但用户自己番单里在看 / 想看的照常列（和首页「今天更新」同一个口径）：
 * 那是他自己加的，「我在追的」也不滤。
 */
import { getDb } from '../db.js';
import { yearWindow, hideNsfw } from './prefs.js';
import { SCHED_COLS } from './catalog.js';

const DAY = 86_400_000;
const localDay = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * 放送进度推算。返回 { aired, airsToday, startsIn, finished }。
 *
 * ⚠️ 连载长番（航海王、名侦探柯南）的 episodes 不是「总集数」，是数据源快照时的「已播集数」：
 * 航海王 1999-10-20 开播，按周推到今天是第 1400+ 集，比 episodes=1168 大，
 * 原来就此判成「已播完 · 共 1168 集」（2026-10 主人报的）。
 * 所以「推算集数超过 episodes」只有在**确实不在播**时才算播完；
 * 还是连载中（status_eff = ONGOING）或本周仍在 bgm 放送表上（bgm_weekday 有值，sync-calendar 每天重建）的，
 * episodes 只当「至少播到了这一集」，照常按星期算今天是否更新。
 */
export function airInfo(r, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(r.bgm_air_start ?? '');
  if (!m) return { aired: null, airsToday: false, startsIn: null, finished: false };
  const days = Math.round((localDay(now) - Date.UTC(+m[1], +m[2] - 1, +m[3])) / DAY);
  if (days < 0) return { aired: 0, airsToday: false, startsIn: -days, finished: false };
  const weekly = Math.floor(days / 7) + 1;
  const onAir = r.status_eff === 'ONGOING' || r.bgm_weekday != null;
  const over = r.episodes > 0 && weekly > r.episodes;
  if (over && !onAir) return { aired: r.episodes, airsToday: false, startsIn: null, finished: true };
  return { aired: over ? r.episodes : weekly, airsToday: days % 7 === 0, startsIn: null, finished: false };
}

export function schedule(scope = 'mine') {
  const db = getDb();
  const nsfw = hideNsfw() ? 'AND a.is_nsfw = 0' : '';
  const rows = scope === 'mine'
    ? db.prepare(`SELECT ${SCHED_COLS}, a.bgm_air_start, ue.status AS my_status, ue.current_episode, ue.my_score, ue.my_note
         FROM user_entry ue JOIN anime a ON a.id = ue.anime_id
         WHERE ue.status = 'watching'
         ORDER BY a.bgm_weekday, a.bgm_collection DESC`).all()
    // 「本季全部」也套显示年份窗口；「我在追的」不套 —— 那是主人自己的记录
    : db.prepare(`SELECT ${SCHED_COLS}, a.bgm_air_start, ue.status AS my_status, ue.current_episode, ue.my_score, ue.my_note
         FROM anime a LEFT JOIN user_entry ue ON ue.anime_id = a.id
         WHERE a.bgm_weekday IS NOT NULL AND a.is_stub = 0 ${nsfw}
           AND (a.is_jp = 1 OR ue.status IN ('watching', 'plan'))
           AND (a.year IS NULL OR (a.year >= ? AND a.year <= ?))
         ORDER BY a.bgm_weekday, a.bgm_collection DESC NULLS LAST`)
        .all(yearWindow().min, yearWindow().max);

  const now = new Date();
  for (const r of rows) {
    Object.assign(r, airInfo(r, now));
    r.behind = r.my_status === 'watching' && r.aired ? Math.max(0, r.aired - (r.current_episode ?? 0)) || null : null;
  }
  const days = Array.from({ length: 7 }, () => []);
  const noDay = [];
  for (const r of rows) (r.bgm_weekday ? days[r.bgm_weekday - 1] : noDay).push(r);
  // 在看的排最前（sort 是稳定的，同组里保持人气顺序）
  for (const d of days) d.sort((a, b) => (b.my_status === 'watching') - (a.my_status === 'watching'));
  return { days, noDay, total: rows.length };
}
