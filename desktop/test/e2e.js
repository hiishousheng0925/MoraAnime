#!/usr/bin/env node
/**
 * 客户端端到端实测：真起打包出来的 exe（或组装目录），经 Chrome DevTools 协议连进窗口点一遍。
 *
 *   node desktop/test/e2e.js <exe 路径 | stage> --home <临时用户目录> --catalog <catalog.json> [--shots <截图目录>]
 *
 * 流程：
 *   1. 全新用户目录首次启动（从 --catalog 指的本地数据包装库）→ 计首次启动耗时
 *   2. 免登录：窗口里直接是本地账号
 *   3. 首页 / 目录 / 搜索 / 详情 / 放送表 / 番单 / 快速标记 / 统计 / 排行 / 设置 都能打开（200、没有错误页）
 *   4. 加番单、快速标记写得进去
 *   5. 观看页（缺省 /anime/18386/watch）真的搜片源、真的播放（video.currentTime 在走），拖到 95% 记进度
 *   6. 关窗口 → 服务进程跟着退出 → 再开 → 番单和进度都还在
 *
 * ⚠️ 只用 --home 指定的目录（路径里必须有 tmp / temp / work / test，防止误指到真实用户目录）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const TARGET = argv[0];
const HOME = opt('--home');
const CATALOG = opt('--catalog');
const SHOTS = opt('--shots');
const WATCH_ID = Number(opt('--watch', 18386));
const DBG = 9339;
if (!TARGET || !HOME || !CATALOG) { console.error('用法见文件头'); process.exit(2); }
if (!/tmp|temp|work|test/i.test(HOME)) { console.error(`--home 不像临时目录：${HOME}`); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`  ✅ ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  ❌ ${name}  ${detail}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch() {
  const stage = TARGET === 'stage';
  const exe = stage ? join(HERE, '..', 'node_modules', 'electron', 'dist', 'electron.exe') : TARGET;
  const args = [...(stage ? [join(HERE, '..', '.stage', 'app')] : []), `--remote-debugging-port=${DBG}`];
  const env = { ...process.env, MORA_HOME: HOME, MORA_CATALOG_URL: CATALOG, MORA_NO_UPDATE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(exe, args, { env, stdio: 'ignore', detached: false });
  return p;
}

/** 连上窗口，等首页加载完；返回 { browser, page, ms } */
async function attach(t0, timeout = 180_000) {
  let browser = null;
  while (Date.now() - t0 < timeout) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${DBG}`, { timeout: 2000 }); break; } catch { await sleep(300); }
  }
  if (!browser) throw new Error('连不上客户端的调试端口');
  while (Date.now() - t0 < timeout) {
    const pages = browser.contexts().flatMap((c) => c.pages());
    const page = pages.find((p) => /^http:\/\/127\.0\.0\.1:\d+\//.test(p.url()));
    if (page) {
      await page.waitForLoadState('load');
      return { browser, page, ms: Date.now() - t0 };
    }
    await sleep(200);
  }
  throw new Error('等不到主窗口');
}

const serverPid = () => {
  const log = readFileSync(join(HOME, 'logs', 'main.log'), 'utf8');
  return Number([...log.matchAll(/服务启动 pid=(\d+)/g)].pop()?.[1]);
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function closeApp(browser) {
  const pid = serverPid();
  const s = await browser.newBrowserCDPSession();
  await s.send('Browser.close').catch(() => {});
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(250);
  ok(!alive(pid), '关窗口后服务进程退出', `pid ${pid}`);
}

/** 直接只读打开客户端的库核对个人数据（WAL 模式下只读连接看得到已提交的写入） */
const dbq = (sql, ...p) => { const d = new DatabaseSync(join(HOME, 'data', 'j-anime.db'), { readOnly: true }); try { return d.prepare(sql).get(...p); } finally { d.close(); } };
const entryOf = (id) => dbq('SELECT status, current_episode FROM user_entry_all WHERE user_id = 1 AND anime_id = ?', id);
const triageOf = (id) => dbq('SELECT verdict FROM triage_all WHERE user_id = 1 AND anime_id = ?', id);
const countOf = (t) => dbq(`SELECT count(*) n FROM ${t}`).n;

const shot = async (page, name) => { if (SHOTS) { await page.screenshot({ path: join(SHOTS, name) }); console.log(`     📸 ${join(SHOTS, name)}`); } };

// ── 第一次启动 ─────────────────────────────────────────────
console.log(`▶ 首次启动 ${TARGET}`);
let t0 = Date.now();
launch();
let { browser, page, ms } = await attach(t0);
ok(true, '首次启动（下载 / 解压番剧库 + 迁移 + 起服务 + 首页加载）', `${(ms / 1000).toFixed(1)}s`);
const origin = new URL(page.url()).origin;
await page.setViewportSize({ width: 1400, height: 880 }).catch(() => {});

const api = (path, init) => page.evaluate(async ([p, i]) => {
  const r = await fetch(p, i ? { ...i, headers: { 'content-type': 'application/json' } } : undefined);
  return { status: r.status, body: await r.text() };
}, [path, init ?? null]);

// 免登录
const me = await page.evaluate(() => fetch('/api/export').then((r) => r.status));
ok(me === 200, '免登录：个人接口直接可用', `GET /api/export → ${me}`);
const html = await page.content();
ok(!/登录<\/button>/.test(html) || /\bme\b/.test(html), '首页没有要求登录');
await shot(page, '01-home.png');

// 各页面
const pages = ['/', '/catalog', '/ranking', '/seasons', '/schedule', '/mine', '/triage', '/stats', '/settings', `/anime/${WATCH_ID}`];
for (const p of pages) {
  const r = await page.goto(origin + p, { waitUntil: 'load' });
  const body = await page.evaluate(() => document.body.innerText);
  ok(r.status() === 200 && !/Internal Error|请先登录/.test(body.slice(0, 400)) && !/^\s*500/.test(body), `页面 ${p}`, `HTTP ${r.status()}`);
  if (p === `/anime/${WATCH_ID}`) await shot(page, '02-detail.png');
  if (p === '/schedule') await shot(page, '05-schedule.png');
}
const s = JSON.parse((await api('/api/search?q=' + encodeURIComponent('葬送'))).body);
ok(s.items?.length > 0, '搜索 /api/search?q=葬送', `${s.items?.length} 条，第一条 ${s.items?.[0]?.title_cn ?? s.items?.[0]?.title ?? ''}`);
await page.goto(origin + '/catalog', { waitUntil: 'load' });

// 番单 + 快速标记
const pickIds = await page.evaluate(() => fetch('/api/search?q=' + encodeURIComponent('进击的巨人')).then((r) => r.json()).then((j) => j.items.slice(0, 2).map((x) => x.id)));
const add = await api('/api/entry', { method: 'POST', body: JSON.stringify({ id: pickIds[0], status: 'plan' }) });
ok(add.status === 200, '加入番单（想看）', `anime ${pickIds[0]} → ${add.status}`);
const tri = await api('/api/triage', { method: 'POST', body: JSON.stringify({ id: pickIds[1], verdict: 'seen' }) });
ok(tri.status === 200, '快速标记「看过」', `anime ${pickIds[1]} → ${tri.status}`);
await page.goto(origin + '/mine', { waitUntil: 'load' });
await shot(page, '06-mine.png');
await page.goto(origin + '/stats', { waitUntil: 'load' });
await shot(page, '07-stats.png');

// WebGPU（超分辨率要用）
const gpu = await page.evaluate(async () => { try { const a = await navigator.gpu?.requestAdapter(); return a ? (a.info?.vendor || 'adapter ok') : 'no adapter'; } catch (e) { return 'err ' + e.message; } });
const secure = await page.evaluate(() => window.isSecureContext);
ok(secure === true && !/no adapter|err|undefined/.test(String(gpu)), 'WebGPU 可用（安全上下文 + 拿到 adapter）', String(gpu));

// 观看页：真搜片源、真播放
console.log(`▶ 观看页 /anime/${WATCH_ID}/watch`);
const tw = Date.now();
await page.goto(`${origin}/anime/${WATCH_ID}/watch`, { waitUntil: 'load' });
let played = null;
while (Date.now() - tw < 120_000) {
  played = await page.evaluate(() => {
    const v = document.querySelector('video');
    return v ? { t: v.currentTime, d: v.duration, rs: v.readyState, w: v.videoWidth, h: v.videoHeight, src: (v.currentSrc || '').slice(0, 80), paused: v.paused } : null;
  });
  if (played && played.t > 3) break;
  // 被浏览器的自动播放策略拦住时点一下播放
  if (played && played.paused && played.rs >= 2) await page.evaluate(() => document.querySelector('video')?.play().catch(() => {}));
  await sleep(1000);
}
ok(played && played.t > 3, '观看页真的在播放', played ? `currentTime ${played.t.toFixed(1)}s / ${played.d?.toFixed?.(0)}s，${played.w}x${played.h}，用时 ${((Date.now() - tw) / 1000).toFixed(1)}s，${played.src}` : '没有 video');
const siteName = await page.evaluate(() => document.body.innerText.match(/片源\s*(\S+)/)?.[1] ?? '');
console.log(`     片源：${siteName}`);
await shot(page, '03-watch-playing.png');

// 拖到 95%：触发「播到 90% 记进度」
if (played?.d > 0) {
  await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = v.duration * 0.95; v.play().catch(() => {}); });
}
// 轮询最多 30 秒：拖到 95% 后片源要重新缓冲，国内 CDN 慢的时候 6 秒还没播到（2026-10-23 实测：功能正常、固定等 6 秒误报）
let e1 = null;
for (let i = 0; i < 60 && !(e1?.current_episode >= 1); i++) { await sleep(500); e1 = entryOf(WATCH_ID); }
ok(e1 && (e1.current_episode ?? 0) >= 1, '播放进度记下来了', e1 ? `status=${e1.status} 第 ${e1.current_episode} 集` : '没有记录');
await shot(page, '04-watch-marked.png');
await closeApp(browser);
await sleep(1500);

// ── 关掉再开 ──────────────────────────────────────────────
console.log('▶ 再次启动（番单 / 进度应该还在）');
t0 = Date.now();
launch();
({ browser, page, ms } = await attach(t0));
ok(true, '再次启动', `${(ms / 1000).toFixed(1)}s`);
const e2 = entryOf(WATCH_ID);
ok(!!entryOf(pickIds[0]) && !!triageOf(pickIds[1]), '番单 / 快速标记还在', `番单 ${countOf('user_entry_all')} 条，快速标记 ${countOf('triage_all')} 条`);
ok(e2 && e2.current_episode === e1?.current_episode, '进度还在', e2 ? `第 ${e2.current_episode} 集` : '');
await closeApp(browser);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
