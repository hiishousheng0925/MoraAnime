/** YearPill 摘要：区间分支曾被单年分支截胡（from=2015&to=2020 显示成「2015」） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yearSummary } from '../../src/lib/yearSummary.js';

test('年份区间写成「下限–上限」', () => {
  assert.equal(yearSummary({ year: 2015, yearMax: 2020 }), '2015–2020');
  assert.equal(yearSummary({ year: null, yearMax: 2020, yearFloor: 1950 }), '1950–2020', '只有上限时用显示窗口下限');
  assert.equal(yearSummary({ year: null, yearMax: 2020 }), '≤2020');
});

test('单年 / 季度 / 年代', () => {
  assert.equal(yearSummary({ year: 2015, yearMax: 2015 }), '2015', '上下限相同 = 单年');
  assert.equal(yearSummary({ year: 2015 }), '2015');
  assert.equal(yearSummary({ year: 2015, season: 'FALL' }), '2015秋');
  assert.equal(yearSummary({ season: 'WINTER' }), '冬季');
  assert.equal(yearSummary({ decade: 1990 }), '1990s');
});

test('默认 / 空', () => {
  assert.equal(yearSummary({ year: 2026, isDefault: true }), null);
  assert.equal(yearSummary({}), null);
});
