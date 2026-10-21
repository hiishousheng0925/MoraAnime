/** sync-plan.js：每日同步要不要顺手跑月度三步（从 sync-all.js 顶层抽出来的判断） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyDue, planMonthly, MONTHLY_DAYS } from '../../scripts/sync-plan.js';

const NOW = Date.parse('2026-10-21T04:30:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

test('从没跑过 / 到期 / 没到期', () => {
  assert.equal(monthlyDue(null, NOW), true);
  assert.equal(monthlyDue(daysAgo(MONTHLY_DAYS), NOW), true);
  assert.equal(monthlyDue(daysAgo(MONTHLY_DAYS - 1), NOW), false);
});

test('坏的时间戳当作该跑了（原来会让月度永远不再跑）', () => {
  assert.equal(monthlyDue('not-a-date', NOW), true);
});

test('--monthly 强制跑，--no-monthly 优先于一切', () => {
  assert.deepEqual(planMonthly(daysAgo(1), ['--monthly'], NOW), { monthly: true, forced: true });
  assert.deepEqual(planMonthly(null, ['--no-monthly'], NOW), { monthly: false, forced: false });
  assert.deepEqual(planMonthly(daysAgo(1), [], NOW), { monthly: false, forced: false });
});
