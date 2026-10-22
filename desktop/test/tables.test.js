/**
 * 守着 desktop/catalog-tables.js 和网站的个人数据表定义对得上：
 * 上游新加了个人表而这里没跟上 → 导出会带出站主的数据、换库会丢客户端用户的数据。
 *
 *   node --test desktop/test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { PERSONAL_TABLES, migrateBefore, migrateAfter } from '../../src/lib/server/multiUser.js';
import { PERSONAL_ALL, ACCOUNT_TABLES, LOCAL_CONFIG, CLEAR_ON_EXPORT, CARRY_ON_SWAP, ANIME_REFS, KEEP_IF_EMPTY } from '../catalog-tables.js';

test('multiUser.js 的每张个人表都在清单里', () => {
  for (const t of PERSONAL_TABLES) assert.ok(PERSONAL_ALL.includes(`${t}_all`), `${t}_all 不在 PERSONAL_ALL`);
});

test('建出来的库里：带 user_id 的表都被导出清空、换库搬运', () => {
  const db = new DatabaseSync(':memory:');
  db.function('uid', { deterministic: true }, () => 0);
  // 和 db.js 的 initSchema 一样按分号切：依赖迁移列的索引建不了就跳过（这里只关心有哪些表）
  for (const st of readFileSync(new URL('../../src/lib/server/schema.sql', import.meta.url), 'utf8').split(';').map((x) => x.trim()).filter(Boolean))
    try { db.exec(st); } catch (e) { if (!/no such column/i.test(e.message)) throw e; }
  migrateAfter(db, migrateBefore(db));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of tables) {
    const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all(t).map((r) => r.name);
    if (!cols.includes('user_id')) continue;
    assert.ok(CLEAR_ON_EXPORT.includes(t), `${t} 有 user_id，导出时没清`);
    assert.ok(CARRY_ON_SWAP.includes(t), `${t} 有 user_id，换库时没搬`);
  }
  for (const t of [...ACCOUNT_TABLES, ...LOCAL_CONFIG]) assert.ok(tables.includes(t), `清单里的 ${t} 在库里不存在`);
});

test('导出清空和换库搬运是同一批表（观看站例外：随番剧库下发当默认值，换库仍搬本机的）', () => {
  assert.deepEqual([...CLEAR_ON_EXPORT, ...KEEP_IF_EMPTY].sort(), [...CARRY_ON_SWAP].sort());
  for (const t of KEEP_IF_EMPTY) assert.ok(!CLEAR_ON_EXPORT.includes(t) && CARRY_ON_SWAP.includes(t));
  for (const t of Object.keys(ANIME_REFS)) assert.ok(PERSONAL_ALL.includes(t));
});
