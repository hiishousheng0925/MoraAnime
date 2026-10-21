/**
 * 封面缓存体检与修复（2026-10-18 体检 DQ8 / DQ9）。默认只报告，带 --apply 才动库和文件。
 *
 * 四类问题：
 *   ① 反斜杠路径：封面路由原来用 path.join 拼相对路径，Windows 上存成了 `74\13274.jpg`，
 *      搬回 Mac / Linux 读不到。统一改成正斜杠（路由已改为直接存正斜杠）
 *   ② 库里记了路径、文件却不在：清掉路径，下次访问重新抓
 *   ③ 孤儿文件：文件在 covers/ 里但没有任何一行指向它。
 *      文件名就是番剧 id —— 该行还没有缓存路径就回填，否则（id 不存在、该行已指向
 *      别的文件）删掉
 *   ④ 已缓存的占位图（no_pic / anime-planet 默认图…，按 md5 认，见 coverPlaceholder.js）：
 *      删文件、清路径、清 cover_dead，下次访问由路由换 Bangumi 封面或显示占位样式
 *
 * 用法：node scripts/fix-covers.js            只报告
 *       node scripts/fix-covers.js --apply    执行
 * 库和封面目录都按 paths.js 解析（J_ANIME_DB / J_ANIME_DATA / J_ANIME_COVERS）。
 */
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../src/lib/server/db.js';
import { COVER_DIR } from '../src/lib/server/paths.js';
import { isPlaceholderBuf } from '../src/lib/server/coverPlaceholder.js';

const apply = process.argv.includes('--apply');
const db = getDb();
const sample = (list) => list.slice(0, 5).join('  ') + (list.length > 5 ? `  …共 ${list.length}` : '');

console.log(`封面目录 ${COVER_DIR}${apply ? '' : '（只报告，加 --apply 执行）'}`);

const rows = db.prepare('SELECT id, cover_local_path p FROM anime WHERE cover_local_path IS NOT NULL').all();
const ops = [];   // [说明, 执行函数]

// ① 反斜杠
const back = rows.filter((r) => r.p.includes('\\'));
console.log(`① 反斜杠路径 ${back.length} 条  ${sample(back.map((r) => r.p))}`);
const setPath = db.prepare('UPDATE anime SET cover_local_path = ? WHERE id = ?');
for (const r of back) { r.p = r.p.replaceAll('\\', '/'); ops.push(() => setPath.run(r.p, r.id)); }

// ② 路径指向的文件不在
const missing = rows.filter((r) => !existsSync(join(COVER_DIR, r.p)));
console.log(`② 文件不存在 ${missing.length} 条  ${sample(missing.map((r) => `#${r.id}`))}`);
for (const r of missing) ops.push(() => setPath.run(null, r.id));

// ③ 孤儿文件 + ④ 占位图
const byPath = new Map(rows.map((r) => [r.p, r.id]));
const rowOf = db.prepare('SELECT id, cover_local_path p FROM anime WHERE id = ?');
const resetRow = db.prepare('UPDATE anime SET cover_local_path = NULL, cover_dead = 0 WHERE id = ?');
const orphanFill = [], orphanDel = [], ph = [];
for (const d of existsSync(COVER_DIR) ? readdirSync(COVER_DIR) : []) {
  if (!statSync(join(COVER_DIR, d)).isDirectory()) continue;
  for (const f of readdirSync(join(COVER_DIR, d))) {
    const rel = `${d}/${f}`;
    const abs = join(COVER_DIR, rel);
    const id = +f.split('.')[0];
    if (isPlaceholderBuf(readFileSync(abs))) {
      ph.push(rel);
      ops.push(() => { unlinkSync(abs); if (byPath.has(rel)) resetRow.run(byPath.get(rel)); });
      continue;
    }
    if (byPath.has(rel)) continue;
    const row = Number.isInteger(id) ? rowOf.get(id) : null;
    if (row && !row.p) { orphanFill.push(rel); ops.push(() => setPath.run(rel, id)); }
    else { orphanDel.push(rel); ops.push(() => unlinkSync(abs)); }
  }
}
console.log(`③ 孤儿文件：回填路径 ${orphanFill.length} 个  ${sample(orphanFill)}`);
console.log(`           删除 ${orphanDel.length} 个  ${sample(orphanDel)}`);
console.log(`④ 已缓存的占位图 ${ph.length} 个  ${sample(ph)}`);

if (apply && ops.length) {
  db.exec('BEGIN');
  try { for (const op of ops) op(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  console.log(`✔ 已执行 ${ops.length} 项`);
}
const c = (s) => db.prepare(s).get().c;
console.log(`现状：已缓存 ${c('SELECT count(*) c FROM anime WHERE cover_local_path IS NOT NULL')} 条，` +
  `cover_dead ${c('SELECT count(*) c FROM anime WHERE cover_dead = 1')} 条`);
