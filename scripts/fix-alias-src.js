/**
 * 一次性回填 anime_alias.src。
 *
 * src 这一列是后加的，历史行全是 NULL —— 而全量灌库现在按
 * `src <> 'bgm'` 决定删谁，NULL 会被当成 AOD 的一起删掉。
 * bgm 加进去的别名有一个可靠特征：它就等于该条目的 title_cn。
 * 其余一律来自 AOD dump。
 */
import { getDb, initSchema, DB_PATH } from '../src/lib/server/db.js';

const db = getDb();
initSchema(db);

const before = db.prepare('SELECT count(*) c FROM anime_alias WHERE src IS NULL').get().c;
const bgm = db.prepare(`
  UPDATE anime_alias SET src = 'bgm'
  WHERE src IS NULL AND alias = (SELECT title_cn FROM anime WHERE id = anime_alias.anime_id)`).run().changes;
const aod = db.prepare("UPDATE anime_alias SET src = 'aod' WHERE src IS NULL").run().changes;

console.log(DB_PATH);
console.log(`回填 ${before} 条：bgm ${bgm} / aod ${aod}`);
for (const r of db.prepare('SELECT src, count(*) c FROM anime_alias GROUP BY src ORDER BY c DESC').all())
  console.log(' ', r.src, r.c);
