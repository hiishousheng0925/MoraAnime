import { getDb, initSchema, DB_PATH } from '../src/lib/server/db.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = getDb({ create: true });   // 唯一允许新建空库的入口
initSchema(db);
const tables = db.prepare(
  `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`
).all().map((r) => r.name);
console.log(`✅ 数据库就绪: ${DB_PATH}`);
console.log(`   表: ${tables.join(', ')}`);
