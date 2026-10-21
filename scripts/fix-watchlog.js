/**
 * 一次性回填：把历史 watch_log 的 action 修正。
 *
 * 旧版 setEntry 一律写 status_change，并把当时的 current_episode 一起记上，
 * 于是时间线出现「改了状态 · 第 19 集」这种自相矛盾的条目。
 * 判定规则（按番剧、按时间顺序走一遍）：
 *   detail（状态）和上一条相同  → 这次只动了进度 → watch_ep，保留集数
 *   detail 变了                → 真的改了状态   → status_change，集数清空
 *                                （「看完」时补满的集数不是用户填的，是噪音）
 * clear / triage / import 这些动作不碰。
 */
import { getDb, DB_PATH } from '../src/lib/server/db.js';

const db = getDb();
const rows = db.prepare(`SELECT id, anime_id, episode, action, detail FROM watch_log
                         WHERE action IN ('status_change','watch_ep')
                         ORDER BY anime_id, watched_at, id`).all();

const prev = new Map();
const fixes = [];
for (const r of rows) {
  const last = prev.get(r.anime_id);
  prev.set(r.anime_id, r.detail);
  const isProgress = last !== undefined && last === r.detail;
  const action = isProgress ? 'watch_ep' : 'status_change';
  const episode = isProgress ? r.episode : null;
  if (action !== r.action || episode !== r.episode) fixes.push({ id: r.id, action, episode });
}

const upd = db.prepare('UPDATE watch_log SET action=?, episode=? WHERE id=?');
db.exec('BEGIN');
for (const f of fixes) upd.run(f.action, f.episode, f.id);
db.exec('COMMIT');

console.log(`${DB_PATH}\n扫描 ${rows.length} 条，修正 ${fixes.length} 条`);
for (const r of db.prepare('SELECT action, count(*) c FROM watch_log GROUP BY action').all())
  console.log(' ', r.action, r.c);
