/**
 * 站点目录（正式站的家）：路径、版本列表、切换、回滚、清理、离线自检。release.js / site-migrate.js 调用。
 *
 * 为什么要有站点目录（2026-10-21）：正式站原来直接跑在开发目录里，build/、node_modules/、
 * 正式库和 30 份备份全和开发共用。裸跑 vite build、git checkout、git worktree remove 顺着
 * node_modules junction 清空主仓库依赖（正式站 /api/sources 500 约 20 分钟）、git clean -fdx ——
 * 开发里的任何一个动作都能打到正式站。搬出来以后开发目录怎么折腾都碰不到它：
 *
 *   <站点>\data\                    正式数据（库、封面、备份、日志、app.hold）
 *   <站点>\releases\<时间>-<sha7>\   每一版自带 build\ deploy\ node_modules\ RELEASE.json
 *   <站点>\current                   junction → 当前版
 *   <站点>\releases.json             切换历史，回滚用
 *   <站点>\bin\                      看门狗 / 每日同步的稳定入口（任务计划程序指向这里）
 *
 * ⚠️ junction 操作守则（这次事故就是递归删除顺着 junction 删进了主仓库）：
 *   · 删链接只删链接本身：removeLink（unlink / 非递归 rmdir），先 lstat 确认是链接
 *   · 删目录只用 safeRmTree：自己逐层走，遇到链接只删链接、绝不进去；入口本身是链接直接拒绝
 *   · tests/unit/site.test.js 在临时目录里实测：删 junction 后目标目录内容还在
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, chmodSync, statSync
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { envValue } from '../src/lib/server/envFile.js';
import { IS_WIN, killTree, pidOnPort, processCmdline, tailscaleIp } from './platform.js';

export const DEFAULT_SITE = join(homedir(), 'Desktop', 'dev', 'j-anime-site');
export const KEEP_RELEASES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 站点目录：J_ANIME_SITE 环境变量 → ~/.j-anime.env 里的 J_ANIME_SITE → 缺省 */
export function sitePaths(site = envValue('J_ANIME_SITE') || DEFAULT_SITE) {
  const root = resolve(site);
  return {
    site: root,
    data: join(root, 'data'),
    releases: join(root, 'releases'),
    current: join(root, 'current'),
    history: join(root, 'releases.json'),
    bin: join(root, 'bin'),
    hold: join(root, 'data', 'app.hold')
  };
}

// ───────────────────────── 链接 / 删除 ─────────────────────────

/** 是不是符号链接 / junction（Windows 上 lstat 把 junction 也报成 symlink） */
export function isLink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** 建 junction（Windows 不需要管理员权限；其它平台退化成目录符号链接） */
export function makeJunction(target, link) {
  symlinkSync(resolve(target), link, IS_WIN ? 'junction' : 'dir');
}

/** 只删链接本身。不是链接就拒绝 —— 绝不对它做递归删除 */
export function removeLink(p) {
  if (!lstatSync(p).isSymbolicLink()) throw new Error(`${p} 不是链接，拒绝删除`);
  try { unlinkSync(p); }
  catch (e) {
    if (!['EPERM', 'EISDIR', 'EACCES'].includes(e.code)) throw e;
    rmdirSync(p);   // 非递归：只能删空目录或链接本身
  }
}

const inside = (child, parent) => {
  const r = relative(resolve(parent), resolve(child));
  return !!r && !r.startsWith('..') && !isAbsolute(r);
};

/**
 * 递归删目录，但遇到链接只删链接、绝不跟进去。
 * within：要求 dir 在这个目录之下（防手滑删到别处）。dir 本身是链接直接拒绝。
 */
export function safeRmTree(dir, within) {
  if (!existsSync(dir) && !isLink(dir)) return;
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) throw new Error(`${dir} 是链接，拒绝递归删除`);
  if (!st.isDirectory()) throw new Error(`${dir} 不是目录`);
  if (within && !inside(dir, within)) throw new Error(`${dir} 不在 ${within} 之下，拒绝删除`);
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = lstatSync(p);
      if (s.isSymbolicLink()) removeLink(p);
      else if (s.isDirectory()) { walk(p); rmdirSync(p); }
      else {
        try { unlinkSync(p); }
        catch (e) { if (e.code !== 'EPERM') throw e; chmodSync(p, 0o666); unlinkSync(p); }   // 只读文件
      }
    }
  };
  walk(dir);
  rmdirSync(dir);
}

// ───────────────────────── 版本 / 历史 ─────────────────────────

/** releases\ 下的真实目录名（按名字 = 时间升序；链接不算） */
export function listReleases(P) {
  if (!existsSync(P.releases)) return [];
  return readdirSync(P.releases, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !isLink(join(P.releases, e.name)))
    .map((e) => e.name).sort();
}

/** current 指向的版本名；没有 / 不是链接返回 null */
export function currentRelease(P) {
  if (!isLink(P.current)) return null;
  return basename(readlinkSync(P.current).replace(/[\\/]+$/, ''));
}

export function readHistory(P) {
  try { return JSON.parse(readFileSync(P.history, 'utf8')); } catch { return []; }
}

export function recordHistory(P, name, via) {
  const h = readHistory(P);
  h.push({ name, at: new Date().toISOString(), via });
  writeFileSync(P.history, JSON.stringify(h, null, 2));
}

/** 回滚目标：历史里最近一个、不是当前版、目录还在的版本 */
export function previousRelease(P) {
  const cur = currentRelease(P);
  const have = new Set(listReleases(P));
  for (const e of readHistory(P).slice().reverse())
    if (e.name !== cur && have.has(e.name)) return e.name;
  return null;
}

/** current 改指向 name：先删旧链接（只删链接），再建新的；建失败就把旧的建回去 */
export function pointCurrent(P, name) {
  const target = join(P.releases, name);
  if (!existsSync(join(target, 'build', 'index.js'))) throw new Error(`版本 ${name} 不完整（没有 build\\index.js）`);
  const old = currentRelease(P);
  if (existsSync(P.current) || isLink(P.current)) removeLink(P.current);   // 不是链接会抛错，什么都不动
  try { makeJunction(target, P.current); }
  catch (e) {
    if (old) makeJunction(join(P.releases, old), P.current);
    throw e;
  }
}

/**
 * 只留最近 keep 个版本：历史里最近用过的 keep 个 + 当前版；其余 releases\ 下的真实目录删掉。
 * 链接一律跳过不碰。返回删掉的名字。
 */
export function pruneReleases(P, keep = KEEP_RELEASES) {
  const keepSet = new Set();
  const cur = currentRelease(P);
  if (cur) keepSet.add(cur);
  for (const e of readHistory(P).slice().reverse()) {
    if (keepSet.size >= keep) break;
    keepSet.add(e.name);
  }
  const removed = [];
  for (const name of listReleases(P)) {
    if (keepSet.has(name)) continue;
    safeRmTree(join(P.releases, name), P.releases);
    removed.push(name);
  }
  return removed;
}

// ───────────────────────── 组装 ─────────────────────────

/** npm 的入口：用当前 node 直接跑 npm-cli.js（Windows 上不带 shell 起不了 npm.cmd） */
function npmCmd() {
  for (const c of [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
                   join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')])
    if (existsSync(c)) return [process.execPath, [c]];
  return ['npm', []];
}

export function releaseName(sha) {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${sha}`;
}

export function gitSha(root) {
  const r = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return (r.stdout || '').trim() || 'nogit00';
}

/**
 * 组装一个版本：<releases>\<name>\{build, deploy, package*.json, node_modules, RELEASE.json}。
 * 依赖是这一版自己的（npm ci --omit=dev），不再和开发目录共用。任何一步失败就删掉半成品再抛错。
 */
export function assembleRelease({ root, buildDir, P, name, sha, sourceHash = null, log = console.log }) {
  const dir = join(P.releases, name);
  if (existsSync(dir) || isLink(dir)) throw new Error(`${dir} 已存在`);
  mkdirSync(dir, { recursive: true });
  try {
    log(`   拷产物 → ${dir}\\build`);
    cpSync(buildDir, join(dir, 'build'), { recursive: true });
    cpSync(join(root, 'deploy'), join(dir, 'deploy'), { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) copyFileSync(join(root, f), join(dir, f));
    log('   npm ci --omit=dev …');
    const [cmd, pre] = npmCmd();
    const r = spawnSync(cmd, [...pre, 'ci', '--omit=dev', '--no-audit', '--no-fund'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } });
    if (r.status !== 0) throw new Error(`npm ci 失败（${r.status}）\n${(r.stderr || r.stdout || '').slice(-2000)}`);
    writeFileSync(join(dir, 'RELEASE.json'),
      JSON.stringify({ name, sha, builtAt: new Date().toISOString(), sourceHash }, null, 2));
    return dir;
  } catch (e) {
    try { safeRmTree(dir, P.releases); } catch {}
    throw e;
  }
}

// ───────────────────────── 库副本 / 自检 ─────────────────────────

/**
 * 给库拍一份一致的副本（含 WAL 里还没合并的数据），对源库只读：
 * 只读连接 + VACUUM INTO，不 checkpoint、不写源文件。
 */
export async function copyDbSnapshot(src, dst) {
  const { DatabaseSync } = await import('node:sqlite');
  if (existsSync(dst)) throw new Error(`${dst} 已存在`);
  const d = new DatabaseSync(src, { readOnly: true });
  try { d.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`); }
  finally { d.close(); }
}

/**
 * 正在跑的看门狗（<站点>\bin\service.ps1）的 PID。切换只是停掉 node、改 current，拉起全靠它 ——
 * 2026-10-21 实测看门狗无声退出过，发布照样切换，新版本和回滚都没人拉起，正式站停了 6 分钟。
 */
export function watchdogPids(P) {
  if (!IS_WIN) return [];
  const svc = join(P.site, 'bin', 'service.ps1').toLowerCase();
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"],
    { encoding: 'utf8' });
  return (r.stdout || '').split(/\r?\n/).filter((l) => l.toLowerCase().includes(svc)).map((l) => +l.split('\t')[0]);
}

/**
 * 切换前给正式库留一份快照：新版本启动时跑的 migrate 会直接改正式库（回填、重新归一），
 * 健康检查不过只能把代码切回去，数据回不去；日常备份又只覆盖个人记录。只读 VACUUM INTO，保留最近 keep 份
 */
export async function snapshotProdDb(P, name, keep = 3) {
  const dir = join(P.data, 'pre-release');
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, `${name}.db`);
  await copyDbSnapshot(join(P.data, 'j-anime.db'), dst);
  const all = readdirSync(dir).filter((n) => n.endsWith('.db')).sort();
  for (const n of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(dir, n), { force: true });
  return dst;
}

/** 健康检查该打的地址：BIND_LOCAL=1 → 127.0.0.1，否则 tailnet IP（和 bin/service.ps1 同一取法） */
export function healthBase(port) {
  if (envValue('J_ANIME_BIND_LOCAL') === '1') return `http://127.0.0.1:${port}`;
  const ip = tailscaleIp();
  return `http://${ip || '127.0.0.1'}:${port}`;
}

/**
 * 打一次健康检查，ok 返回响应体，否则 null。
 * 兼容没有 /api/health 的旧产物（切换时第一个版本就是正式站原来那份 build\）：
 * 接口 401 / 404 → 退回打 /login，200 就算活着，返回 { ok: true, release: null, legacy: true }。
 * （旧产物的 hooks 对访客的 GET /api/* 一律 401，还轮不到路由报 404；新产物 /api/health 在 OPEN_READ 里，不会 401）
 * bin/service.ps1 的 Test-Health 是同一套判断。
 */
export async function checkHealth(base) {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (r.status === 404 || r.status === 401) {
      const l = await fetch(`${base}/login`, { signal: AbortSignal.timeout(5000) });
      return l.ok ? { ok: true, release: null, legacy: true } : null;
    }
    const j = await r.json().catch(() => null);
    return r.ok && j?.ok ? j : null;
  } catch { return null; }
}

/** 反复打健康检查，ok 了返回响应体；tries 次都不行返回 null。expect：要求 release 名对得上（旧产物无从核对，放过） */
export async function waitHealthy(base, { tries = 60, everyMs = 1000, expect } = {}) {
  for (let i = 0; i < tries; i++) {
    const h = await checkHealth(base);
    if (h && (!expect || h.legacy || h.release === expect)) return h;
    await sleep(everyMs);
  }
  return null;
}

/** 端口上的进程必须是 j-anime 的 node（--import ./deploy/guard.mjs … index.js），否则不杀 */
export const isJanimeNode = (cmd) => /node/i.test(cmd) && /guard\.mjs/.test(cmd) && /index\.js/.test(cmd);

/** 按端口 PID 停掉 j-anime 的 node（核对命令行），等端口放出来 */
export async function stopSite(port, { log = console.log } = {}) {
  for (const pid of pidOnPort(port)) {
    const cmd = processCmdline(pid);
    if (!isJanimeNode(cmd)) throw new Error(`端口 ${port} 上的进程 ${pid} 不是 j-anime 的 node，不动它：${cmd}`);
    log(`   停 PID ${pid}`);
    killTree(pid);
  }
  for (let i = 0; i < 40 && pidOnPort(port).length; i++) await sleep(500);
  if (pidOnPort(port).length) throw new Error(`端口 ${port} 一直没放出来`);
  await sleep(500);   // 句柄释放比端口释放晚一点
}

/**
 * 切换：放 hold → 停正式站 → current 改指向 → 撤 hold（看门狗随即用新版本拉起）。
 * hold 成功失败都撤：失败时 current 没动或已建回原来的，看门狗拉起的仍是原版本。
 */
export async function switchTo(P, name, port, opts = {}) {
  writeFileSync(P.hold, String(process.pid));
  try {
    await stopSite(port, opts);
    pointCurrent(P, name);
  } finally {
    rmSync(P.hold, { force: true });
  }
}

/**
 * 离线自检（还没切换）：
 *   1. package.json 的 dependencies 在这一版自己的 node_modules 里都在，jsdom 真加载一次
 *   2. 拿正式库的只读副本，在空闲端口用这一版自己的 deploy\run-app.ps1 真起起来，/api/health 必须 ok
 * 起的进程按 PID 杀树，临时目录删掉。返回 { ok, error?, health? }。
 */
export async function selfTest(dir, { dbSrc, port = 3099, log = console.log } = {}) {
  // adapter-node 把 package.json 的 dependencies 当外部依赖（不打包），运行时从这一版的 node_modules 加载
  const deps = Object.keys(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies ?? {});
  const miss = deps.filter((d) => !existsSync(join(dir, 'node_modules', d, 'package.json')));
  if (miss.length) return { ok: false, error: `依赖不齐：${miss.join(' ')}` };
  // jsdom 真加载一次（2026-10-21 坏掉的就是它；/api/sources 用它解析片源页）
  const dep = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('jsdom')"], { cwd: dir, encoding: 'utf8' });
  if (dep.status !== 0) return { ok: false, error: `jsdom 加载失败：${dep.stderr.trim().slice(-800)}` };
  log(`   运行时依赖 ${deps.join(' ')}`);
  log('   ✓ 依赖齐全');

  if (!IS_WIN) return { ok: true, health: null };   // 起服务那一步只做了 Windows 版
  if (pidOnPort(port).length) return { ok: false, error: `自检端口 ${port} 被占用` };
  const tmp = mkdtempSync(join(tmpdir(), 'j-anime-selftest-'));
  const db = join(tmp, 'j-anime.db');
  let child;
  const out = [];
  try {
    await copyDbSnapshot(dbSrc, db);
    log(`   正式库只读副本 ${(statSync(db).size / 1048576).toFixed(0)} MB → :${port}`);
    const env = { ...process.env, J_ANIME_DATA: tmp, J_ANIME_DB: db, J_ANIME_BACKUPS: join(tmp, 'backups'),
                  PORT: String(port), HOST: '127.0.0.1', J_ANIME_BIND_LOCAL: '0',
                  ORIGIN: `http://127.0.0.1:${port}` };
    delete env.J_ANIME_STAGING;
    child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'deploy', 'run-app.ps1')],
      { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', (b) => out.push(String(b)));
    child.stderr.on('data', (b) => out.push(String(b)));
    const h = await waitHealthy(`http://127.0.0.1:${port}`, { tries: 90 });
    if (!h) return { ok: false, error: `自检实例 /api/health 不 ok\n${out.join('').slice(-1500)}` };
    log(h.legacy ? '   ✓ 旧产物没有 /api/health，/login 200（活着）' : `   ✓ /api/health ok（release=${h.release}）`);
    return { ok: true, health: h };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (child?.pid) {
      // 自己起的进程：核对一下命令行再按 PID 杀树
      if (/run-app\.ps1/i.test(processCmdline(child.pid))) killTree(child.pid);
      for (let i = 0; i < 20 && pidOnPort(port).length; i++) await sleep(500);
    }
    for (let i = 0; i < 10; i++) {   // 句柄释放晚一点，删不掉就再等等
      try { safeRmTree(tmp, tmpdir()); break; } catch { await sleep(500); }
    }
  }
}
