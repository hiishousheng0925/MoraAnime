/** playerUtil.js fullscreenToggle：连续双击时上一次切换没完成就不接新的（2026-10-23 客户端连点全屏卡死） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullscreenToggle } from '../../src/lib/ui/playerUtil.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('切换进行中、以及完成后 300ms 内的点击都忽略；之后才接下一次', async () => {
  let enters = 0, exits = 0;
  const el = { requestFullscreen: () => { enters++; return sleep(80).then(() => { globalThis.document.fullscreenElement = el; }); } };
  globalThis.document = { fullscreenElement: null, exitFullscreen: () => { exits++; return sleep(80).then(() => { globalThis.document.fullscreenElement = null; }); } };
  const toggle = fullscreenToggle(() => el);
  for (let i = 0; i < 5; i++) toggle();          // 连点 5 下
  assert.equal(enters, 1, '只进一次全屏');
  await sleep(200);                               // 切换已完成，但还在 300ms 冷却里
  toggle();
  assert.equal(exits, 0, '冷却期内不退');
  await sleep(250);
  toggle();
  assert.equal(exits, 1, '冷却过后正常退出');
  delete globalThis.document;
});

test('切换失败（被浏览器拒绝）也会放行，不会永远卡住', async () => {
  let n = 0;
  globalThis.document = { fullscreenElement: null };
  const toggle = fullscreenToggle(() => ({ requestFullscreen: () => { n++; return Promise.reject(new Error('denied')); } }));
  toggle();
  await sleep(350);
  toggle();
  assert.equal(n, 2);
  delete globalThis.document;
});
