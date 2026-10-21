/**
 * 我的记录：番单条目、进度、自定义标签、手动关联、系列顺序。
 * 写操作全部经 setEntry —— 它统一负责补集数、写 watch_log、判断动作类型。
 */
import { getDb, tx } from '../db.js';
import { WATCHED, WATCHED_EPS } from './stats.js';

export function myStats() {
  const db = getDb();
  const by = db.prepare('SELECT status, count(*) c FROM user_entry GROUP BY status').all();
  const m = Object.fromEntries(by.map((r) => [r.status, r.c]));
  // 番单「全部」tab 的数：五种状态合计，和页头「共 N 部」一致（原来不含搁置 / 弃番）
  m.active = by.reduce((n, r) => n + r.c, 0);
  /**
   * 侧栏的「累计 N 集」必须和统计页的「看过集数」是同一个数 ——
   * 原来这里自己写了一套（只算看完+在看、且对在看也按总集数补），
   * 结果侧栏 4389、统计页 4359，差 30 集（三部没填进度的在看番 12+6+12）。
   * 口径见 queries/stats.js: WATCHED / WATCHED_EPS
   */
  const eps = db.prepare(`
    SELECT coalesce(sum(${WATCHED_EPS}),0) c
    FROM user_entry ue JOIN anime a ON a.id=ue.anime_id
    WHERE ${WATCHED}`).get().c;
  const total = ['plan', 'watching', 'completed', 'on_hold', 'dropped']
    .reduce((n, k) => n + (m[k] ?? 0), 0);
  return { ...m, total, episodes: eps };
}
/** 我在追的 —— 首页主视图。ONGOING 的番算「未看几集」 */
export function watching() {
  const db = getDb();
  return db.prepare(`
    SELECT a.id, a.title, a.title_ja, a.title_cn, a.type, a.year, a.episodes, coalesce(a.status_eff, a.status) AS status,
           a.thumbnail, a.picture, a.cover_dead, a.bgm_weekday, a.bgm_score, a.bgm_votes, a.is_short,
           coalesce(a.status_eff, a.status) AS status_eff, ue.status AS my_status,
           ue.current_episode, ue.my_score,
           CASE WHEN a.episodes IS NOT NULL AND ue.current_episode IS NOT NULL
                THEN a.episodes - ue.current_episode END AS behind
    FROM user_entry ue JOIN anime a ON a.id = ue.anime_id
    WHERE ue.status = 'watching'
    ORDER BY behind DESC NULLS LAST, a.year DESC`).all();
}
export function setEntry(animeId, patch) {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM user_entry WHERE anime_id = ?').get(animeId);
  const total = db.prepare('SELECT episodes FROM anime WHERE id = ?').get(animeId)?.episodes ?? null;
  /**
   * is_vague = 「快速标记建的、之后用户没再动过」。撤销上一批 / 判成没看过时只删这种。
   * ⚠️ 用户只要改了状态、进度、分数、短评，这条就是用户自己的记录了，必须清掉标记 ——
   * 原来只有 +1 集会清，打分走 entry.patch 不清，结果「撤销上一批」把打过分的记录整条删了
   * （正式库 304 条快速标记记录里 269 条有评分）。
   */
  const userEdit = patch._action !== 'triage'
    && ['status', 'current_episode', 'my_score', 'my_note'].some((k) => patch[k] !== undefined);
  /**
   * 「想看」（或还没有条目）时记了进度 → 自动转「在看」（2026-10 主人报：详情页 +1 / 拖进度条到 3/3，
   * 状态还是「想看」）。放在这里统一，详情页、首页、观看页走哪条路都一样。
   * - 同一次请求显式传了 status 的以用户为准
   * - 看完 / 搁置 / 弃番改进度不动状态（重看、补记录）
   * - 到总集数不在这里自动改「看完」
   */
  const startWatching = patch.status === undefined && (cur?.status ?? 'plan') === 'plan'
    && patch.current_episode != null && patch.current_episode > 0;
  const next = {
    status: patch.status ?? (startWatching ? 'watching' : cur?.status ?? 'plan'),
    current_episode: patch.current_episode !== undefined ? patch.current_episode : (cur?.current_episode ?? null),
    my_score: patch.my_score !== undefined ? patch.my_score : (cur?.my_score ?? null),
    my_note: patch.my_note !== undefined ? patch.my_note : (cur?.my_note ?? null),
    is_vague: patch.is_vague !== undefined ? patch.is_vague : userEdit ? 0 : (cur?.is_vague ?? 0)
  };

  // 标「看完」就把集数补满 —— 否则详情页显示「未填 / 共 12 集」、进度条是空的，
  // 而我的统计那边 completed 一律按 coalesce(current_episode, a.episodes) 算，两处对不上。
  // 快速标记来的记录（is_vague=1）同样要补：is_vague 只决定撤销时能不能删，
  // 不该影响进度怎么显示。
  if (next.status === 'completed' && total && !next.current_episode) {
    next.current_episode = total;
  }
  // 从「看完」改成别的状态时，若集数正好等于总集数，说明是上面自动补的，退回未填
  if (cur?.status === 'completed' && next.status !== 'completed'
      && total && next.current_episode === total && patch.current_episode === undefined) {
    next.current_episode = null;
  }
  // upsert 只能写真表（视图不支持 ON CONFLICT，见 multiUser.js）
  db.prepare(`
    INSERT INTO user_entry_all (user_id,anime_id,status,current_episode,my_score,my_note,is_vague,finished_at)
    VALUES (uid(),@id,@status,@current_episode,@my_score,@my_note,@is_vague,
            CASE WHEN @status='completed' THEN coalesce((SELECT finished_at FROM user_entry WHERE anime_id=@id), datetime('now')) END)
    ON CONFLICT(user_id,anime_id) DO UPDATE SET
      status=excluded.status, current_episode=excluded.current_episode,
      my_score=excluded.my_score, my_note=excluded.my_note, is_vague=excluded.is_vague,
      finished_at=excluded.finished_at, updated_at=datetime('now')`)
    .run({ id: animeId, ...next });
  // 日志动作要和实际操作对得上：只动进度记 watch_ep，状态变了才记 status_change。
  // 之前一律记 status_change，时间线上会出现「改了状态 · 第 3 集」这种自相矛盾的文案。
  // episode 只在 watch_ep 时留 —— 标「看完」自动补满的集数不是用户填的，记上去是噪音。
  const action = patch._action || (!cur || next.status !== cur.status ? 'status_change' : 'watch_ep');
  const changed = !cur || ['status', 'current_episode', 'my_score', 'my_note']
    .some((k) => next[k] !== cur[k]);
  if (changed) {
    const ep = action === 'watch_ep' ? next.current_episode : null;
    /**
     * 同一部番、同一个动作、同一集，5 分钟内只记一条。
     *
     * 实测：主人拖进度条补集数时，同一部番留下了两条「第 12 集」的日志
     * （12:48:31 和 12:48:34），时间线上就是两行一模一样的记录，看着像重复动漫。
     * 成因不重要（拖动条的 change 事件、两个标签页、手抖都可能），
     * 记录层去重最省事，也不会丢掉真实的观看轨迹。
     */
    // 键里必须带 detail（新状态）—— 只按 action+episode 去重会把「在看 → 看完」
    // 当成上一条 status_change 的重复（两条的 episode 都是 null），状态变更就丢了
    const dup = db.prepare(`SELECT 1 FROM watch_log
      WHERE anime_id = ? AND action = ? AND coalesce(episode,-1) = coalesce(?,-1)
        AND coalesce(detail,'') = coalesce(?,'')
        AND watched_at > datetime('now', '-5 minutes') LIMIT 1`)
      .get(animeId, action, ep, next.status);
    if (!dup) {
      db.prepare(`INSERT INTO watch_log (anime_id,episode,action,detail) VALUES (?,?,?,?)`)
        .run(animeId, ep, action, next.status);
    }
  }
  return next;
}
/** 彻底清除我的记录 —— 之前用 status:null 走 setEntry，被 ?? 吃掉了，等于没生效 */
export function clearEntry(animeId) {
  const db = getDb();
  tx(db, () => {
    db.prepare('DELETE FROM user_entry WHERE anime_id = ?').run(animeId);
    db.prepare("INSERT INTO watch_log (anime_id,action,detail) VALUES (?,'clear',NULL)").run(animeId);
  });
  return null;
}
export function bumpEpisode(animeId, delta = 1) {
  const db = getDb();
  const a = db.prepare(`SELECT a.episodes, ue.current_episode, ue.status FROM anime a
                        LEFT JOIN user_entry ue ON ue.anime_id=a.id WHERE a.id=?`).get(animeId);
  if (!a) return null;
  let ep = (a.current_episode ?? 0) + delta;
  if (ep < 0) ep = 0;
  // episodes=0 是「集数未定」（AOD 对在播新番常这么写），不是「共 0 集」——
  // 拿它当上限会把 ep 夹回 0、再判成看完，在追的新番点一次 +1 就从首页消失
  const total = a.episodes > 0 ? a.episodes : null;
  if (total != null && ep > total) ep = total;
  // 加到最后一集仍自动「看完」（原有行为）；其余情况状态交给 setEntry：
  // 想看 / 无条目且进度 > 0 → 在看，看完 / 搁置 / 弃番不动（原来一律写成「在看」，弃番的番 +1 就回到了在看）
  const done = total != null && ep >= total;
  return setEntry(animeId, {
    current_episode: ep,
    ...(done ? { status: 'completed' } : {}),
    is_vague: 0,          // 手动记了集数，就不再是快速标记的模糊记录
    _action: 'watch_ep'
  });
}
/** 手动补关联（AOD 有 43.8% 的条目没有任何关系数据） */
export function linkAnime(aId, bId) {
  if (aId === bId) throw new Error('不能和自己关联');
  const db = getDb();
  const [x, y] = aId < bId ? [aId, bId] : [bId, aId];
  db.prepare('INSERT OR IGNORE INTO manual_relation (a_id,b_id) VALUES (?,?)').run(x, y);
}
export function unlinkAnime(aId, bId) {
  const db = getDb();
  const [x, y] = aId < bId ? [aId, bId] : [bId, aId];
  db.prepare('DELETE FROM manual_relation WHERE a_id=? AND b_id=?').run(x, y);
}
export const manualLinks = (id) => getDb().prepare(`
  SELECT b.id, b.title, b.title_cn, b.title_ja, b.year, b.type
  FROM manual_relation m
  JOIN anime b ON b.id = CASE WHEN m.a_id = ? THEN m.b_id ELSE m.a_id END
  WHERE m.a_id = ? OR m.b_id = ?`).all(id, id, id);
/**
 * 手动调整系列内的顺序。
 * 自动排的是「播出顺序」，但有些系列的官方推荐顺序既不是播出顺序也不是剧情顺序
 * （《物语》系列最典型）。所以留一个手动覆盖。月度重建系列时会保留它
 * （见 scripts/build-franchise.js + seriesOrder.js），新并进来的番插在播出顺序上的前一部后面。
 */
export function moveInSeries(animeId, dir) {
  const db = getDb();
  const me = db.prepare('SELECT franchise_id FROM franchise_member WHERE anime_id=?').get(animeId);
  if (!me) throw new Error('这部番不在任何系列里');
  const list = db.prepare(`SELECT anime_id, coalesce(user_order, release_order) o
    FROM franchise_member WHERE franchise_id=? ORDER BY o`).all(me.franchise_id);
  const i = list.findIndex((r) => r.anime_id === animeId);
  const j = i + (dir === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return false;
  [list[i], list[j]] = [list[j], list[i]];
  const upd = db.prepare('UPDATE franchise_member SET user_order=? WHERE franchise_id=? AND anime_id=?');
  tx(db, () => list.forEach((r, k) => upd.run(k + 1, me.franchise_id, r.anime_id)));
  return true;
}
/** 恢复自动的播出顺序 */
export function resetSeriesOrder(animeId) {
  const db = getDb();
  const me = db.prepare('SELECT franchise_id FROM franchise_member WHERE anime_id=?').get(animeId);
  if (!me) return false;
  db.prepare('UPDATE franchise_member SET user_order=NULL WHERE franchise_id=?').run(me.franchise_id);
  return true;
}

/**
 * 历史数据：快速标记建的记录，之后被用户打过分、写过短评或改过状态的，清掉 is_vague。
 * 写入路径已经会清（见 setEntry），这里补 setEntry 修好之前留下的。跑第二次是空操作。
 */
export function backfillTouchedVague() {
  // 迁移脚本里跑，没有登录态 —— 直接对所有账号的真表做
  return getDb().prepare(`UPDATE user_entry_all SET is_vague = 0
    WHERE is_vague = 1 AND NOT (${UNTOUCHED_TRIAGE})`).run().changes;
}
/**
 * 「快速标记建的、用户之后没动过」的记录 —— 撤销 / 判成没看过时唯一允许删的那种。
 * 删除处一律用它兜底，不只看 is_vague：哪怕标记没清干净，有分、有短评、改过状态的也删不掉。
 */
export const UNTOUCHED_TRIAGE = `is_vague = 1 AND status = 'completed'
  AND my_score IS NULL AND coalesce(my_note, '') = ''`;

/**
 * 把「看完」但集数为空的记录补满。
 *
 * 早先快速标记建的记录不补集数，于是同一条记录两处说法不一样：详情页显示
 * 「未填 / 共 12 集」加一条空进度条，我的统计那边却按 coalesce(current_episode,
 * a.episodes) 算进了累计集数。现在写入时就补（见 setEntry），这个函数负责补
 * 历史数据 —— 只碰 current_episode IS NULL 的行，跑第二次是空操作。
 */
export function backfillCompletedEpisodes() {
  return getDb().prepare(`
    UPDATE user_entry_all SET current_episode = (SELECT episodes FROM anime WHERE id = anime_id),
                          updated_at = datetime('now')
    WHERE status = 'completed' AND current_episode IS NULL
      AND coalesce((SELECT episodes FROM anime WHERE id = anime_id), 0) > 0`).run().changes;
}
