/**
 * 2026-10-21 审核：片源解析链可取消、嗅探 / 截图并发闸、进行中请求去重
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limiter } from '../../src/lib/server/sources/limit.js';
import { cached } from '../../src/lib/server/sources/index.js';
import { AD } from '../../src/lib/server/sources/resolve.js';

const defer = () => { let ok; const p = new Promise((r) => { ok = r; }); return { p, ok }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

test('并发闸：超过 max 的排队，队列满了直接拒绝（BUSY）', async () => {
  const run = limiter(2, 1);
  const gates = [defer(), defer(), defer()];
  const jobs = gates.map((g, i) => run(() => g.p.then(() => i)));
  await tick();
  assert.deepEqual(run.stats(), { running: 2, queued: 1 });
  await assert.rejects(run(() => 'x'), (e) => e.code === 'BUSY');
  gates.forEach((g) => g.ok());
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2]);
  assert.deepEqual(run.stats(), { running: 0, queued: 0 });
});

test('并发闸：排队中被取消就出队，不占位置、也不会再跑', async () => {
  const run = limiter(1, 2);
  const gate = defer();
  const first = run(() => gate.p);
  const ac = new AbortController();
  let ran = false;
  const queued = run(() => { ran = true; }, ac.signal);
  await tick();
  assert.equal(run.stats().queued, 1);
  ac.abort();
  await assert.rejects(queued);
  assert.equal(run.stats().queued, 0, '取消的还挂在队列里');
  gate.ok(); await first; await tick();
  assert.equal(ran, false);
});

test('cached：同一个 key 同时只跑一次', async () => {
  let n = 0;
  const gate = defer();
  const fn = () => { n++; return gate.p; };
  const a = cached('t:dedupe', fn), b = cached('t:dedupe', fn);
  gate.ok('v');
  assert.deepEqual(await Promise.all([a, b]), ['v', 'v']);
  assert.equal(n, 1);
});

test('cached：一个等待者取消不连累另一个；全都取消才 abort 底下那次', async () => {
  const gate = defer();
  let inner;
  const fn = (signal) => { inner = signal; return gate.p; };
  const x = new AbortController(), y = new AbortController();
  const px = cached('t:abort', fn, { signal: x.signal, keep: (v) => v != null });
  const py = cached('t:abort', fn, { signal: y.signal, keep: (v) => v != null });
  x.abort();
  await assert.rejects(px);
  assert.equal(inner.aborted, false, '还有人在等，不能停');
  y.abort();
  await assert.rejects(py);
  assert.equal(inner.aborted, true, '没人等了还在跑');
  gate.ok(null);
});

test('AD 正则只有一份（resolve.js 导出，sniff.js 复用）', () => {
  assert.ok(AD.test('/static/adposter.mp4'));
  assert.ok(!AD.test('/video/ep01.mp4'));
});
