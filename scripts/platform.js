/**
 * 跨平台的几个零件 —— 只放 Mac / Windows 真不一样的地方。
 *
 * ⚠️ vite 一律用 node 直接跑它的入口，不走 npx：
 * Windows 上 npx 是 npx.cmd，而 Node ≥18.20 禁止不带 shell 去 spawn .cmd（EINVAL），
 * 带 shell 又得自己处理参数转义。node + vite.js 两边都一样，没有这层问题。
 */
import { spawnSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IS_WIN = process.platform === 'win32';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');

/**
 * Windows 上起一个脱离当前终端的后台进程，返回 PID。
 *
 * ⚠️ 不能用 spawn({ detached: true })：那会以 DETACHED_PROCESS 启动，powershell 没有控制台
 * 就直接 exit 0、一行都不执行（实测连 Write-Output 都没有，日志为空）。
 * 不 detached 又会随终端/父进程的进程树一起被结束。
 * Win32_Process.Create 起的进程不在调用方的进程树和作业对象里，两个问题都没有。
 * 代价：它不继承环境变量、不能接 stdio —— 所以由调用方把 set 和重定向写进 cmd 命令行。
 * 命令行经环境变量传给 powershell，绕开 5.1 给原生程序传参时吞双引号的老问题。
 *
 * ShowWindow=0（SW_HIDE）必须给：Win32_Process.Create 缺省按「显示」开 cmd，
 * 默认终端是 Windows Terminal 时每次重启测试站 / 正式站都会弹出一个空终端窗口（主人 2026-10-18 截图）。
 */
export function spawnBackgroundWin(cmdline, cwd) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; ' +
    '(Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:BG_CMD; CurrentDirectory = $env:BG_CWD; ProcessStartupInformation = $si }).ProcessId'],
    { encoding: 'utf8', env: { ...process.env, BG_CMD: cmdline, BG_CWD: cwd } });
  return Number((r.stdout || '').trim()) || 0;
}

/**
 * 连子进程一起结束。
 * Windows 没有进程组信号：结束 run-app.ps1 那个 powershell 不会带走它拉起的 node，
 * node 会变成孤儿继续占着端口。所以必须 taskkill /T 按 PID 杀整棵树。
 */
export function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(pid, 'SIGTERM'); } catch {}
}

/**
 * 进程的完整命令行（Windows），拿不到返回 ''。
 * 杀进程前用它核对身份：pidfile 里的 PID 在重启后可能已经被别的进程复用（#45），
 * 本机还常驻着 larkBot、claude-proxy —— 不核对就 taskkill /T 会连树一起误杀。
 */
export function processCmdline(pid) {
  if (!IS_WIN || !Number.isInteger(pid) || pid <= 0) return '';
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

/**
 * 按顺序执行一组改名 [from, to]，任何一步失败就把已完成的按相反顺序改回去再抛错（#46）。
 * Windows 上杀毒 / 索引器会短暂占着句柄，rename 偶发 EPERM，所以每一步先重试几次。
 * 原来第二步失败时第一步（build → build.prev）已经做了，正式站就没有 build/ 了。
 */
export function renameAll(pairs, { tries = 6, waitMs = 500 } = {}) {
  const done = [];
  const once = (a, b) => {
    for (let i = 1; ; i++) {
      try { return renameSync(a, b); }
      catch (e) {
        if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
      }
    }
  };
  try {
    for (const [a, b] of pairs) { once(a, b); done.push([a, b]); }
  } catch (e) {
    for (const [a, b] of done.reverse()) { try { once(b, a); } catch {} }
    throw e;
  }
}

/** 正在监听某端口的进程 PID（只用于 Windows 重启正式站） */
export function pidOnPort(port) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue).OwningProcess`],
    { encoding: 'utf8' });
  return [...new Set((r.stdout || '').split(/\s+/).filter(Boolean).map(Number))];
}
