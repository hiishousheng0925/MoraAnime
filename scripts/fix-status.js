/**
 * 推导有效播出状态 anime.status_eff。
 *
 * 为什么需要：AOD 的 status 只在快照那一刻可信。本地快照是 2026-07-04
 * （上游最新也是这个 tag，刷新没用），于是出现 44 条「季度早已结束却还标 UPCOMING」
 * 的条目 —— 筛「未播出」会筛出《来点兔子吗》《火影忍者》这种早就播完的番。
 *
 * 优先级：
 *   1. bangumi 的放送开始/结束日期（事实数据，从 infobox 抓的「放送开始」「播放结束」）
 *        有结束日且已过 → FINISHED
 *        开始日在未来 → UPCOMING
 *        开始日在【近 12 个月内】且无结束日 → ONGOING
 *        ⚠️ 「无结束日」不能单独当作还在播 —— 单集 OVA / 老番的 infobox 普遍没有
 *        放送结束，早期版本因此把 1990 年的 OVA 判成「更新中」。所以必须加时间窗。
 *   2. 没有 bgm 日期时，才退回按季度反推：
 *        季度尚未开始 → UPCOMING ／ 结束超过 3 个月 → FINISHED ／ 其余 → ONGOING
 * AOD 说 FINISHED 的照抄；说 ONGOING 的，在没有可信 bgm 日期时按集数估算是否早已播完（见 5）。
 */
import { getDb, initSchema, tx } from '../src/lib/server/db.js';

const START = { WINTER: 1, SPRING: 4, SUMMER: 7, FALL: 10 };
const END   = { WINTER: 3, SPRING: 6, SUMMER: 9, FALL: 12 };

const db = getDb();
initSchema(db);

const now = new Date();
const Y = now.getFullYear(), M = now.getMonth() + 1;
/** 距今多少个月（正数=过去） */
const monthsAgo = (y, m) => (Y - y) * 12 + (M - m);

const rows = db.prepare('SELECT id, status, year, season, episodes, bgm_air_start, bgm_air_end FROM anime').all();
const upd = db.prepare('UPDATE anime SET status_eff = ? WHERE id = ?');
const tally = {};

tx(db, () => {
  for (const r of rows) {
    let eff = r.status;
    const today = now.toISOString().slice(0, 10);
    /**
     * 1) bangumi 的事实日期优先 —— 但先要和 AOD 的年份对得上才算可信。
     *
     * ⚠️ bgm 的 subject 是「整部作品」，第二季/第三季往往匹配到同一个 subject，
     * 拿回来的是【第一季】的放送日期。实测：
     *   落语朱音 第二季（2027 冬）air=2026-04-04 → 被算成已完结
     *   葬送的芙莉莲 第三季（2027 秋）air=2026-01-16 → 已完结
     *   一拳超人（2027）air=2015-10-04 → 已完结
     * 反向也有：迷宫饭（AOD 写 2017 夏）air=2027-10-01 → 被算成未上映。
     * 所以日期的年份和 AOD 年份差超过 1 年就不采信，退回按季度推导。
     */
    const airYear = (d) => (d ? +String(d).slice(0, 4) : null);
    const trust = (d) => {
      const ay = airYear(d);
      return !!ay && (!r.year || Math.abs(ay - r.year) <= 1);
    };
    const airStart = trust(r.bgm_air_start) ? r.bgm_air_start : null;
    const airEnd = trust(r.bgm_air_end) ? r.bgm_air_end : null;

    const RECENT = new Date(now.getTime() - 365 * 864e5).toISOString().slice(0, 10);
    if (airEnd && airEnd <= today) eff = 'FINISHED';
    else if (airStart && airStart > today) eff = 'UPCOMING';
    else if (airStart && airStart <= today && !airEnd && airStart >= RECENT) eff = 'ONGOING';
    // 2) 没有 bgm 日期时才按季度反推。
    //    ⚠️ 必须先确认季度是真季度：AOD 里有 season='UNDEFINED'（2026/2027 各上百条），
    //    它是真值，会让下面的分支跑起来，而 START['UNDEFINED'] 是 undefined →
    //    monthsAgo 得到 NaN → 两个比较都为 false → 一路掉进 else 判成 ONGOING。
    //    实测 62 条 2027 年的番被标成「更新中」，还有 1 条标成「已完结」。
    else if (r.status === 'UPCOMING' && r.year && START[r.season] !== undefined) {
      const startAgo = monthsAgo(r.year, START[r.season]);
      const endAgo = monthsAgo(r.year, END[r.season]);
      if (startAgo < 0) eff = 'UPCOMING';        // 还没开播
      else if (endAgo > 3) eff = 'FINISHED';     // 结束超过一个 cour
      else eff = 'ONGOING';                      // 正在播 / 刚结束
    }
    // 3) AOD 说未上映、又没有日期也没有可用季度时，只能靠年份：
    //    今年及以后 → 信 AOD 的未上映；去年及更早 → 快照过期了，按已完结算
    else if (r.status === 'UPCOMING' && r.year) {
      eff = r.year >= Y ? 'UPCOMING' : 'FINISHED';
    }
    // 4) 年份还在未来、又没有任何播出日期能反驳 → 一律未上映。
    //    上游偶有自相矛盾的条目（实测 1 条：AOD 把 2027 年的《The Bugle Call》
    //    标成 FINISHED）。年份比状态可信，而且「未上映」是更保守的呈现。
    /**
     * 年份还在未来 → 一律未上映，连 bgm 的日期也不采信。
     *
     * 原来只在「没有任何 bgm 日期」时才这么兜。可是 bgm 的 subject 是整部作品，
     * 第二季/第三季常常匹配到同一个 subject，拿回来的是上一季的日期 ——
     * 落语朱音 第二季（2027 冬）拿到 2026-04-04~06-20、葬送的芙莉莲 第三季（2027 秋）
     * 拿到 2026-01-16~03-27，于是 2027 年的番被算成「已完结」。
     * 年份比日期可信，而「未上映」是更保守的呈现。
     */
    /**
     * 5) AOD 说 ONGOING、又没有可信的 bgm 日期 → 按「开播季度 + 集数」估算是否早已播完（#21、#3）。
     *
     * AOD 快照停在 2026-07-04 且上游已归档（#1），那一刻标着 ONGOING 的番会永远 ONGOING：
     * dev.db 里 2026 冬季 ≤13 集仍是 ONGOING 的 38 部、春季 57 部；2020 年以前的还有 72 条
     * （Prism Nana 2015 OVA、6HP 2016…）。它们进不了快速标记的出题池（要求 FINISHED）。
     * 估算：每 13 集 ≈ 一个季度；估算的完结月份已经过去 3 个月以上 → FINISHED。
     * 开播超过 3 年、集数 <100 的也按完结算（排掉柯南 / 海贼这类长篇连载）。
     * 集数未知（0 / NULL）的不猜，保持 ONGOING —— 那多半是真的长篇或集数未定的新番。
     */
    // 有可信的开播日、没有结束日也一样估：bgm 数据匹配后从不刷新（#3），结束日永远是空的
    // （刃牙道 13 集、2026-02 开播，到 10 月还挂着「更新中」）。有开播日就用它的年月起算。
    if (eff === 'ONGOING' && !airEnd && r.episodes > 0 && r.episodes < 100 && (airStart || r.year)) {
      // 取 bgm 开播日和 AOD 季度起点里【较晚】的那个：续作常匹配到前一季的 bgm 条目，
      // 拿回来的开播日是上一季的（黑化吧！圣女大人 第二季 2026 秋 → 2025-07），只用它会把在播番判完结
      const fromAod = r.year && START[r.season] ? [r.year, START[r.season]] : null;
      const fromBgm = airStart ? [airYear(airStart), +String(airStart).slice(5, 7) || 1] : null;
      const later = (x, y) => (!x ? y : !y ? x : (x[0] * 12 + x[1] >= y[0] * 12 + y[1] ? x : y));
      const [sy, sm] = later(fromBgm, fromAod) ?? [r.year, 1];
      const cours = Math.max(1, Math.ceil(r.episodes / 13));
      const endAgo = monthsAgo(sy, sm + cours * 3 - 1);
      if (endAgo > 3 || sy <= Y - 3) eff = 'FINISHED';
    }
    if (r.year && r.year > Y) eff = 'UPCOMING';
    upd.run(eff, r.id);
    const src = (airStart || airEnd) ? 'bgm' : '季度推导';
    tally[`${r.status}→${eff}${r.status !== eff ? ` (${src})` : ''}`] =
      (tally[`${r.status}→${eff}${r.status !== eff ? ` (${src})` : ''}`] ?? 0) + 1;
  }
});

console.log('📺 状态修正结果：');
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  const [from, to] = k.split('→');
  console.log(`  ${from.padEnd(11)} → ${to.padEnd(11)} ${String(v).padStart(6)}${from !== to ? '   ← 已修正' : ''}`);
}
const c = (s) => db.prepare(s).get().c;
console.log('\n修正后各状态数量（is_stub=0）：');
for (const st of ['FINISHED', 'ONGOING', 'UPCOMING', 'UNKNOWN'])
  console.log(`  ${st.padEnd(10)} ${c(`SELECT count(*) c FROM anime WHERE is_stub=0 AND status_eff='${st}'`)}`);

/**
 * 自检：UPCOMING 里不应再有「季度已过」的。
 * ⚠️ 但要排掉「bgm 说档期在未来」的那些 —— 那是我们刻意采信 bgm 的结果：
 * AOD 的 season 常常是公布档期（愚者之夜写 2026 冬，bgm 说 2026-11-26 才上），
 * 这种 UPCOMING 是对的，不该算异常。这条自检要抓的是「季度推导出的错」。
 */
const bad = db.prepare(`SELECT count(*) c FROM anime WHERE is_stub=0 AND status_eff='UPCOMING'
  AND year IS NOT NULL AND season IN ('WINTER','SPRING','SUMMER','FALL')
  AND (bgm_air_start IS NULL OR bgm_air_start <= date('now'))
  AND (year < ? OR (year = ? AND CASE season WHEN 'WINTER' THEN 1 WHEN 'SPRING' THEN 4
                                             WHEN 'SUMMER' THEN 7 ELSE 10 END < ?))`).get(Y, Y, M).c;
console.log(`\n自检：UPCOMING 中「季度已开始」的条目 ${bad} 条 ${bad === 0 ? '✅' : '❌'}`);
// 反向自检：年份还在未来的，不可能已经开播或播完
const future = db.prepare(`SELECT count(*) c FROM anime WHERE is_stub=0
  AND year > ? AND status_eff IN ('ONGOING','FINISHED')`).get(Y).c;
console.log(`自检：未来年份却标成更新中/已完结的条目 ${future} 条 ${future === 0 ? '✅' : '❌'}`);
const oldOngoing = db.prepare(`SELECT count(*) c FROM anime WHERE is_stub=0 AND status_eff='ONGOING'
  AND ((bgm_air_start IS NOT NULL AND bgm_air_start < date('now','-2 year'))
       OR (bgm_air_start IS NULL AND year < ?))`).get(Y - 2).c;
console.log(`自检：ONGOING 中「开播超过 2 年」的条目 ${oldOngoing} 条 ${oldOngoing === 0 ? '✅' : '⚠️ 多为长篇连载（柯南/海贼），属正常'}`);
db.prepare(`INSERT INTO sync_log (kind,started_at,finished_at,items,status)
            VALUES ('fix_status',datetime('now'),datetime('now'),?,'ok')`)
  .run(c("SELECT count(*) c FROM anime WHERE status_eff != status"));
