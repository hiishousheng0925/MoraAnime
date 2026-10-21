/**
 * 测试站：拿【当前源码】构建一份，用 data/dev.db 跑在 :3001，手机也能看。
 *
 * 和正式站的区别只有三处：库、端口、产物目录 —— 共用同一个 run-app.sh。
 *   正式站  <站点>/current  <数据>/j-anime.db  :3000   npm run release 才会更新
 *   测试站  build.staging/  <数据>/dev.db      :3001   npm run staging 随时更新
 * <数据> = paths.js 的 DATA_DIR（切换到站点目录后是 <站点>/data）；测试站用开发目录的 node_modules
 *
 * 典型流程：改代码 → npm run staging → 手机上看 → 满意 → npm run release
 *
 * 用法：
 *   node scripts/staging.js                  # 构建并启动/重启
 *   node scripts/staging.js --stop           # 停掉
 *   node scripts/staging.js --reset-db       # 重新从正式库取一份目录（番单清空）
 *   node scripts/staging.js --with-my-data   # 建库时连番单一起复制（配 --reset-db 用）
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, statSync, openSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteUp } from './site-url.js';
import { sourceFingerprint } from './source-hash.js';
import { snapshotSync } from './snapshot.js';
import { IS_WIN, VITE_BIN, killTree, spawnBackgroundWin, processCmdline, pidOnPort } from './platform.js';
import { DATA_DIR } from '../src/lib/server/paths.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.STAGING_PORT || '3001';
const PIDFILE = join(DATA_DIR, 'staging.pid');
const LOG = join(DATA_DIR, 'staging.log');
const sh = (c, a, o = {}) => spawnSync(c, a, { cwd: ROOT, stdio: 'inherit', ...o });

/**
 * 为什么不用 launchd：既不 RunAtLoad 也不 KeepAlive 的按需任务，
 * launchd 会当成「没有任何触发条件」把它卸掉 —— 实测起来后几十秒就消失。
 * 而设 RunAtLoad 就变成开机常驻，测试站不该占那份资源。
 * 普通后台进程 + pidfile 正好：终端关掉也活着，开机不自启。
 */
const stop = () => {
  let stopped = false;
  if (existsSync(PIDFILE)) {
    const pid = +readFileSync(PIDFILE, 'utf8').trim();
    // ⚠️ Windows 上先核对这个 PID 还是不是测试站（#45）：重启后 PID 会被复用，
    // 不核对就 taskkill /T 会把占用这个号的进程连同整棵树杀掉（本机常驻 larkBot 等）
    if (!IS_WIN || /run-app\.ps1/i.test(processCmdline(pid))) { killTree(pid); stopped = true; }
    else console.log(`   pidfile 里的 PID ${pid} 已不是测试站，跳过`);
    try { unlinkSync(PIDFILE); } catch {}
  }
  // 兜底：pidfile 丢了但端口上还挂着测试站的 node（命令行里有 build.staging）也要停掉
  if (IS_WIN) for (const p of pidOnPort(PORT))
    if (/build\.staging/.test(processCmdline(p))) { killTree(p); stopped = true; }
  return stopped;
};

if (process.argv.includes('--stop')) {
  console.log(stop() ? '✅ 测试站已停' : 'ℹ️ 测试站没在跑');
  process.exit(0);
}

// dev.db 是测试站的库；没有就从正式库复制一份（只读正式库这一下）。
// 复制的是【动漫目录】—— 4 万条番、封面、facet 缓存，这些重造一遍要几十分钟。
// 个人记录（番单/待标记/日志/我的筛选）复制完就清空：测试站该是一张白纸，
// 否则「测试站的我的番单和正式站一样」，看不出自己在测试站到底标了什么。
// 需要真实数据量来看统计时：--reset-db --with-my-data。
const PROD_DB = join(DATA_DIR, 'j-anime.db');
const DEV_DB = join(DATA_DIR, 'dev.db');
/**
 * 主人自己产生的数据 —— 不带 --with-my-data 时清空，测试站要是一张白纸。
 * ⚠️ 新加「主人自己填的」表时必须加进来，e2e 有一条断言盯着这个清单。
 * watch_site（自配的观看站）和 manual_relation（手动关联的系列）漏了一段时间：
 * 不清空的话测试站会带着正式站的配置，看不出自己在测试站到底改了什么。
 */
// 多账号后个人数据在 *_all 真表里（同名的是视图，这里的裸连接没注册 uid()，删不动）；
// 账号本身保留 —— 测试站照样用正式站的账号密码登录。旧表名留着，兼容还没迁移的库
const PERSONAL = ['user_entry_all', 'triage_all', 'watch_log_all', 'user_tag_all', 'saved_filter_all',
                  'user_setting', 'session', 'setting', 'watch_site', 'manual_relation',
                  'user_entry', 'triage', 'watch_log', 'user_tag', 'saved_filter'];

if (process.argv.includes('--reset-db')) {
  // ⚠️ 先停测试站再删库：Windows 上被进程打开着的文件删不掉（EBUSY），原来先删后停，
  // 删除抛错整个脚本退出，--reset-db 在 Windows 上从来没生效过
  stop();
  for (const f of [DEV_DB, DEV_DB + '-wal', DEV_DB + '-shm'])
    if (existsSync(f)) unlinkSync(f);
  console.log('🗑 已删掉旧 dev.db，重新取一份');
}

if (!existsSync(DEV_DB)) {
  if (!existsSync(PROD_DB)) { console.error('❌ 找不到正式库'); process.exit(1); }
  spawnSync(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    new DatabaseSync(${JSON.stringify(PROD_DB)}).exec('PRAGMA wal_checkpoint(TRUNCATE)');
  `], { stdio: 'ignore' });
  copyFileSync(PROD_DB, DEV_DB);
  console.log(`📋 已从正式库复制 dev.db (${(statSync(DEV_DB).size / 1048576).toFixed(0)} MB)`);

  if (process.argv.includes('--with-my-data')) {
    console.log('   保留了正式站的个人记录（--with-my-data）');
  } else {
    const wiped = spawnSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(DEV_DB)});
      let n = 0;
      for (const t of ${JSON.stringify(PERSONAL)}) {
        try { n += db.prepare('DELETE FROM ' + t).run().changes; } catch {}
      }
      db.exec('VACUUM');
      process.stdout.write(String(n));
    `], { cwd: ROOT, encoding: 'utf8' });
    console.log(`🧹 已清空测试站的个人记录 ${wiped.stdout || 0} 条（番单/待标记/日志/我的筛选）`);
  }
}

console.log('▶ 构建当前源码到 build.staging/…');
if (sh(process.execPath, [VITE_BIN, 'build'], { env: { ...process.env, BUILD_OUT: 'build.staging' } }).status !== 0) {
  console.error('❌ 构建失败');
  process.exit(1);
}
// 记下这份产物是哪份源码构建的 —— 发布闸门据此拒绝「测试站没验过就发正式站」
const fp = sourceFingerprint();
writeFileSync(join(ROOT, 'build.staging/.source-hash'),
  JSON.stringify({ hash: fp.hash, files: [...fp.files], at: new Date().toISOString() }));
console.log(`   源码指纹 ${fp.hash}`);
snapshotSync(ROOT, join(ROOT, 'build.staging'));   // 测试站的迁移跑这份快照，和正式站同一套机制（#38）

stop();   // 旧进程先退，端口才腾出来
if (IS_WIN) {
  // 新进程拿不到这边的环境变量，测试站要用到的几个显式 set 进去
  // J_ANIME_DATA 总是显式给：DATA_DIR 可能来自 .j-anime.env，也可能是旧布局的回退值，测试站要和这里一致
  const pass = ['STAGING_PORT', 'J_ANIME_DB'].filter((k) => process.env[k])
    .map((k) => `set "${k}=${process.env[k]}"&& `).join('') + `set "J_ANIME_DATA=${DATA_DIR}"&& `;
  const pid = spawnBackgroundWin(
    `cmd /c set "J_ANIME_STAGING=1"&& ${pass}powershell -NoProfile -ExecutionPolicy Bypass -File ` +
    `"${join(ROOT, 'deploy/run-app.ps1')}" >> "${LOG}" 2>&1`, ROOT);
  if (!pid) { console.error('❌ 后台进程没起来'); process.exit(1); }
  writeFileSync(PIDFILE, String(pid));
} else {
  const log = openSync(LOG, 'a');
  const child = spawn('bash', [join(ROOT, 'deploy/run-app.sh')], {
    cwd: ROOT, detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, J_ANIME_STAGING: '1', J_ANIME_DATA: DATA_DIR }
  });
  writeFileSync(PIDFILE, String(child.pid));
  child.unref();
}

const ip = spawnSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).stdout?.trim().split('\n')[0];
const url = `http://${ip || '127.0.0.1'}:${PORT}`;
process.stdout.write('▶ 等测试站起来…');
let up = false;
for (let i = 0; i < 30 && !up; i++) {
  up = await siteUp(url);
  if (!up) await new Promise((r) => setTimeout(r, 1000));
}
console.log('');
if (!up) { console.error(`❌ 起不来，看日志：${LOG}`); process.exit(1); }

console.log(`\n✅ 测试站  ${url}`);
console.log(`   库 ${DEV_DB}（随便点，碰不到正式站）· 密码和正式站相同`);
console.log(`   番单是空的；要正式站那份数据：npm run staging -- --reset-db --with-my-data`);
console.log(`   停掉：npm run staging:stop   日志：${LOG}`);
console.log(`   正式站仍是 http://${ip || '127.0.0.1'}:3000\n`);
