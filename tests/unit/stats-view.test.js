/**
 * 统计页展示层的纯函数：时间线合并（同一天同一部番一行）、日期标题、最长连续天数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, mergeDay, dayLabel } from '../../src/routes/stats/timeline.js';
import { longestRun } from '../../src/lib/heatmap.js';

const ep = (episode, episodes = 12) => ({ action: 'watch_ep', episode, episodes });
const st = (detail) => ({ action: 'status_change', detail });

test('describe：同一集重复 → ×N，接着改状态用 · 连接', () => {
  assert.equal(describe([ep(7), ep(7), st('watching')]), '看到第 7 集 ×2 · 改为在看');
});

test('describe：连号的集数并成区间；看到最后一集写「看完」', () => {
  assert.equal(describe([ep(5), ep(6), ep(7)]), '看到第 5–7 集');
  assert.equal(describe([ep(11), ep(12)]), '看完 · 第 11–12 集');
  assert.equal(describe([ep(12)]), '看完 · 全 12 集');
  assert.equal(describe([st('watching'), st('watching')]), '改为在看 ×2');
});

test('describe：不连号不合并，其他动作照写', () => {
  assert.equal(describe([ep(3), ep(7)]), '看到第 3 集 · 看到第 7 集');
  assert.equal(describe([{ action: 'triage' }, { action: 'clear' }]), '快速标记 · 移出番单');
});

test('mergeDay：按番分组、组内按时间先后描述、按最近一次排序', () => {
  // 接口给的是新 → 旧
  const items = [
    { id: 5, anime_id: 1, watched_at: '2026-10-20 23:00:00', ...st('watching') },
    { id: 4, anime_id: 2, watched_at: '2026-10-20 22:00:00', ...ep(3) },
    { id: 3, anime_id: 1, watched_at: '2026-10-20 21:00:00', ...ep(7) },
    { id: 2, anime_id: 1, watched_at: '2026-10-20 20:00:00', ...ep(7) }
  ];
  const rows = mergeDay(items);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.anime.id, r.text, r.time, r.key]), [
    [1, '看到第 7 集 ×2 · 改为在看', '23:00', 5],
    [2, '看到第 3 集', '22:00', 4]
  ]);
});

test('dayLabel：今天 / 昨天 / 星期；跨年带年份', () => {
  assert.deepEqual(dayLabel('2026-10-21', '2026-10-21'), { head: '10月21日', rel: '今天' });
  assert.deepEqual(dayLabel('2026-10-20', '2026-10-21'), { head: '10月20日', rel: '昨天' });
  assert.deepEqual(dayLabel('2026-10-19', '2026-10-21'), { head: '10月19日', rel: '周一' });
  assert.equal(dayLabel('2025-12-31', '2026-01-02').head, '2025年12月31日');
});

test('longestRun：逐日相连的最长一段，跨月 / 空列表', () => {
  assert.equal(longestRun([]), 0);
  assert.equal(longestRun(['2026-10-01']), 1);
  assert.equal(longestRun(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-03', '2026-10-04']), 3);
  assert.equal(longestRun(['2026-03-28', '2026-03-29', '2026-03-30']), 3, '夏令时切换那周不断档');
});
