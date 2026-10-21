/**
 * 「下一集」（$lib/nextEp.js）：详情页主按钮、首页 hero、番单书架、观看页起始集共用。
 * 起因：转生就是剑 第二季 已播 3 集、看到第 3 集，详情页写「继续看第 4 集」（主人 2026-10-21 #7）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextEp, nextAirText, startEp } from '../../src/lib/nextEp.js';

test('还没开始看：第 1 集「开始观看」', () => {
  assert.deepEqual(nextEp({ status: null, current: null, total: 12 }), { kind: 'start', ep: 1, label: '开始观看' });
  assert.deepEqual(nextEp({ status: 'plan', current: 0, total: 12, aired: 3 }), { kind: 'start', ep: 1, label: '开始观看' });
  assert.equal(nextEp({}).kind, 'start', '什么都不知道（访客、冷门番）');
});

test('连载中没追平：继续看第 N+1 集', () => {
  assert.deepEqual(nextEp({ status: 'watching', current: 2, total: 12, aired: 3 }),
    { kind: 'resume', ep: 3, label: '继续看第 3 集' });
  // 没有分集数据（aired 未知）：只能按总集数判断
  assert.equal(nextEp({ status: 'watching', current: 4, total: 12, aired: null }).ep, 5);
  // 总集数也未知
  assert.equal(nextEp({ status: 'watching', current: 40, total: null }).ep, 41);
});

test('#7 追平已播集数：不说「继续看第 N+1 集」，停在第 N 集', () => {
  const r = nextEp({ status: 'plan', current: 3, total: 12, aired: 3 });
  assert.deepEqual(r, { kind: 'caught', ep: 3, label: '已追到第 3 集' });
  assert.ok(!/第 4 集/.test(r.label));
  // 先行版看得比 Bangumi 记的还快（进度 > 已播）也是追平
  assert.equal(nextEp({ status: 'watching', current: 4, total: 12, aired: 3 }).kind, 'caught');
  assert.equal(nextEp({ status: 'watching', current: 4, total: 12, aired: 3 }).ep, 4);
  // 总集数未知的连载
  assert.equal(nextEp({ status: 'watching', current: 5, total: null, aired: 5 }).kind, 'caught');
});

test('一集都还没播：「尚未开播」', () => {
  assert.deepEqual(nextEp({ status: 'plan', current: 0, total: 12, aired: 0 }), { kind: 'upcoming', ep: 1, label: '尚未开播' });
});

test('看完：状态看完，或进度到了总集数 → 从头再看第 1 集', () => {
  assert.deepEqual(nextEp({ status: 'completed', current: 12, total: 12 }), { kind: 'rewatch', ep: 1, label: '从头再看' });
  // 快速标记的看完没有进度
  assert.equal(nextEp({ status: 'completed', current: 0, total: 24 }).kind, 'rewatch');
  // 状态还是在看、但进度已经到头（原来详情页显示「开始观看」、观看页却放第 12 集）
  assert.equal(nextEp({ status: 'watching', current: 12, total: 12, aired: null }).kind, 'rewatch');
  // aired ≥ 总集数 = 已经播完，不算追平
  assert.equal(nextEp({ status: 'watching', current: 12, total: 12, aired: 12 }).kind, 'rewatch');
  assert.equal(nextEp({ status: 'watching', current: 8, total: 12, aired: 12 }).ep, 9);
});

test('弃番 / 搁置：照样按进度接着看', () => {
  assert.equal(nextEp({ status: 'dropped', current: 5, total: 12 }).label, '继续看第 6 集');
  assert.equal(nextEp({ status: 'paused', current: 3, total: 12, aired: 3 }).kind, 'caught');
});

test('下一集更新时间：有日期写日期 + 星期，没有就写每周几', () => {
  assert.equal(nextAirText({ airdate: '2026-10-28', weekday: 3 }), '10/28 周三更新');
  assert.equal(nextAirText({ airdate: '2026-11-01' }), '11/1 周日更新');
  assert.equal(nextAirText({ weekday: 3 }), '每周三更新');
  assert.equal(nextAirText({ weekday: 7 }), '每周日更新');
  assert.equal(nextAirText({ airdate: '2026-10-28', verb: '开播' }), '10/28 周三开播');
  assert.equal(nextAirText({}), null);
  assert.equal(nextAirText({ airdate: '' , weekday: 0 }), null);
});

test('观看页起始集', () => {
  const list = (...ns) => (n) => ns.includes(n);
  // ?ep= 优先
  assert.equal(startEp({ asked: 7, status: 'watching', current: 2, total: 12, has: list(1, 2, 3) }), 7);
  // 追平、片源只有 1–3 集：停在第 3 集，不跳到不存在的第 4 集
  assert.equal(startEp({ status: 'plan', current: 3, total: 12, aired: 3, has: list(1, 2, 3) }), 3);
  // 追平、片源站已经有第 4 集（先行配信）：放第 4 集
  assert.equal(startEp({ status: 'plan', current: 3, total: 12, aired: 3, has: list(1, 2, 3, 4) }), 4);
  // 普通续看
  assert.equal(startEp({ status: 'watching', current: 4, total: 12, has: list(1, 2, 3, 4, 5) }), 5);
  // 没有分集数据、片源上还没有下一集：退回当前那一集，而不是夹到列表最后一条（可能是 PV）
  assert.equal(startEp({ status: 'watching', current: 4, total: 12, aired: null, has: list(1, 2, 3, 4) }), 4);
  // 看完从头
  assert.equal(startEp({ status: 'completed', current: 12, total: 12, has: list(1, 12) }), 1);
  assert.equal(startEp({ status: 'watching', current: 12, total: 12, has: list(1, 12) }), 1);
  // 没开始
  assert.equal(startEp({ status: null, current: 0, total: 12, has: list(1) }), 1);
});
