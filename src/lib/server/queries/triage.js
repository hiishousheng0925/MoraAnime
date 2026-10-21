/**
 * 快速标记：出题队列、批次判定、撤销。
 * 判定为「看过」时会写一条 is_vague=1 的番单记录（见 setEntry）。
 */
import { getDb, tx } from '../db.js';
import { setEntry, UNTOUCHED_TRIAGE } from './user.js';
import { yearWindow } from './prefs.js';
import { memoByDb } from '../memo.js';
import { currentUid } from '../userCtx.js';

/**
 * 出题池的条件。三处（队列 / 年份分布 / 计数）必须用同一份，
 * 否则「待判定 12 部」点进去只有 8 部这种事就会发生。
 *   TV + 主流(source_count>=8) + 已完结 + 非成人，且还没进过番单。
 * 用修正后的状态：AOD 快照过期会把已完结的番标成未上映（实测 4 条），
 * 用原始 status 会把它们漏在池子外面。
 */
/**
 * 出题池的条件。写成函数是因为年份窗口来自设置（见 prefs.js: yearWindow）——
 * 窗口外的番出题了也点不进去看。
 * 年份直接拼进 SQL：值是 yearWindow() 夹过的整数，不是外部输入。
 */
const POOL = () => {
  const { min, max } = yearWindow();
  return `a.is_stub = 0 AND a.is_jp = 1 AND a.type = 'TV' AND a.source_count >= 8
    AND coalesce(a.status_eff, a.status) = 'FINISHED' AND a.is_nsfw = 0
    AND a.year >= ${min} AND a.year <= ${max}`;
};

/**
 * 「还没判定过」——出题队列只出这些。
 *
 * ⚠️ 不要改成「或者判定不是看过」来把漏标的调回来：那样提交一批之后，这 24 部
 * 仍然满足条件（又被写成 not_seen），排序也没变，下一批还是同样的 24 部，
 * 队列永远翻不动。要把漏标的调回来只能靠显式重置（见 resetNotSeen）。
 */
const UNDECIDED = 't.anime_id IS NULL';

/** 快速标记队列 —— 解决「观看记录纯靠记忆」的冷启动。
 *  按 bgm 收藏数降序：让最可能看过的番先出现，每次点击的回忆收益最大化 */
export function triageQueue({ limit = 24, yearMin = null, yearMax = null } = {}) {
  const db = getDb();
  const w = [POOL(), UNDECIDED, 'ue.anime_id IS NULL'];
  const p = [];
  if (yearMin) { w.push('a.year >= ?'); p.push(yearMin); }
  if (yearMax) { w.push('a.year <= ?'); p.push(yearMax); }
  return db.prepare(`
    SELECT a.id, a.title, a.title_ja, a.title_cn, a.year, a.episodes, a.picture, a.thumbnail, a.cover_dead,
           a.bgm_score, a.bgm_votes, a.bgm_collection
    FROM anime a
    LEFT JOIN triage t ON t.anime_id = a.id
    LEFT JOIN user_entry ue ON ue.anime_id = a.id
    WHERE ${w.join(' AND ')}
    ORDER BY a.bgm_collection DESC NULLS LAST, a.source_count DESC, a.year DESC
    LIMIT ?`).all(...p, limit);
}
/** 快速标记队列里每一年还剩多少部 —— 用于逐年筛选，不显示空年份 */
export function triageYears() {
  return getDb().prepare(`
    SELECT a.year, count(*) c
    FROM anime a
    LEFT JOIN triage t ON t.anime_id = a.id
    LEFT JOIN user_entry ue ON ue.anime_id = a.id
    WHERE ${POOL()} AND ${UNDECIDED} AND ue.anime_id IS NULL
      AND a.year IS NOT NULL
    GROUP BY a.year ORDER BY a.year DESC`).all();
}
export function triageStats({ yearMin = null, yearMax = null } = {}) {
  const db = getDb();
  /**
   * ⚠️ 三个数字的口径必须和 triageQueue 一致（所以共用 POOL / UNDECIDED）：
   *   pool      符合出题条件的总量
   *   decided   已判定（triage 表里的）
   *   remaining 还能出题的数量 —— 必须直接查，不能用 pool − decided：
   *             已在番单里的番会被队列排除，却不计入 decided，做减法会多算。
   */
  // 这两个 count 各要 ~10ms，而根布局每次整页加载都调 —— 库没变就用上次的（见 memo.js）
  // 键里带账号和年份窗口：remaining 因人而异，窗口是个人设置（访客的存在 cookie 里，改了不动库、缓存不会自己失效）
  const { min, max } = yearWindow();
  const { pool, remaining } = memoByDb(`triage:pool:${currentUid()}:${min}-${max}`, () => ({
    pool: db.prepare(`SELECT count(*) c FROM anime a WHERE ${POOL()}`).get().c,
    remaining: db.prepare(`
      SELECT count(*) c FROM anime a
      LEFT JOIN triage t ON t.anime_id = a.id
      LEFT JOIN user_entry ue ON ue.anime_id = a.id
      WHERE ${POOL()} AND ${UNDECIDED} AND ue.anime_id IS NULL`).get().c
  }));
  const decided = db.prepare('SELECT count(*) c FROM triage').get().c;
  const seen = db.prepare("SELECT count(*) c FROM triage WHERE verdict='seen'").get().c;
  // notSeen 按当前年份筛选算 —— 重置按钮上要显示「点了会放回多少部」，
  // 而重置本身也是按同一个范围执行的（选了 2015 就只放回 2015 的）
  const notSeen = notSeenCount({ yearMin, yearMax });
  const lastBatch = db.prepare(`SELECT batch_id id, count(*) n,
      sum(verdict='seen') seen FROM triage WHERE batch_id IS NOT NULL
      GROUP BY batch_id ORDER BY batch_id DESC LIMIT 1`).get();
  return { pool, remaining, decided, seen, notSeen, lastBatch: lastBatch ?? null };
}

/** 判定为「没看过」的有多少部（可按年份限定） */
export function notSeenCount({ yearMin = null, yearMax = null } = {}) {
  const { where, p } = notSeenScope(yearMin, yearMax);
  return getDb().prepare(`SELECT count(*) c FROM triage t
    JOIN anime a ON a.id = t.anime_id WHERE ${where}`).get(...p).c;
}

/** 「没看过」的范围条件 —— 计数和重置必须用同一份，否则按钮上的数字和实际删掉的不一致 */
function notSeenScope(yearMin, yearMax) {
  const w = ["t.verdict <> 'seen'"];
  const p = [];
  if (yearMin) { w.push('a.year >= ?'); p.push(yearMin); }
  if (yearMax) { w.push('a.year <= ?'); p.push(yearMax); }
  return { where: w.join(' AND '), p };
}

/**
 * 把判定为「没看过」的放回队列（删掉那些判定记录），「看过」的一条不动。
 *
 * 为什么需要它：默认口径下判定过的永不再出现，所以标记时手滑漏掉的那部
 * 就再也见不到了。而「连没看过的一起出」这种开关做不了 —— 提交完还是同一屏，
 * 队列会卡死（见 UNDECIDED 的注释）。所以只能是一个显式动作。
 *
 * 不动 user_entry：verdict <> 'seen' 的行当初就没写番单记录（见 setTriage）。
 */
export function resetNotSeen({ yearMin = null, yearMax = null } = {}) {
  const db = getDb();
  const { where, p } = notSeenScope(yearMin, yearMax);
  const n = notSeenCount({ yearMin, yearMax });
  db.prepare(`DELETE FROM triage WHERE anime_id IN (
    SELECT t.anime_id FROM triage t JOIN anime a ON a.id = t.anime_id WHERE ${where})`).run(...p);
  return n;
}
export function nextBatchId() {
  const r = getDb().prepare('SELECT coalesce(max(batch_id),0)+1 n FROM triage').get();
  return r.n;
}
export function setTriage(animeId, verdict, batchId = null) {
  const db = getDb();
  db.prepare(`INSERT INTO triage_all (user_id,anime_id,verdict,batch_id) VALUES (uid(),?,?,?)
              ON CONFLICT(user_id,anime_id) DO UPDATE SET verdict=excluded.verdict,
                batch_id=excluded.batch_id, decided_at=datetime('now')`)
    .run(animeId, verdict, batchId);
  if (verdict === 'seen') {
    // 已经有用户自己的记录就不碰：否则会被改成「看完 + 快速标记」，下次撤销就能删掉它
    const cur = db.prepare('SELECT is_vague FROM user_entry WHERE anime_id = ?').get(animeId);
    if (!cur || cur.is_vague) setEntry(animeId, { status: 'completed', is_vague: 1, _action: 'triage' });
  } else {
    // not_seen / never_heard / skipped 都要清掉之前快速标记留下的模糊记录
    db.prepare(`DELETE FROM user_entry WHERE anime_id = ? AND ${UNTOUCHED_TRIAGE}`).run(animeId);
  }
}
/** 撤销最近一批 —— 快速标记的默认值是「没点的算没看过」，
 *  用户没看懂界面就点下一批的话，一屏 24 部会被永久排除。必须能撤。 */
export function undoLastBatch() {
  const db = getDb();
  const b = db.prepare('SELECT max(batch_id) id FROM triage WHERE batch_id IS NOT NULL').get();
  if (!b?.id) return { undone: 0, batchId: null };
  const rows = db.prepare('SELECT anime_id, verdict FROM triage WHERE batch_id = ?').all(b.id);
  const ids = rows.map((r) => r.anime_id);
  // 一批 = 一整屏，勾的和没勾的都是判定，撤销时一起回队列。
  // seen 单独回给前端 —— 「已撤销 24 部」容易让人以为撤的是自己勾的那几部
  const seen = rows.filter((r) => r.verdict === 'seen').length;
  tx(db, () => {
    for (const id of ids) {
      db.prepare(`DELETE FROM user_entry WHERE anime_id = ? AND ${UNTOUCHED_TRIAGE}`).run(id);
      db.prepare('DELETE FROM triage WHERE anime_id = ?').run(id);
    }
  });
  return { undone: ids.length, seen, batchId: b.id };
}
