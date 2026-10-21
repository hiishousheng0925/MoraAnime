/** dirBrowse.js：设置页截图位置「浏览…」在网站上列服务器的文件夹 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { listDirs, quickPlaces } from '../../src/lib/server/dirBrowse.js';

const root = mkdtempSync(join(tmpdir(), 'j-anime-dirs-'));
for (const d of ['b-shots', 'a-pics', '.hidden', '$Recycle.Bin', 'node_modules']) mkdirSync(join(root, d));
writeFileSync(join(root, 'file.txt'), 'x');
after(() => rmSync(root, { recursive: true, force: true }));

test('只列文件夹、按名字排、跳过隐藏 / 系统目录', () => {
  const r = listDirs(root);
  assert.deepEqual(r.dirs.map((d) => d.name), ['a-pics', 'b-shots']);
  assert.equal(r.dirs[0].path, join(root, 'a-pics'));
  assert.equal(r.parent, dirname(root));
});

test('空路径 = 此电脑（盘符或 /），上一级为 null', () => {
  const r = listDirs('');
  assert.equal(r.path, '');
  assert.equal(r.parent, null);
  assert.ok(r.dirs.length >= 1);
});

test('还不存在的文件夹：打开最近的、存在的上级（缺省截图位置第一次截图前不存在）', () => {
  const r = listDirs(join(root, 'nope', 'deeper'));
  assert.equal(r.path, root);
  assert.deepEqual(r.dirs.map((d) => d.name), ['a-pics', 'b-shots']);
  assert.equal(r.denied, undefined);
});

test('常用位置只给存在的', () => {
  assert.deepEqual(quickPlaces(root).map((q) => q.name), ['用户目录']);
});
