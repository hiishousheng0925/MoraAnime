/**
 * 隔离测试运行器。
 *
 * ⚠️ 为什么必须有这个：早先 tests/e2e.js 直接跑在应用数据库上，
 * 而它开头就 DELETE user_entry / watch_log / triage —— 每跑一次测试
 * 就把主人的番单清空一次，且不可恢复。这是绝对不能再发生的事。
 *
 * 做法：把数据库复制一份到临时文件，用 J_ANIME_DB 指向副本另起一个
 * dev server（另一个端口），测试全程只碰副本，结束后删掉。
 * 主库全程只读：复制用只读连接 + VACUUM INTO（连 WAL 里没合并的一起拿到），
 * 不 checkpoint、不写主库（原来复制前会对主库跑 wal_checkpoint，那也是一次写）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { VITE_BIN, killTree } from './platform.js';
import { DATA_DIR } from '../src/lib/server/paths.js';
import { copyDbSnapshot } from './site.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 主库在 DATA_DIR（J_ANIME_DATA → ~/.j-anime.env → 旧布局的 data/），和正式站同一个来源
const MAIN_DB = join(DATA_DIR, 'j-anime.db');
const PORT = Number(process.env.TEST_PORT) || 5199;

// 参数：node scripts/test.js [suite] [--build <dir>]
//   suite      默认 e2e，可给 stats-audit
//   --build    打构建产物而不是 vite dev（发布闸门用）
const argv = process.argv.slice(2);
const bi = argv.indexOf('--build');
const BUILD_DIR = bi >= 0 ? argv[bi + 1] : null;
const SUITE = (() => {
  // ⚠️ bi 为 -1（没给 --build）时不能拿它去过滤 —— i !== bi + 1 会变成 i !== 0，
  // 把第一个参数（套件名）吃掉，于是 `test.js stats-audit` 静默跑成 e2e
  // 其它 --开关（--no-unit、--server-log）也不能当套件名
  const rest = (bi >= 0 ? argv.filter((a, i) => i !== bi && i !== bi + 1) : argv).filter((a) => !a.startsWith('--'));
  return rest[0] ? `tests/${rest[0].replace(/\.js$/, '')}.js` : 'tests/e2e.js';
})();
// 先清掉以前没删成的副本（每个 ~230MB；2026-10-21 实测攒了 307 个 / 68GB）。只动 6 小时前的，不碰正在并行跑的测试
for (const n of readdirSync(tmpdir())) {
  if (!n.startsWith('j-anime-test-')) continue;
  const p = join(tmpdir(), n);
  try { const st = statSync(p); if (st.isDirectory() && Date.now() - st.mtimeMs > 6 * 3600_000) rmSync(p, { recursive: true, force: true }); } catch {}
}
const tmp = mkdtempSync(join(tmpdir(), 'j-anime-test-'));
const TEST_DB = join(tmp, 'test.db');
const COPY_TOKEN = randomBytes(12).toString('hex');

if (!existsSync(MAIN_DB)) { console.error('❌ 找不到主库，先跑 npm run db:init'); process.exit(1); }

console.log('📋 复制数据库到临时副本…');
await copyDbSnapshot(MAIN_DB, TEST_DB);
// 副本会带着主人设的「默认筛选」（目录的存在 saved_filter.is_default，季度浏览的存在 setting）——
// 那会让 /catalog 重定向到他的筛选，实测把 e2e 和 prod-smoke 都测成 0 条。
// 这是环境隔离，放在这里清一次，各套测试不用各写一遍。
spawnSync(process.execPath, ['-e', `
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(${JSON.stringify(TEST_DB)});
  d.exec("DELETE FROM setting WHERE key LIKE 'default_filter:%'");
  // 多账号后（2026-10-19）saved_filter 是视图、要 uid()（这条裸连接没有），默认筛选也搬进了 user_setting：
  // 有真表就改真表。原来这句在迁移过的正式库上抛错，后面的副本标记没写上，e2e 被闸门拒跑
  const has = (t) => d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  d.exec(has('saved_filter_all') ? "UPDATE saved_filter_all SET is_default = 0" : "UPDATE saved_filter SET is_default = 0");
  if (has('user_setting')) d.exec("DELETE FROM user_setting WHERE key LIKE 'default_filter:%'");
  // 副本标记：各套测试据此确认打开的是这份副本（tests/copy-gate.js，#41）
  d.prepare("INSERT INTO meta (key,value) VALUES ('test_copy', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
   .run(${JSON.stringify(COPY_TOKEN)});
`], { stdio: 'inherit' });
console.log(`   副本: ${TEST_DB}（已清掉默认筛选）`);

// 副本先跑一遍迁移（#40）：原来不跑，新加的迁移列要么让构建产物测试缺列 500，
// 要么得靠正式库已被当晚同步提前迁移过 —— 测试结果取决于正式库的状态，不该这样
const mig = spawnSync(process.execPath, [join(ROOT, 'scripts/migrate.js')],
  { env: { ...process.env, J_ANIME_DB: TEST_DB }, encoding: 'utf8' });
if (mig.status !== 0) { console.error('❌ 副本迁移失败\n' + mig.stderr); rmSync(tmp, { recursive: true, force: true }); process.exit(1); }

/**
 * 多账号（2026-10-19）：测试以管理员（id 1，正式库迁移时番单都归它）的身份跑。
 *   · 测试进程里直接调 queries/* 的 → J_ANIME_AS_USER=1（见 userCtx.js）
 *   · 打 HTTP 的 → 副本里直接建一个会话，令牌经 TEST_SESSION 传给测试脚本（e2e 给 fetch 统一带上）
 * 管理员密码改成本轮随机的 TEST_PASSWORD：prod-smoke 要走一遍真的登录。
 */
const { hashPassword } = await import('../src/lib/server/password.js');
const TEST_PW = 'test-' + randomBytes(6).toString('hex');
const SESSION = randomBytes(24).toString('base64url');
{
  const { DatabaseSync } = await import('node:sqlite');
  const { createHash } = await import('node:crypto');
  const d = new DatabaseSync(TEST_DB);
  if (!d.prepare('SELECT 1 FROM account WHERE id = 1').get())
    d.prepare("INSERT INTO account (id, username, role) VALUES (1, 'admin', 'admin')").run();
  // 用户名也钉成 admin：正式库里叫什么（J_ANIME_ADMIN_USER）不该影响测试
  d.prepare("UPDATE account SET pw_hash = ?, role = 'admin', username = 'admin' WHERE id = 1").run(hashPassword(TEST_PW));
  d.prepare("INSERT INTO session (token_hash, user_id, expires_at) VALUES (?, 1, datetime('now', '+1 day'))")
    .run(createHash('sha256').update(SESSION).digest('hex'));
  d.close();
}

// 纯函数单元测试先跑（秒级）：挂了就不用再起服务器等几分钟
if (!process.argv.includes('--no-unit')) {
  const u = spawnSync(process.execPath, ['--test', 'tests/unit/*.test.js'], { cwd: ROOT, encoding: 'utf8' });
  const sum = (u.stdout.match(/ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/) || []).slice(1).join(' / ');
  console.log(`🧪 单元测试 通过/失败 ${sum || '?'}`);
  if (u.status !== 0) { console.error(u.stdout.split('\n').filter((l) => /✖|not ok|Error|expected|actual/.test(l)).join('\n'));
    rmSync(tmp, { recursive: true, force: true }); process.exit(1); }
}

const env = { ...process.env, J_ANIME_DB: TEST_DB, PORT: String(PORT),
              J_ANIME_BACKUPS: join(tmp, 'backups'), TEST_COPY_TOKEN: COPY_TOKEN,   // 导入前的自动备份别写进正式备份目录
              TEST_SESSION: SESSION, TEST_PASSWORD: TEST_PW };
// 环境里可能带着真实密码（release 曾把 .j-anime.env 整份读进环境）—— 显式清掉，
// 免得空密码管理员的兜底登录（auth.js: login）认到真密码上
delete env.J_ANIME_PASSWORD;

let server;
if (BUILD_DIR) {
  // 生产构建必须显式给 ORIGIN，否则 adapter-node 把协议当成 https，
  // 表单 POST 全被 CSRF 挡掉 —— 这正是「登录永远 403」那个 bug
  env.ORIGIN = `http://localhost:${PORT}`;
  // 和 deploy/run-app.ps1 同一个请求体上限：截图 PNG 一两 MB，adapter-node 缺省 512K 会拒掉
  env.BODY_SIZE_LIMIT ??= '50M';
  env.HOST = '127.0.0.1';
  env.J_ANIME_DATA = DATA_DIR;   // 封面目录用真实的（只读）
  console.log(`🚀 用副本启动【构建产物】${BUILD_DIR} :${PORT}…`);
  server = spawn(process.execPath, [join(ROOT, BUILD_DIR, 'index.js')],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
} else {
  console.log(`🚀 用副本启动 dev server :${PORT}…`);
  server = spawn(process.execPath, [VITE_BIN, 'dev', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

let ready = false;
// 服务端崩了要能看见原因 —— 否则测试只报一句 fetch failed / ECONNRESET，
// 完全不知道是哪个请求把进程打死的（实测排查一次花了半小时）
const SHOW = process.argv.includes('--server-log');
const onOut = (b) => {
  const t = String(b);
  if (t.includes(`:${PORT}`) || t.includes('Listening on')) ready = true;
  if (SHOW) process.stderr.write('  [server] ' + t);
};
server.stdout.on('data', onOut);
server.stderr.on('data', onOut);

// Windows 上 kill() 发完信号就返回，服务进程还开着 test.db，紧接着 rmSync 删不掉、错误又被吞 →
// 每跑一次留一个副本。所以按 PID 杀树（taskkill 同步等它结束），再给句柄释放留几次重试
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let cleaned = false;
const cleanup = () => {
  if (cleaned) return; cleaned = true;
  try { killTree(server.pid); } catch {}
  for (let i = 0; i < 10; i++) {
    try { rmSync(tmp, { recursive: true, force: true }); if (!existsSync(tmp)) break; } catch {}
    sleepSync(500);
  }
  if (existsSync(tmp)) console.error(`⚠️ 临时副本没删掉：${tmp}`);
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

for (let i = 0; i < 40 && !ready; i++) await new Promise((r) => setTimeout(r, 500));
// 再确认能真的响应
let up = false;
for (let i = 0; i < 20 && !up; i++) {
  try { up = (await fetch(`http://localhost:${PORT}/`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!up) { console.error('❌ 测试服务器起不来'); cleanup(); process.exit(1); }
console.log('   就绪\n');


// TEST_BUILD 告诉套件「现在打的是构建产物」—— 有些断言只在产物上成立，
// 比如 /_app/version.json 是构建时生成的，vite dev 不提供
const r = spawnSync(process.execPath, [join(ROOT, SUITE)],
  // J_ANIME_AS_USER 只给测试进程（它直接调 queries/*），不给服务端 —— 服务端的身份只认会话
  { cwd: ROOT, env: { ...env, BASE: `http://localhost:${PORT}`, TEST_BUILD: BUILD_DIR || '', J_ANIME_AS_USER: '1' },
    stdio: 'inherit' });

cleanup();
if (!existsSync(tmp)) console.log('\n🧹 已删除临时副本，主库未被触碰');
process.exit(r.status ?? 1);
