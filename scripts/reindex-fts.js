/**
 * 重建搜索索引。
 *
 * 为什么需要：FTS 索引在灌库时建立，那时中文名还没补。
 * 实测有 52% 的 bgm 中文名不在索引里 —— 搜中文名会是空结果。
 * 每次跑完 enrich-bgm.js 都应该跑一次这个。
 */
import { getDb, initSchema, tx } from '../src/lib/server/db.js';
import { segment } from '../src/lib/server/text.js';

const db = getDb();
initSchema(db);

/** --cn：只重建「有中文名」的那些行（补全跑完后用，秒级） */
const CN_ONLY = process.argv.includes('--cn');

const SELECT_NAMES = `
  SELECT a.id, a.title, a.title_ja, a.title_cn,
         (SELECT group_concat(alias, ' ') FROM anime_alias WHERE anime_id = a.id) AS aliases
  FROM anime a`;

/**
 * ⚠️ 全量重建必须整体一个事务（#42）：原来先 DROP 再分块插入，重建那几十秒里
 * 正式站的搜索结果是残缺的（索引里只有已插入的那部分）。WAL 模式下，
 * 事务提交前其它连接读到的一直是旧索引，提交后一次性换成新的。
 * 增量模式（--cn）只是逐行替换，照旧分块提交。
 */
if (CN_ONLY) console.log('🔁 增量重建（仅有中文名的条目）…');
else {
  console.log('🔁 全量重建 FTS 索引…');
  db.exec('BEGIN');
  db.exec('DROP TABLE IF EXISTS anime_fts');
  db.exec(`CREATE VIRTUAL TABLE anime_fts USING fts5(seg, tokenize='unicode61 remove_diacritics 2')`);
}
const chunk = CN_ONLY ? (fn) => tx(db, fn) : (fn) => fn();   // 全量时外层已经 BEGIN

const rows = db.prepare(CN_ONLY ? `${SELECT_NAMES} WHERE a.title_cn IS NOT NULL` : SELECT_NAMES).all();
const del = db.prepare('DELETE FROM anime_fts WHERE rowid = ?');
const ins = db.prepare('INSERT INTO anime_fts (rowid, seg) VALUES (?, ?)');
const CHUNK = 3000;
let n = 0;
for (let i = 0; i < rows.length; i += CHUNK) {
  chunk(() => {
    for (const r of rows.slice(i, i + CHUNK)) {
      if (CN_ONLY) del.run(r.id);
      ins.run(r.id, segment([r.title, r.title_ja, r.title_cn, r.aliases].filter(Boolean).join(' ')));
      n++;
    }
  });
  process.stdout.write(`\r   ${n}/${rows.length}`);
}
// 中途出错进程退出时，没提交的事务随连接关闭自动回滚 —— 旧索引原封不动
if (!CN_ONLY) db.exec('COMMIT');
db.exec("INSERT INTO anime_fts(anime_fts) VALUES('optimize')");
console.log(`\n✅ 索引重建完成：${n} 条`);
