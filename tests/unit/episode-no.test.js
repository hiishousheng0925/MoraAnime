/**
 * 片源站集名 → 集号、倒序列表翻正（#93 DM84 的选集是 3 / 2 / 1）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { epNum, inOrder } from '../../src/lib/episodeNo.js';

test('epNum：常见写法', () => {
  assert.equal(epNum('第03集'), 3);
  assert.equal(epNum('第 12 话'), 12);
  assert.equal(epNum('03'), 3);
  assert.equal(epNum('EP07'), 7);
  assert.equal(epNum('先行03'), 3);
  assert.equal(epNum('HD中字'), null);
});

test('inOrder：倒序翻过来，正序和认不出集号的不动', () => {
  const e = (...ns) => ns.map((n) => ({ name: String(n), url: 'u' + n }));
  assert.deepEqual(inOrder(e(3, 2, 1)).map((x) => x.name), ['1', '2', '3']);
  assert.deepEqual(inOrder(e(1, 2, 3)).map((x) => x.name), ['1', '2', '3']);
  assert.deepEqual(inOrder(e('HD中字')).map((x) => x.name), ['HD中字']);
  assert.deepEqual(inOrder([{ name: 'PV' }, { name: '第02集' }, { name: '第01集' }]).map((x) => x.name), ['第01集', '第02集', 'PV']);
});
