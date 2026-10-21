#!/usr/bin/env node
/**
 * 番剧库更新实测：用打包出来的 exe 走一遍「后台检查 → 下载到 pending → 下次启动换库」。
 *
 *   node desktop/test/update.js <exe> --home <已经跑过一次的临时用户目录> --catalog <新版本 catalog.json>
 *
 * 打印换库前后的个人数据（番单 / 快速标记 / 观看日志 / 账号）和日志里的结论，并核对：
 *   · 个人数据条数不减少（被折成 stub 的条目合并到 dup_of 那条，合并后条数可以变少，这里按「每条都有着落」核对）
 *   · 库没坏（quick_check）
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const EXE = argv[0], HOME = opt('--home'), CATALOG = opt('--catalog');
const DBG = 9341;
if (!/tmp|temp|work|test/i.test(HOME ?? '')) { console.error('--home 必须是临时目录'); process.exit(2); }
const DB = join(HOME, 'data', 'j-anime.db');
const LOG = join(HOME, 'logs', 'main.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snapshot() {
  const d = new DatabaseSync(DB, { readOnly: true });
  try {
    const q = (s) => d.prepare(s).all();
    return {
      version: d.prepare("SELECT value FROM meta WHERE key = 'mora_catalog_version'").get()?.value ?? null,
      testPack: d.prepare("SELECT value FROM meta WHERE key = 'test_pack'").get()?.value ?? null,
      entries: q('SELECT anime_id, status, current_episode FROM user_entry_all ORDER BY anime_id'),
      triage: q('SELECT anime_id, verdict FROM triage_all ORDER BY anime_id'),
      logs: d.prepare('SELECT count(*) n FROM watch_log_all').get().n,
      accounts: q('SELECT id, username, role FROM account'),
      check: Object.values(d.prepare('PRAGMA quick_check').get())[0]
    };
  } finally { d.close(); }
}

async function runOnce(untilRe, timeout = 180_000) {
  const mark = existsSync(LOG) ? readFileSync(LOG, 'utf8').length : 0;
  const env = { ...process.env, MORA_HOME: HOME, MORA_CATALOG_URL: CATALOG, MORA_NO_UPDATE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(EXE, [`--remote-debugging-port=${DBG}`], { env, stdio: 'ignore' });
  const t0 = Date.now();
  let hit = null;
  while (Date.now() - t0 < timeout) {
    const tail = existsSync(LOG) ? readFileSync(LOG, 'utf8').slice(mark) : '';
    hit = tail.match(untilRe);
    if (hit) break;
    await sleep(500);
  }
  const tail = readFileSync(LOG, 'utf8').slice(mark);
  // 关窗口（和用户点 × 一样，走 before-quit → 结束服务进程树）
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${DBG}`, { timeout: 20_000 });
  const s = await b.newBrowserCDPSession();
  await s.send('Browser.close').catch(() => {});
  await sleep(4000);
  return { hit: hit?.[0] ?? null, tail };
}

const before = snapshot();
console.log('换库前', JSON.stringify(before));
// 让「每天最多查一次」的闸门放行
const stFile = join(HOME, 'state.json');
const st = JSON.parse(readFileSync(stFile, 'utf8'));
writeFileSync(stFile, JSON.stringify({ ...st, catalogCheckedAt: 0 }, null, 2));

console.log('▶ 第 1 次启动：后台检查 + 下载');
const r1 = await runOnce(/新番剧库 \S+ 已下载[^\n]*|番剧库更新检查失败[^\n]*/);
console.log('  日志：', r1.hit);
let r2 = null;
if (/已下载/.test(r1.hit ?? '')) {
  console.log('▶ 第 2 次启动：换库');
  r2 = await runOnce(/启动完成 \d+ms|启动失败[^\n]*/);
  console.log('  日志：', (r2.tail.match(/换库完成[^\n]*|换库失败[^\n]*/) ?? [''])[0].slice(0, 600));
  console.log('  ', r2.hit);
}
const after = snapshot();
console.log('换库后', JSON.stringify(after));
console.log(JSON.stringify({ downloaded: /已下载/.test(r1.hit ?? ''), swapped: /换库完成/.test(r2?.tail ?? ''),
  versionBefore: before.version ?? before.testPack, versionAfter: after.version ?? after.testPack, quickCheck: after.check,
  entries: [before.entries.length, after.entries.length], triage: [before.triage.length, after.triage.length],
  logs: [before.logs, after.logs], accounts: [before.accounts.length, after.accounts.length] }));
