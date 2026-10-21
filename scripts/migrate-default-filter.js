/**
 * 一次性迁移：把 setting 表里的 default_filter:catalog 转成「我的筛选」里的一套，
 * 并标为默认。
 *
 * 起因：「默认」和「我的筛选」两个入口做类似的事 —— 解释起来要列表格，
 * 那就是概念冗余。合并后默认成为某套保存组合的属性。
 * 季度浏览没有「我的筛选」，它的 default_filter:seasons 保持不动。
 */
import { getDb, initSchema, DB_PATH } from '../src/lib/server/db.js';

const db = getDb();
initSchema(db);

const row = db.prepare("SELECT value FROM setting WHERE key='default_filter:catalog'").get();
console.log(DB_PATH);
if (!row?.value) {
  console.log('没有旧的目录默认，无需迁移');
  process.exit(0);
}
const exists = db.prepare('SELECT id FROM saved_filter WHERE filter_json = ?').get(row.value);
let id = exists?.id;
if (!id) {
  id = db.prepare("INSERT INTO saved_filter (name, filter_json) VALUES ('我的默认', ?) RETURNING id")
    .get(row.value).id;
  console.log(`已存为「我的默认」(id ${id})`);
} else {
  console.log(`已有相同组合 (id ${id})，直接标为默认`);
}
db.prepare('UPDATE saved_filter SET is_default = 0').run();
db.prepare('UPDATE saved_filter SET is_default = 1 WHERE id = ?').run(id);
db.prepare("DELETE FROM setting WHERE key='default_filter:catalog'").run();

console.log('\n迁移后：');
for (const r of db.prepare('SELECT id,name,is_default,filter_json FROM saved_filter ORDER BY id').all())
  console.log(`  ${r.is_default ? '★' : ' '} ${r.name}  ${r.filter_json}`);
