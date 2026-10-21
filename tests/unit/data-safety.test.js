/**
 * 数据安全相关纯函数的单元测试（#40）：系列手排合并、折叠时番单合并、env 读取、
 * 发布时目录改名的回滚、备份清理只删自己的文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeUserOrder } from '../../src/lib/server/seriesOrder.js';
import { mergeEntries } from '../../src/lib/server/dedup.js';
import { loadEnvFile } from '../../src/lib/server/envFile.js';
import { renameAll } from '../../scripts/platform.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'j-anime-unit-'));

test('mergeUserOrder（#7）', () => {
  assert.deepEqual([...mergeUserOrder([1, 2, 3, 4], new Map([[3, 1], [1, 2], [2, 3]])).keys()], [3, 4, 1, 2]);
  assert.deepEqual([...mergeUserOrder([5, 1, 2], new Map([[2, 1], [1, 2]])).keys()], [5, 2, 1]);
  assert.equal(mergeUserOrder([1, 2], new Map()), null);
  const m = mergeUserOrder([1, 2, 3], new Map([[2, 1]]));
  assert.deepEqual([...m.values()], [1, 2, 3], '序号连续从 1 开始');
});

test('mergeEntries：保留用户动过的那条，空字段互补（#8）', () => {
  const triage = { status: 'completed', is_vague: 1, my_score: null, my_note: null, current_episode: 12, updated_at: '2026-02-01' };
  const mine = { status: 'watching', is_vague: 0, my_score: 8, my_note: '短评', current_episode: 5, updated_at: '2025-01-01' };
  const m = mergeEntries(triage, mine);
  assert.equal(m.status, 'watching');
  assert.equal(m.my_score, 8);
  assert.equal(m.is_vague, 0);
  // 都动过 → 取更新时间晚的为主，空字段用另一条补
  const a = { status: 'completed', is_vague: 0, my_score: 9, my_note: null, updated_at: '2026-03-01' };
  const b = { status: 'on_hold', is_vague: 0, my_score: 7, my_note: '旧短评', updated_at: '2026-01-01' };
  const m2 = mergeEntries(a, b);
  assert.equal(m2.status, 'completed');
  assert.equal(m2.my_score, 9);
  assert.equal(m2.my_note, '旧短评');
});

test('loadEnvFile：读进来、不覆盖已有的（#9）', () => {
  const d = tmp(), f = join(d, '.env');
  writeFileSync(f, '# 注释\nJA_UNIT_A=1\r\nJA_UNIT_B = "two words"\nJA_UNIT_C=keep\n');
  process.env.JA_UNIT_C = 'already';
  const loaded = loadEnvFile(f);
  assert.equal(process.env.JA_UNIT_A, '1');
  assert.equal(process.env.JA_UNIT_B, 'two words');
  assert.equal(process.env.JA_UNIT_C, 'already');
  assert.deepEqual(loaded.sort(), ['JA_UNIT_A', 'JA_UNIT_B']);
  assert.deepEqual(loadEnvFile(join(d, 'missing')), []);
  rmSync(d, { recursive: true, force: true });
});

test('renameAll：中途失败整组改回去，不留下没有 build/ 的状态（#46）', () => {
  const d = tmp();
  const cur = join(d, 'build'), next = join(d, 'build.next'), prev = join(d, 'build.prev');
  mkdirSync(cur); mkdirSync(next);
  writeFileSync(join(cur, 'v'), 'old'); writeFileSync(join(next, 'v'), 'new');
  // 第二步故意指向一个不存在的源 → 失败 → 第一步（build → build.prev）必须被撤回
  assert.throws(() => renameAll([[cur, prev], [join(d, 'nope'), cur]], { tries: 1 }));
  assert.ok(existsSync(join(cur, 'v')), 'build/ 还在');
  assert.ok(!existsSync(prev), 'build.prev 已撤回');
  renameAll([[cur, prev], [next, cur]]);
  assert.deepEqual(readdirSync(d).sort(), ['build', 'build.prev']);
  rmSync(d, { recursive: true, force: true });
});
