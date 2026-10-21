/**
 * MoraAnime 主进程：把网站（SvelteKit adapter-node 产物）搬到用户电脑上跑。
 *
 * 启动顺序：
 *   1. 番剧库：没有就下载（首次启动）；上次后台下好的新版本在这里换上（db-tasks apply）
 *   2. scripts/migrate.js（应用自己不跑 initSchema，缺列会 500 —— 和网站的启动脚本同一个道理）
 *   3. db-tasks bootstrap：确保本地账号、建会话令牌
 *   4. 子进程跑服务：ELECTRON_RUN_AS_NODE=1 + process.execPath = 同一个 exe 当 Node 用，听 127.0.0.1 随机端口
 *   5. 窗口塞会话 cookie、加载首页；之后后台检查番剧库更新（每天最多一次）和应用更新
 *
 * 环境变量（都可选，开发 / 测试用）：
 *   MORA_HOME         客户端用户目录，缺省 %APPDATA%\MoraAnime（数据在 <它>\data）
 *   MORA_CATALOG_URL  番剧库 manifest 地址（见 catalog.js）
 *   MORA_NO_UPDATE=1  不检查应用更新
 */
import { app, BrowserWindow, dialog, net, session, shell, Menu } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchManifest, downloadCatalog } from './catalog.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, '..');
const BUILD = join(APP_DIR, 'build');
const LIB = join(BUILD, '.sync', 'src', 'lib', 'server');
const MIGRATE = join(BUILD, '.sync', 'scripts', 'migrate.js');

app.setName('MoraAnime');
const HOME = process.env.MORA_HOME || join(app.getPath('appData'), 'MoraAnime');
const DATA = join(HOME, 'data');
const DB = join(DATA, 'j-anime.db');
const PENDING = join(DATA, 'catalog-pending');
const LOGS = join(HOME, 'logs');
const STATE = join(HOME, 'state.json');
for (const d of [HOME, DATA, LOGS]) mkdirSync(d, { recursive: true });
// Chromium 自己的缓存 / cookie 也放进同一个用户目录（MORA_HOME 指到别处时整套隔离）
app.setPath('userData', HOME);

const COOKIE = 'j_anime_sid';
const DAY = 24 * 3600_000;

// ── 日志 / 状态 ─────────────────────────────────────────────
const logFile = join(LOGS, 'main.log');
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
  try { appendFileSync(logFile, line); } catch { /* 日志写不进不影响运行 */ }
  if (!app.isPackaged) process.stdout.write(line);
}
const readState = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; } };
const writeState = (patch) => {
  const s = { ...readState(), ...patch };
  writeFileSync(STATE + '.part', JSON.stringify(s, null, 2)); renameSync(STATE + '.part', STATE);
};

// ── 嗅探用的浏览器：本机 Chrome，没有就用系统自带的 Edge ───────────
function findBrowser() {
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const cands = [
    ...pf.map((p) => join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...pf.map((p) => join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  ];
  return cands.find((p) => existsSync(p)) ?? null;
}

/** 子进程（迁移 / db-tasks / 服务）的环境：只带客户端需要的，网站那边的部署变量一概不继承 */
function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(J_ANIME_|STAGING_|TRUSTED_ORIGINS$|ORIGIN$|HOST$|PORT$)/.test(k)) delete env[k];
  const browser = findBrowser();
  return { ...env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production', J_ANIME_DATA: DATA,
           ...(browser ? { J_ANIME_CHROME: browser } : {}),
           MORA_HOME: HOME, MORA_LIB: LIB, MORA_MIGRATE: MIGRATE, ...extra };
}

function runNode(script, args = [], extra = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: APP_DIR, env: childEnv(extra), encoding: 'utf8', windowsHide: true });
  const out = (r.stdout || '') + (r.stderr || '');
  // bootstrap 的 stdout 是会话令牌，不进日志
  const shown = args[0] === 'bootstrap' ? (r.stderr || '') : out;
  log(`${script.split(/[\\/]/).pop()} ${args.join(' ')} → exit ${r.status}`, shown.trim().slice(-2000));
  if (r.status !== 0) throw new Error(`${script.split(/[\\/]/).pop()} 失败：${(r.stderr || r.stdout || '').trim().slice(-800)}`);
  return r.stdout;
}

// ── 启动画面 ───────────────────────────────────────────────
let splash = null, splashReady = false;
function showSplash() {
  splash = new BrowserWindow({ width: 420, height: 160, frame: false, resizable: false, show: false, center: true,
    backgroundColor: '#18181b', webPreferences: { sandbox: true } });
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;font:14px system-ui,'Microsoft YaHei';color:#e4e4e7;background:#18181b;
    display:flex;flex-direction:column;justify-content:center;padding:0 28px;height:100vh;box-sizing:border-box">
    <div style="font-size:18px;font-weight:600;margin-bottom:10px">MoraAnime</div><div id="m">正在启动</div>
    <div style="margin-top:12px;height:4px;background:#3f3f46;border-radius:2px"><div id="b" style="height:4px;width:0;background:#a78bfa;border-radius:2px"></div></div></body>`;
  splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  splash.once('ready-to-show', () => { splashReady = true; splash?.show(); });
}
function splashMsg(msg, frac = null) {
  if (!splash || splash.isDestroyed() || !splashReady) return;
  splash.webContents.executeJavaScript(`document.getElementById('m').textContent=${JSON.stringify(msg)};` +
    (frac == null ? '' : `document.getElementById('b').style.width='${Math.round(frac * 100)}%';`)).catch(() => {});
}
const fetchFn = (u, o) => net.fetch(u, o);
const mb = (n) => (n / 1048576).toFixed(1);

// ── 番剧库 ─────────────────────────────────────────────────
async function ensureCatalog() {
  if (existsSync(DB)) return applyPending();
  // 首次启动：下载
  for (;;) {
    try {
      splashMsg('正在获取番剧库信息');
      const m = await fetchManifest(fetchFn);
      const t0 = Date.now();
      await downloadCatalog(m, DB + '.new', fetchFn, ({ phase, done, total }) => splashMsg(
        phase === 'download' ? `正在下载番剧库 ${mb(done)} / ${mb(total)} MB` : `正在解压 ${mb(done)} MB`,
        total ? done / total : null));
      renameSync(DB + '.new', DB);
      writeState({ catalogVersion: m.version, catalogCheckedAt: Date.now() });
      log(`首次下载番剧库 ${m.version} 用时 ${Date.now() - t0}ms`);
      return;
    } catch (e) {
      log('首次下载番剧库失败', String(e?.stack || e));
      const r = await dialog.showMessageBox({ type: 'error', title: 'MoraAnime', message: '番剧库下载失败',
        detail: String(e?.message || e), buttons: ['重试', '退出'], defaultId: 0, cancelId: 1 });
      if (r.response !== 0) { app.exit(1); return new Promise(() => {}); }
    }
  }
}

/** 上次后台下好的新库：在服务起来之前换上（个人数据搬过去，见 db-tasks.js apply） */
function applyPending() {
  const pdb = join(PENDING, 'catalog.db'), pman = join(PENDING, 'catalog.json');
  if (!existsSync(pdb) || !existsSync(pman)) return;
  let m = {};
  try { m = JSON.parse(readFileSync(pman, 'utf8')); } catch { /* 下面按无版本号处理 */ }
  splashMsg(`正在更新番剧库 ${m.version ?? ''}`);
  try {
    const out = runNode(join(HERE, 'db-tasks.js'), ['apply', pdb, m.version ?? '']);
    log('换库完成', out.trim());
    writeState({ catalogVersion: m.version ?? null, lastSwap: JSON.parse(out.trim().split('\n').pop()) });
  } catch (e) {
    // 换库失败：现有库没动过（db-tasks 只在最后一步改名），丢掉这个新包，下次检查再下
    log('换库失败，保留现有库', String(e?.message || e));
    // 记下这个版本：同一个坏包不再每天重下（上游发了新版本号才再试）
    writeState({ lastSwapError: String(e?.message || e).slice(0, 500), badVersion: m.version ?? null });
  } finally {
    rmSync(PENDING, { recursive: true, force: true });
  }
}

/** 后台：每天最多一次查 manifest，有新版就下到 catalog-pending/，下次启动换上 */
async function checkCatalogUpdate({ force = false } = {}) {
  const st = readState();
  if (!force && st.catalogCheckedAt && Date.now() - st.catalogCheckedAt < DAY) return { skipped: true };
  try {
    const m = await fetchManifest(fetchFn);
    writeState({ catalogCheckedAt: Date.now() });
    if (m.version === st.catalogVersion) return { upToDate: m.version };
    if (m.version === st.badVersion) return { skippedBad: m.version };
    rmSync(PENDING, { recursive: true, force: true });
    mkdirSync(PENDING, { recursive: true });
    const t0 = Date.now();
    await downloadCatalog(m, join(PENDING, 'catalog.db'), fetchFn);
    writeFileSync(join(PENDING, 'catalog.json'), JSON.stringify(m, null, 2));   // 最后写 = 下载完成的标记
    log(`新番剧库 ${m.version} 已下载（${Date.now() - t0}ms），下次启动时换上`);
    return { downloaded: m.version };
  } catch (e) {
    rmSync(PENDING, { recursive: true, force: true });
    log('番剧库更新检查失败（不影响使用）', String(e?.message || e));
    return { error: String(e?.message || e) };
  }
}

// ── 服务子进程 ─────────────────────────────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

let server = null, port = 0, quitting = false;
const crashes = [];

function startServer() {
  const origin = `http://127.0.0.1:${port}`;
  const env = childEnv({ HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin, BODY_SIZE_LIMIT: '50M', J_ANIME_BRAND: 'MoraAnime' });
  const out = join(LOGS, 'server.log');
  // --import 的绝对路径必须写成 file:// URL（Windows 上 C:\… 会被当成协议名）
  server = spawn(process.execPath, ['--import', pathToFileURL(join(HERE, 'guard.mjs')).href, join(BUILD, 'index.js')],
    { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const sink = (b) => { try { appendFileSync(out, b); } catch { /* 忽略 */ } };
  server.stdout.on('data', sink); server.stderr.on('data', sink);
  log(`服务启动 pid=${server.pid} ${origin}`);
  const me = server;
  me.on('exit', (code, sig) => {
    log(`服务退出 pid=${me.pid} code=${code} sig=${sig}`);
    if (quitting || me !== server) return;
    // 崩了自动重启；一分钟内崩 5 次就不再硬撑
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > 60_000) crashes.shift();
    if (crashes.length > 5) {
      dialog.showErrorBox('MoraAnime', `本地服务反复退出，请查看日志：\n${out}`);
      app.quit();
      return;
    }
    setTimeout(async () => {
      if (quitting) return;
      startServer();
      if (await waitHealthy()) mainWin?.webContents.reload();
    }, 1000);
  });
}

async function waitHealthy(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * 结束服务进程树（服务会拉起嗅探用的浏览器）。只按我们自己 spawn 出来的 PID 杀：
 * 子进程还没被回收（exitCode === null）时我们手里握着它的句柄，Windows 不会把这个 PID 分给别的进程，
 * 所以这个 PID 一定还是那个服务进程。
 */
function stopServer() {
  const s = server;
  server = null;
  if (!s || s.exitCode !== null || s.signalCode) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(s.pid), '/T', '/F'], { windowsHide: true });
  else s.kill('SIGTERM');
}

// ── 窗口 ───────────────────────────────────────────────────
let mainWin = null;

function windowBounds() {
  const st = readState().window;
  return st?.bounds ? st : { bounds: { width: 1360, height: 860 }, maximized: false };
}

function createWindow(origin) {
  const ws = windowBounds();
  mainWin = new BrowserWindow({
    ...ws.bounds, minWidth: 900, minHeight: 600, show: false, title: 'MoraAnime', backgroundColor: '#18181b',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false }
  });
  if (ws.maximized) mainWin.maximize();
  const isLocal = (u) => { try { return new URL(u).origin === origin; } catch { return false; } };
  // 外链（target=_blank、原站链接）交给系统浏览器
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (!isLocal(url) && /^https?:/i.test(url)) shell.openExternal(url);
    else if (isLocal(url)) mainWin.loadURL(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e, url) => {
    if (!isLocal(url)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  // 没有菜单栏：常用快捷键自己接
  mainWin.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const wc = mainWin.webContents;
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) { wc.reload(); e.preventDefault(); }
    else if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) { wc.toggleDevTools(); e.preventDefault(); }
    else if (input.alt && input.key === 'ArrowLeft' && wc.navigationHistory.canGoBack()) { wc.navigationHistory.goBack(); e.preventDefault(); }
    else if (input.alt && input.key === 'ArrowRight' && wc.navigationHistory.canGoForward()) { wc.navigationHistory.goForward(); e.preventDefault(); }
    else if (input.key === 'F11') { mainWin.setFullScreen(!mainWin.isFullScreen()); e.preventDefault(); }
  });
  // 鼠标侧键前进 / 后退
  mainWin.on('app-command', (_e, cmd) => {
    const h = mainWin.webContents.navigationHistory;
    if (cmd === 'browser-backward' && h.canGoBack()) h.goBack();
    if (cmd === 'browser-forward' && h.canGoForward()) h.goForward();
  });
  const save = () => {
    if (!mainWin || mainWin.isDestroyed() || mainWin.isMinimized() || mainWin.isFullScreen()) return;
    writeState({ window: { bounds: mainWin.isMaximized() ? (readState().window?.bounds ?? mainWin.getNormalBounds()) : mainWin.getBounds(),
                           maximized: mainWin.isMaximized() } });
  };
  let t = null;
  const later = () => { clearTimeout(t); t = setTimeout(save, 500); };
  mainWin.on('resize', later); mainWin.on('move', later);
  mainWin.on('maximize', save); mainWin.on('unmaximize', save);
  mainWin.on('close', save);
  mainWin.once('ready-to-show', () => { mainWin.show(); splash?.destroy(); splash = null; });
  mainWin.on('page-title-updated', (e, title) => { e.preventDefault(); title = title.replace(/j-anime/gi, 'MoraAnime');
    mainWin.setTitle(/MoraAnime/.test(title) ? title : `${title} · MoraAnime`); });
  return mainWin;
}

// ── 应用更新（electron-updater → GitHub Releases）───────────────
async function checkAppUpdate() {
  // 便携版没法原地更新；开发运行也不查。还没发布过的时候查不到，静默
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR || process.env.MORA_NO_UPDATE === '1') return;
  try {
    const { default: updater } = await import('electron-updater');
    const au = updater.autoUpdater;
    au.logger = { info: (m) => log('[updater]', String(m)), warn: (m) => log('[updater]', String(m)),
                  error: (m) => log('[updater]', String(m)), debug: () => {} };
    au.autoDownload = true;
    au.autoInstallOnAppQuit = true;
    au.on('error', (e) => log('[updater] 检查更新失败（静默）', String(e?.message || e)));
    au.on('update-downloaded', (info) => log(`[updater] 新版本 ${info.version} 已下载，退出时安装`));
    await au.checkForUpdates().catch((e) => log('[updater] 检查更新失败（静默）', String(e?.message || e)));
  } catch (e) {
    log('[updater] 不可用', String(e?.message || e));
  }
}

// ── 主流程 ─────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { quitting = true; stopServer(); });
  process.on('exit', stopServer);

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const t0 = Date.now();
    showSplash();
    try {
      await ensureCatalog();
      splashMsg('正在准备数据库');
      runNode(MIGRATE);
      const { token } = JSON.parse(runNode(join(HERE, 'db-tasks.js'), ['bootstrap']).trim().split('\n').pop());
      port = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      splashMsg('正在启动');
      startServer();
      if (!(await waitHealthy())) throw new Error(`本地服务没有起来，日志：${join(LOGS, 'server.log')}`);
      await session.defaultSession.cookies.set({ url: origin, name: COOKIE, value: token, httpOnly: true,
        sameSite: 'lax', expirationDate: Math.floor(Date.now() / 1000) + 90 * 24 * 3600 });
      const win = createWindow(origin);
      await win.loadURL(origin + '/');
      log(`启动完成 ${Date.now() - t0}ms`);
      writeState({ lastStartupMs: Date.now() - t0 });
      setTimeout(() => { checkCatalogUpdate(); checkAppUpdate(); }, 5000);
    } catch (e) {
      log('启动失败', String(e?.stack || e));
      dialog.showErrorBox('MoraAnime 启动失败', String(e?.message || e));
      app.exit(1);
    }
  });
}

// 测试钩子：MORA_TEST_HOOKS=1 时把几个内部函数挂到 global，供 Playwright 的 electron.evaluate 调
if (process.env.MORA_TEST_HOOKS === '1') {
  globalThis.__mora = { checkCatalogUpdate, home: HOME, logs: LOGS, port: () => port, serverPid: () => server?.pid ?? null };
}
