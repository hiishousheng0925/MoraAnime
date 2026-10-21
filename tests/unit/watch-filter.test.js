/** 「我的」多选筛选（目录 / 季度浏览共用）：参数解析与胶囊摘要 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickWatches, watchSummary, buildHref } from '../../src/lib/urlBuild.js';

const q = (s) => new URLSearchParams(s).getAll('watch');

test('没给参数 / 只有空值 → null（不筛）', () => {
  assert.equal(pickWatches(q('')), null);
  assert.equal(pickWatches(q('watch=')), null);
  assert.equal(pickWatches(undefined), null);
});

test('旧的单值链接照样认', () => {
  assert.deepEqual(pickWatches(q('watch=none')), ['none']);
  assert.deepEqual(pickWatches(q('watch=plan')), ['plan']);
});

test('多值：重复参数，保持顺序并去重', () => {
  assert.deepEqual(pickWatches(q('watch=none&watch=plan')), ['none', 'plan']);
  assert.deepEqual(pickWatches(q('watch=plan&watch=none&watch=plan')), ['plan', 'none']);
});

test('乱写的值丢掉；全是乱写 → null', () => {
  assert.deepEqual(pickWatches(q('watch=foo&watch=dropped')), ['dropped']);
  assert.equal(pickWatches(q('watch=foo&watch=constructor&watch=active')), null);
});

test('摘要和其它多选筛选同一格式', () => {
  assert.equal(watchSummary(null), null);
  assert.equal(watchSummary([]), null);
  assert.equal(watchSummary(['none', 'plan']), '未标记·想看');
  assert.equal(watchSummary(['on_hold']), '搁置');
});

test('URL 写回：多值写成重复参数，清空即去掉参数', () => {
  assert.equal(buildHref('/catalog', 'p=3', { watch: ['none', 'plan'] }), '/catalog?watch=none&watch=plan');
  assert.equal(buildHref('/seasons', 'watch=none&year=2026', { watch: null }), '/seasons?year=2026');
});
