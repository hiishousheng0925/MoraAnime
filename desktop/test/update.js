#!/usr/bin/env node
/**
 * 番剧库更新实测：用打包出来的 exe 走一遍「后台检查 → 下载到 pending → 下次启动换库」。
 *
 *   node desktop/test/update.js <exe> --home <已经跑过一次的临时用户目录> --catalog <新版本 catalog.json>
 *
 * 打印换库前后的个人数据（番单 / 快速标记 / 观看日志 / 账号）和日志里的结论，并核对：
 *   · 个人数据条数不减少（被折成 stub 的条目合并到 dup_of 那条，合并后条数可以变少，这里按「每条都有着落」核对）
 *   · 库没坏（quick_check）
 * 任何一条不满足 → 打印 ❌ 并 exit 1（2026-10-22 审查：原来只打印对比、没有断言，失败了退出码也是 0，
 * 放进脚本 / CI 里等于没测）。
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

/** 换库后沿 dup_of 链找到条目最终挂在哪（和 db-tasks.js apply 的改挂规则一致） */
function resolveIn(d, id) {
  let cur = id;
  for (let i = 0; i < 20; i++) {
    const r = d.prepare('SELECT is_stub, dup_of FROM anime WHERE id = ?').get(cur);
    if (!r || !r.is_stub || !r.dup_of) return cur;
    cur = r.dup_of;
  }
  return cur;
}

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
const summary = { downloaded: /已下载/.test(r1.hit ?? ''), swapped: /换库完成/.test(r2?.tail ?? ''),
  versionBefore: before.version ?? before.testPack, versionAfter: after.version ?? after.testPack, quickCheck: after.check,
  entries: [before.entries.length, after.entries.length], triage: [before.triage.length, after.triage.length],
  logs: [before.logs, after.logs], accounts: [before.accounts.length, after.accounts.length] };
console.log(JSON.stringify(summary));

// ── 断言 ──────────────────────────────────────────────────
const fails = [];
const expect = (ok, msg) => { if (!ok) fails.push(msg); };
expect(summary.downloaded, `第 1 次启动没有下载新库：${r1.hit ?? '（日志里没等到结论）'}`);
expect(summary.swapped, `第 2 次启动没有换库：${(r2?.tail.match(/换库失败[^\n]*/) ?? [r2?.hit ?? '（没跑第 2 次）'])[0]}`);
expect(after.check === 'ok', `quick_check = ${after.check}`);
expect(summary.versionAfter !== summary.versionBefore, `换库后版本没变：${summary.versionAfter}`);
// --catalog 是本地 manifest 时核对换上的正是它那一版（make-pack 的测试包没有 mora_catalog_version，跳过）
let wantVersion = null;
try { if (CATALOG && !/^https?:/i.test(CATALOG)) wantVersion = JSON.parse(readFileSync(CATALOG.replace(/^file:\/\/\/?/i, ''), 'utf8')).version ?? null; } catch { /* 读不到就不核对 */ }
if (wantVersion && after.version) expect(after.version === wantVersion, `换上的版本 ${after.version} ≠ manifest ${wantVersion}`);
// 个人数据「每条都有着落」：换库前的每个 anime_id，沿新库的 dup_of 链走到底后必须还在
{
  const d = new DatabaseSync(DB, { readOnly: true });
  try {
    for (const [label, b, a] of [['番单', before.entries, after.entries], ['快速标记', before.triage, after.triage]]) {
      const have = new Set(a.map((x) => x.anime_id));
      const lost = b.map((x) => x.anime_id).filter((id) => !have.has(resolveIn(d, id)));
      expect(!lost.length, `${label}丢了 ${lost.length} 条：${lost.slice(0, 10).join(', ')}`);
    }
  } finally { d.close(); }
}
expect(after.logs >= before.logs, `观看日志变少：${before.logs} → ${after.logs}`);
const accIds = new Set(after.accounts.map((x) => x.id));
expect(before.accounts.every((x) => accIds.has(x.id)), `账号丢了：${JSON.stringify(before.accounts)} → ${JSON.stringify(after.accounts)}`);

if (fails.length) { for (const f of fails) console.error('❌', f); process.exit(1); }
console.log('✅ 番剧库更新实测通过');
process.exit(0);
