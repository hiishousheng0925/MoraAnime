/**
 * MoraAnime 主进程：把网站（SvelteKit adapter-node 产物）搬到用户电脑上跑。
 *
 * 启动顺序：
 *   1. 番剧库：没有就下载（首次启动）；上次后台下好的新版本在这里换上（db-tasks apply）
 *   2. scripts/migrate.js（应用自己不跑 initSchema，缺列会 500 —— 和网站的启动脚本同一个道理）
 *   3. db-tasks bootstrap：确保本地账号、建会话令牌
 *   4. 子进程跑服务：ELECTRON_RUN_AS_NODE=1 + process.execPath = 同一个 exe 当 Node 用，听 127.0.0.1 固定端口
 *      （首次随机取、记进 state.json，之后一直用它；被占了才换）
 *   5. 窗口塞会话 cookie、加载首页；之后后台检查番剧库更新（每天最多一次）和应用更新
 *
 * 环境变量（都可选，开发 / 测试用）：
 *   MORA_HOME         客户端用户目录，缺省 %APPDATA%\MoraAnime（数据在 <它>\data）
 *   MORA_CATALOG_URL  番剧库 manifest 地址（见 catalog.js）
 *   MORA_NO_UPDATE=1  不检查应用更新
 */
import { app, BrowserWindow, dialog, ipcMain, net, session, shell, Menu } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchManifest, downloadCatalog, recoverInterruptedSwap } from './catalog.js';

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
const serverLog = join(LOGS, 'server.log');
// 日志轮转（2026-10-22 审查）：原来只追加不清理，服务的 stderr（片源解析报错之类）常年累积会越长越大。
// 启动时超过 5MB 就把旧的改名成 .1（只留一份，覆盖上一份 .1），再从空文件开始。
// 拿到单实例锁之后才调：第二个实例不能去改名第一个实例正在写的日志
function rotateLogs() {
  for (const f of [logFile, serverLog]) {
    try { if (statSync(f).size > 5 * 1048576) renameSync(f, f + '.1'); } catch { /* 没有文件 / 被占用：这次不轮转 */ }
  }
}
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
  try { appendFileSync(logFile, line); } catch { /* 日志写不进不影响运行 */ }
  if (!app.isPackaged) process.stdout.write(line);
}
const readState = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; } };
// 写不进（磁盘满、杀毒软件锁着文件）只记日志：state.json 里都是「记住窗口位置」这类可有可无的东西，
// 原来不包 try，在窗口 resize / move 回调里抛出来就是主进程的报错框（2026-10-22 审查）
const writeState = (patch) => {
  try {
    const s = { ...readState(), ...patch };
    writeFileSync(STATE + '.part', JSON.stringify(s, null, 2)); renameSync(STATE + '.part', STATE);
  } catch (e) { log('写 state.json 失败（不影响使用）', String(e?.message || e)); }
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
  return nodeResult(script, args, r);
}
/** 运行中（窗口已经开着）要跑 db-tasks 时用异步版：spawnSync 会把主进程卡住，窗口跟着没响应 */
function runNodeAsync(script, args = [], extra = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [script, ...args], { cwd: APP_DIR, env: childEnv(extra), windowsHide: true });
    let stdout = '', stderr = '';
    c.stdout.on('data', (b) => { stdout += b; }); c.stderr.on('data', (b) => { stderr += b; });
    c.on('error', reject);
    c.on('close', (status) => { try { resolve(nodeResult(script, args, { status, stdout, stderr })); } catch (e) { reject(e); } });
  });
}
function nodeResult(script, args, r) {
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
  // 上次换库在两次改名之间断电：先把库接回来，否则下面会当成首次启动下载空库（2026-10-22 审查，见 catalog.js）
  try {
    const r = recoverInterruptedSwap(DATA);
    if (r) log('检测到上次换库中断，已恢复', r);
  } catch (e) { log('恢复中断的换库失败', String(e?.stack || e)); }
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
// 端口固定（2026-10-22 审查）：原来每次启动随机取 → origin 每次不同 → 网站存在 localStorage 里的偏好
// （主题、倍速、音量、超分档、画质）每次重启都丢，service worker / 缓存每个 origin 各装一份越积越多。
// 现在首次随机取一个记进 state.json，之后先试这个；被别的程序占了才另取、记下新的
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
/** 只在 127.0.0.1 上试能不能 listen（服务也只听这个地址） */
function canListen(p) {
  return new Promise((resolve) => {
    const s = createServer();
    s.unref();
    s.once('error', () => resolve(false));
    s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
async function pickPort() {
  const saved = Number(readState().port);
  if (Number.isInteger(saved) && saved > 1024 && saved < 65536 && await canListen(saved)) return saved;
  const p = await freePort();
  if (saved) log(`端口 ${saved} 被占用，改用 ${p}`);
  writeState({ port: p });
  return p;
}

let server = null, port = 0, origin = '', quitting = false;
let sessionToken = null;
const crashes = [];

/** 把会话 cookie 塞给当前 origin（启动、换端口、重新登录都走这里） */
function setSessionCookie() {
  return session.defaultSession.cookies.set({ url: origin, name: COOKIE, value: sessionToken, httpOnly: true,
    sameSite: 'lax', expirationDate: Math.floor(Date.now() / 1000) + 90 * 24 * 3600 });
}

function startServer() {
  origin = `http://127.0.0.1:${port}`;
  const env = childEnv({ HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin, BODY_SIZE_LIMIT: '50M', J_ANIME_BRAND: 'MoraAnime', J_ANIME_DESKTOP: '1', J_ANIME_APP_VERSION: app.getVersion() });
  const out = serverLog;
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
      // 端口被别的程序占了（服务退出的间隙被抢走，或者本来就是因为 EADDRINUSE 起不来）：原来原样重启会连崩 5 次
      // 然后退出。重启前先试，被占就换端口 → 新 origin 要重新塞 cookie、主窗口跳到新地址（2026-10-22 审查）。
      // 换了端口 = 换了 origin，这次运行里 localStorage 的偏好在新 origin 下看不到，下次启动起就固定在新端口上
      let moved = false;
      if (!(await canListen(port))) {
        const old = port;
        port = await freePort();
        writeState({ port });
        log(`重启服务：端口 ${old} 被占用，改用 ${port}`);
        moved = true;
      }
      if (quitting) return;
      startServer();
      if (!(await waitHealthy())) return;
      if (!mainWin || mainWin.isDestroyed()) return;
      if (moved) {
        await setSessionCookie().catch((e) => log('换端口后设置会话 cookie 失败', String(e?.message || e)));
        let path = '/';
        try { const u = new URL(mainWin.webContents.getURL()); path = u.pathname + u.search + u.hash; } catch { /* 用首页 */ }
        mainWin.loadURL(origin + path).catch(() => {});
      } else mainWin.webContents.reload();
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

function createWindow() {
  const ws = windowBounds();
  mainWin = new BrowserWindow({
    ...ws.bounds, minWidth: 900, minHeight: 600, show: false, title: 'MoraAnime', backgroundColor: '#18181b',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false, preload: join(HERE, 'preload.cjs') }
  });
  if (ws.maximized) mainWin.maximize();
  // 读全局 origin（不是建窗口时的快照）：服务崩溃重启可能换了端口
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
// 每次启动查一次；有新版本就弹窗：版本号 + 几行更新内容（desktop/release-notes.json，打包时写进 latest.yml）。
//   立即更新 → 下载（任务栏进度）→ 静默安装并自动重新打开
//   关闭     → 这次不更新；不在退出时偷偷装，下次打开照样再弹（主人 2026-10-21 定的）
// 原来是后台下载完才问「立即重启 / 稍后」、稍后就退出时静默装 —— 用户看不到更新了什么，关掉也照样被装上。
// 便携版没法原地更新：「立即更新」打开最新便携版的下载链接。
// MORA_UPDATE_URL：测试用，改从这个地址（generic 源）读 latest.yml
const DOWNLOAD = 'https://github.com/hiishousheng0925/MoraAnime/releases/latest/download/';

/** latest.yml 里的 releaseNotes（字符串；拿不到时 GitHub 源会退回 release 正文的 HTML）→ 最多 6 行纯文本 */
function notesList(n) {
  if (Array.isArray(n)) n = n[0]?.note ?? '';
  return String(n ?? '').replace(/<br\s*\/?>|<\/(p|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
    .split(/\r?\n/).map((l) => l.replace(/^[•\-*]\s*/, '').trim()).filter(Boolean).slice(0, 6);
}

async function checkAppUpdate() {
  const feed = process.env.MORA_UPDATE_URL;
  if ((!app.isPackaged && !feed) || process.env.MORA_NO_UPDATE === '1') return;
  const portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  try {
    const { default: updater } = await import('electron-updater');
    const au = updater.autoUpdater;
    au.logger = { info: (m) => log('[updater]', String(m)), warn: (m) => log('[updater]', String(m)),
                  error: (m) => log('[updater]', String(m)), debug: () => {} };
    au.autoDownload = false;
    au.autoInstallOnAppQuit = false;
    if (feed) { au.forceDevUpdateConfig = true; au.setFeedURL({ provider: 'generic', url: feed }); }
    au.on('error', (e) => log('[updater] 出错', String(e?.message || e)));
    au.once('update-available', (info) => {
      pendingUpdate = { au, info, portable };
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('mora:update', info.version);
      promptUpdate(au, info, portable);
    });
    await au.checkForUpdates().catch((e) => log('[updater] 检查更新失败（静默）', String(e?.message || e)));
  } catch (e) {
    log('[updater] 不可用', String(e?.message || e));
  }
}

// 检查到的新版本（右上角提示 + 重新打开弹窗用）；关掉弹窗后它还在，提示一直挂着直到更新
// updPercent：下载进度，重新打开弹窗时直接显示；updListening：au 的进度 / 完成监听只挂一次
let pendingUpdate = null, updDlg = null, updDownloading = false, updPercent = 0, updListening = false, updInstalling = false;
ipcMain.handle('mora:update-state', () => pendingUpdate?.info.version ?? null);
ipcMain.handle('mora:pick-folder', async (_e, defaultPath) => {
  const r = await dialog.showOpenDialog(mainWin, { title: '选择截图保存位置', defaultPath: defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0] ?? null;
});
ipcMain.on('mora:open-update', () => { if (pendingUpdate) promptUpdate(pendingUpdate.au, pendingUpdate.info, pendingUpdate.portable); });

// 会话失效后的出路（2026-10-22 审查）：内置账号 me 的密码是随机的，会话行被删 / cookie 被清之后页面弹登录框，
// 用户却不知道密码。网站桌面模式的 requireLogin() 调 mora.relogin()：这里重跑一遍 bootstrap 建新会话、塞 cookie、
// 刷新主窗口。只认本机页面发来的请求；并发的几次合成一次
let relogging = null;
ipcMain.handle('mora:relogin', async (e) => {
  try { if (new URL(e.senderFrame?.url ?? '').origin !== origin) return false; } catch { return false; }
  relogging ??= (async () => {
    try {
      sessionToken = JSON.parse((await runNodeAsync(join(HERE, 'db-tasks.js'), ['bootstrap'])).trim().split('\n').pop()).token;
      await setSessionCookie();
      log('会话失效，已重新建会话');
      // 先把 true 回给页面再刷新（同步 reload 会让这次 invoke 的回复落空）
      setTimeout(() => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.reload(); }, 100);
      return true;
    } catch (err) {
      log('重新建会话失败', String(err?.message || err));
      return false;
    } finally { relogging = null; }
  })();
  return relogging;
});

// 弹窗跟着客户端当前主题走：从主窗口读 --c-* 变量传给 update.html
const THEME_VARS = ['--c-bg', '--c-surface', '--c-surface-2', '--c-border', '--c-text', '--c-text-soft',
  '--c-muted', '--c-accent', '--c-on-accent', '--c-danger'];

/**
 * 客户端样式的更新弹窗（desktop/update.html）：透明窗口盖住主窗口 = 遮罩 + 居中卡片。
 * 主人 2026-10-21：不要 Windows 原生弹窗（「很丑」），要和客户端的 UI 一致。
 * 页面按钮改 location.hash（#now / #later / #web），这里监听 did-navigate-in-page；进度用 executeJavaScript 推过去
 */
async function promptUpdate(au, info, portable) {
  const win = mainWin && !mainWin.isDestroyed() ? mainWin : null;
  if (!win) return;
  if (updDlg && !updDlg.isDestroyed()) { updDlg.focus(); return; }
  log(`[updater] 有新版本 ${info.version}，弹窗`);
  const theme = await win.webContents.executeJavaScript(
    `(() => { const s = getComputedStyle(document.documentElement);
       return Object.fromEntries(${JSON.stringify(THEME_VARS)}.map((k) => [k, s.getPropertyValue(k).trim()])); })()`)
    .catch(() => ({}));
  const b = win.getContentBounds();
  const dlg = new BrowserWindow({ parent: win, modal: true, frame: false, transparent: true, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, skipTaskbar: true, show: false,
    x: b.x, y: b.y, width: b.width, height: b.height, title: 'MoraAnime 更新',
    webPreferences: { sandbox: true, contextIsolation: true, spellcheck: false } });
  updDlg = dlg;
  // 下载中不让关（Alt+F4 也算）：原来关掉弹窗下载照样继续、下完自动装，违背「关闭 = 这次不更新」（2026-10-22 审查）。
  // electron-updater 的下载取消不了，只能下完再说；退出客户端（quitting）时放行
  dlg.on('close', (e) => { if (updDownloading && !quitting) e.preventDefault(); });
  dlg.on('closed', () => { if (updDlg === dlg) updDlg = null; });
  dlg.setMenu(null);
  dlg.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  dlg.webContents.on('will-navigate', (e) => e.preventDefault());
  const run = (js) => { if (!dlg.isDestroyed()) dlg.webContents.executeJavaScript(js).catch(() => {}); };
  // 进度 / 结果推给「当前」的弹窗：关掉再打开后是另一个窗口，推给闭包里的旧 dlg 新弹窗就不动了（2026-10-22 审查）
  const runCur = (js) => { if (updDlg && !updDlg.isDestroyed()) updDlg.webContents.executeJavaScript(js).catch(() => {}); };
  const progressBar = (v) => { if (mainWin && !mainWin.isDestroyed()) mainWin.setProgressBar(v); };
  const link = DOWNLOAD + (portable ? 'MoraAnime-portable.exe' : 'MoraAnime-Setup.exe');

  const download = () => {
    if (updDownloading || updInstalling) return;
    updDownloading = true;
    updPercent = 0;
    log('[updater] 用户选择立即更新，开始下载');
    runCur('progress(0)');
    // 监听只挂一次：原来每调一次 download() 多挂一组，下载失败后重试会 quitAndInstall 两次
    if (!updListening) {
      updListening = true;
      au.on('download-progress', (p) => {
        updPercent = p.percent;
        runCur(`progress(${p.percent})`);
        progressBar(p.percent / 100);
      });
      au.on('update-downloaded', () => {
        if (updInstalling || quitting) return;
        updInstalling = true;
        updDownloading = false;
        log('[updater] 下载完成，安装并重启');
        runCur('progress(100)');
        setTimeout(() => au.quitAndInstall(true, true), 800);
      });
    }
    au.downloadUpdate().catch((e) => {
      const msg = String(e?.message || e).slice(0, 200);
      log('[updater] 下载失败', msg);
      updDownloading = false;
      progressBar(-1);
      runCur(`failed(${JSON.stringify(msg)})`);
    });
  };
  dlg.webContents.on('did-navigate-in-page', (_e, url) => {
    const a = new URL(url).hash.slice(1).split('-')[0];
    if (a === 'later') { log('[updater] 用户关闭了更新弹窗，下次启动再提示'); dlg.close(); }
    else if (a === 'web') { shell.openExternal(link); dlg.close(); }
    else if (a === 'now') {
      if (portable) { log('[updater] 便携版：打开下载链接'); shell.openExternal(link); dlg.close(); }
      else download();
    }
  });
  await dlg.loadFile(join(HERE, 'update.html'));
  run(`init(${JSON.stringify({ version: info.version, current: app.getVersion(), notes: notesList(info.releaseNotes), theme })})`);
  // 正在下载 / 已下完待安装时重新打开（下载中关不掉，保险起见）：直接显示进度
  if (updDownloading || updInstalling) run(`progress(${updInstalling ? 100 : updPercent})`);
  dlg.show();
  dlg.focus();
}

// ── 主流程 ─────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  rotateLogs();
  // 启动画面期间（mainWin 还没建）双击图标原来没反应：聚焦启动画面（2026-10-22 审查）
  app.on('second-instance', () => {
    const w = mainWin && !mainWin.isDestroyed() ? mainWin : splash && !splash.isDestroyed() ? splash : null;
    if (!w) return;
    if (w.isMinimized()) w.restore();
    if (w !== splash || splashReady) w.show();
    w.focus();
  });
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
      sessionToken = JSON.parse(runNode(join(HERE, 'db-tasks.js'), ['bootstrap']).trim().split('\n').pop()).token;
      port = await pickPort();
      splashMsg('正在启动');
      startServer();
      if (!(await waitHealthy())) throw new Error(`本地服务没有起来，日志：${serverLog}`);
      await setSessionCookie();
      // 以前每个随机端口（= 每个 origin）各装一份 service worker + Cache Storage（用户真机 90MB / 10 份）；
      // 桌面模式已不注册 service worker，每次启动都把这两类清掉（清了无害，旧 origin 的残留也一并清走，不用记标记）。
      // 只清这两类：localStorage（主题等偏好，固定端口后就靠它）和 cookie（会话）不动（2026-10-22 审查）
      await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })
        .catch((e) => log('清理 service worker 缓存失败（不影响使用）', String(e?.message || e)));
      const win = createWindow();
      await win.loadURL(origin + '/');
      log(`启动完成 ${Date.now() - t0}ms`);
      writeState({ lastStartupMs: Date.now() - t0 });
      // 应用更新只读一个 latest.yml，开窗口后很快就能弹（原来 5 秒后才查、旧版还要先下完安装包，主人实测约 20 秒）
      setTimeout(checkAppUpdate, 1500);
      setTimeout(checkCatalogUpdate, 5000);
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
