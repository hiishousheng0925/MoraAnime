#!/usr/bin/env node
/**
 * 造测试用的番剧库数据包（模拟上游发了新版本 / 发了坏包）。只给 desktop/test/update.js 用。
 *
 *   node desktop/test/make-pack.js <基准库.db> <输出目录> --version <版本> [--mode ok|bad-sha|not-sqlite|broken-db]
 *        [--fold <输家id>:<赢家id>,…]   新版本里把输家折成 stub（is_stub=1, dup_of=赢家），模拟上游去重
 *
 *   ok          正常包
 *   bad-sha     manifest 里的 sha256 和包对不上（下载校验应拒收）
 *   not-sqlite  sha 对得上，但解压出来不是 SQLite（文件头检查应拒收）
 *   broken-db   sha 对得上、文件头也对，但库本身坏了（换库时 migrate / quick_check 应失败并回滚）
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants as Z } from 'node:zlib';

const [src, out, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const version = opt('--version', '2099.01.01');
const mode = opt('--mode', 'ok');
const folds = (opt('--fold', '') || '').split(',').filter(Boolean).map((x) => x.split(':').map(Number));
mkdirSync(out, { recursive: true });

const dbFile = join(out, `work-${version}.db`);
rmSync(dbFile, { force: true });
copyFileSync(src, dbFile);
{
  const d = new DatabaseSync(dbFile);
  d.exec('PRAGMA journal_mode = DELETE');
  for (const [loser, winner] of folds) d.prepare('UPDATE anime SET is_stub = 1, dup_of = ? WHERE id = ?').run(winner, loser);
  d.prepare("INSERT INTO meta (key, value) VALUES ('test_pack', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(version);
  d.close();
}
let raw = readFileSync(dbFile);
if (mode === 'not-sqlite') raw = randomBytes(1 << 20);
if (mode === 'broken-db') {
  // 保留文件头，把中间一大段页写成垃圾：文件头检查过得去，打开后 B 树是坏的
  raw = Buffer.from(raw);
  randomBytes(Math.min(raw.length - 8192, 64 * 1048576)).copy(raw, 8192);
}
const packed = brotliCompressSync(raw, { params: { [Z.BROTLI_PARAM_QUALITY]: 5, [Z.BROTLI_PARAM_LGWIN]: 24 } });
const file = `catalog-${version}.db.br`;
writeFileSync(join(out, file), packed);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const manifest = {
  format: 1, version, file, compression: 'br',
  sha256: mode === 'bad-sha' ? '0'.repeat(64) : sha(packed), size: packed.length,
  db: { sha256: sha(raw), size: raw.length }, syncedAt: null, exportedAt: new Date().toISOString()
};
writeFileSync(join(out, 'catalog.json'), JSON.stringify(manifest, null, 2));
rmSync(dbFile, { force: true });
console.log(`${mode} ${version} → ${join(out, 'catalog.json')}（${(statSync(join(out, file)).size / 1048576).toFixed(1)} MB）`);
