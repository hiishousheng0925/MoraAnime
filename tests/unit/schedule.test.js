/**
 * 放送表的放送进度推算（queries/schedule.js: airInfo）：开播日起每 7 天一集。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { airInfo } from '../../src/lib/server/queries/schedule.js';

const now = new Date(2026, 9, 18);   // 2026-10-18 周日

test('airInfo：今天更新 / 已更新 / 未开播 / 已播完', () => {
  assert.deepEqual(airInfo({ bgm_air_start: '2026-10-04', episodes: 12 }, now), { aired: 3, airsToday: true, startsIn: null, finished: false });
  assert.deepEqual(airInfo({ bgm_air_start: '2026-10-05', episodes: 12 }, now), { aired: 2, airsToday: false, startsIn: null, finished: false });
  assert.deepEqual(airInfo({ bgm_air_start: '2026-10-25', episodes: 12 }, now), { aired: 0, airsToday: false, startsIn: 7, finished: false });
  assert.equal(airInfo({ bgm_air_start: '2026-07-05', episodes: 12 }, now).aired, 12, '不超过总集数');
  assert.equal(airInfo({ bgm_air_start: '2026-07-05', episodes: 12 }, now).airsToday, false, '播完了就不算今天更新');
});

test('airInfo：集数未定照样推算；没有开播日给 null', () => {
  assert.equal(airInfo({ bgm_air_start: '2026-04-05', episodes: null }, now).aired, 29);
  assert.deepEqual(airInfo({ bgm_air_start: null, episodes: 12 }, now), { aired: null, airsToday: false, startsIn: null, finished: false });
});

test('airInfo：连载长番 episodes 是已播集数，推算超出也不算播完（航海王「已播完 · 共 1168 集」）', () => {
  // 航海王 1999-10-20（周三）开播，按周推到 2026-10-21 远超 1168
  const wed = new Date(2026, 9, 21);
  const op = { bgm_air_start: '1999-10-20', episodes: 1168, status_eff: 'ONGOING', bgm_weekday: 3 };
  assert.deepEqual(airInfo(op, wed), { aired: 1168, airsToday: true, startsIn: null, finished: false });
  assert.equal(airInfo(op, now).airsToday, false, '不是更新日');
  // 只要还在本周放送表上（bgm_weekday 有值）就不算播完，即使 status_eff 过期
  assert.equal(airInfo({ ...op, status_eff: 'FINISHED' }, wed).finished, false);
  // 都不沾：才是真播完
  assert.equal(airInfo({ ...op, status_eff: 'FINISHED', bgm_weekday: null }, wed).finished, true);
});

test('airText：连载中不显示「已播完」；只有 finished 才是', async () => {
  const { airText, airBadge } = await import('../../src/routes/schedule/air.js');
  const wed = new Date(2026, 9, 21);
  const op = { bgm_air_start: '1999-10-20', episodes: 1168, status_eff: 'ONGOING', bgm_weekday: 3 };
  assert.equal(airText(airInfo(op, wed)), '今天 第 1168 集');
  assert.equal(airText(airInfo(op, now)), '已更新至第 1168 集');
  assert.equal(airText(airInfo({ bgm_air_start: '2026-07-05', episodes: 12 }, now)), '已播完');
  assert.equal(airBadge(airInfo({ bgm_air_start: '2026-07-05', episodes: 12 }, now)), '已完结');
  assert.equal(airText({ startsIn: 1 }), '明天开播');
  assert.equal(airText({ startsIn: 7 }), '7 天后开播');
  assert.equal(airText({ aired: null }), null);
  assert.equal(airBadge({ aired: 3, airsToday: true }), '第 3 集');
});
