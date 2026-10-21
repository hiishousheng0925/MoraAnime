/** 题材三槽位（包含 / 任一 / 排除）的移动与摘要：目录页、番单页共用 urlBuild.js 里这两个函数 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveGenre, genreSummary } from '../../src/lib/urlBuild.js';

const F = (genres = [], genresAny = [], genresNot = []) => ({ genres, genresAny, genresNot });

test('放进新槽位时从其他槽位移除', () => {
  assert.deepEqual(moveGenre(F(['恋爱'], [], []), 'ng', '恋爱'), { g: [], any: [], ng: ['恋爱'] });
  assert.deepEqual(moveGenre(F([], ['热血'], ['恋爱']), 'g', '热血'), { g: ['热血'], any: [], ng: ['恋爱'] });
});

test('已在目标槽位 = 移除', () => {
  assert.deepEqual(moveGenre(F(['恋爱', '校园']), 'g', '恋爱'), { g: ['校园'], any: [], ng: [] });
});

test('摘要格式与截断', () => {
  assert.equal(genreSummary(F()), null);
  assert.equal(genreSummary(F(['A', 'B'], ['C', 'D'], ['E'])), 'A+B (C|D) −E');
  const long = genreSummary(F(['恋爱喜剧', '校园日常', '奇幻冒险', '科幻机战', '运动竞技']));
  assert.equal(long.length, 18);
  assert.ok(long.endsWith('…'));
});
