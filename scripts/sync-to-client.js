#!/usr/bin/env node
/**
 * 把网站上自己的番单同步到这台电脑的 MoraAnime 客户端（主人 2026-10-23：手动同步做成能自己点的）。
 *
 *   npm run sync:client                     桌面快捷方式「同步番单到客户端」跑的就是这个
 *   node scripts/sync-to-client.js [--user 网站用户名] [--client 客户端库路径]
 *
 * 做法（和之前人工同步一样）：
 *   1. 正式库只读 VACUUM INTO 一份快照（不写正式库）
 *   2. 在快照上以网站账号的身份导出个人记录（番单 / 快速标记 / 观看日志 / 我的筛选 / 个人设置；
 *      观看站、系列顺序、手动关联这些站点级的不带）
 *   3. 客户端库先只读备份一份到 %APPDATA%\MoraAnime\data\backups（留最近 5 份）
 *   4. 以客户端内置账号的身份合并导入（backup.js importData，不带 replace）：
 *      同一部番以网站为准；只在客户端有的保留；观看日志 / 筛选按内容去重
 *   5. 逐条比对番单（状态 / 集数 / 评分），打印结果
 *
 * backup.js 的数据库连接在模块加载时就按 J_ANIME_DB 定了，一个进程只能连一个库，
 * 所以导出 / 导入各起一个子进程（本脚本加 --child-export / --child-import 跑自己）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// 双击快捷方式跑的，别在结果后面挂一句「SQLite is an experimental feature」吓人：先摘掉警告监听再加载 node:sqlite
process.removeAllListeners('warning');
const { DatabaseSync } = await import('node:sqlite');

const SELF = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

// ── 子进程：导出 / 导入 ─────────────────────────────────────
if (argv[0] === '--child-export') {
  const { exportData } = await import('../src/lib/server/backup.js');
  const { asUser } = await import('../src/lib/server/userCtx.js');
  const d = asUser(Number(argv[2]), () => exportData());
  for (const k of ['siteSettings', 'watchSites', 'seriesOrder', 'relations']) delete d[k];
  writeFileSync(argv[1], JSON.stringify(d));
  process.exit(0);
}
if (argv[0] === '--child-import') {
  const { importData } = await import('../src/lib/server/backup.js');
  const { withUser } = await import('../src/lib/server/userCtx.js');
  const [, file, id, username] = argv;
  const s = withUser({ user: { id: Number(id), username, role: 'admin' }, prefs: {} },
    () => importData(JSON.parse(readFileSync(file, 'utf8'))));
  console.log(JSON.stringify({ entries: s.entries, triage: s.triage, logs: s.logs, filters: s.filters, settings: s.settings, unresolved: s.unresolved.length }));
  process.exit(0);
}

// ── 主流程 ─────────────────────────────────────────────────
const { DB_PATH } = await import('../src/lib/server/paths.js');
const CLIENT = opt('--client') || join(process.env.APPDATA || '', 'MoraAnime', 'data', 'j-anime.db');
const die = (m) => { console.error(`\n❌ ${m}`); process.exit(1); };
const sql = (path) => `'${path.replace(/\\/g, '/').replace(/'/g, "''")}'`;

if (!existsSync(DB_PATH)) die(`找不到网站的库：${DB_PATH}`);
if (!existsSync(CLIENT)) die(`找不到客户端的库：${CLIENT}（客户端装好并打开过一次才有）`);

const ro = (p) => new DatabaseSync(p, { readOnly: true });
const site = ro(DB_PATH);
const want = opt('--user');
const siteUser = want
  ? site.prepare('SELECT id, username FROM account WHERE username = ?').get(want)
  : site.prepare("SELECT id, username FROM account WHERE role = 'admin' ORDER BY id LIMIT 1").get();
site.close();
if (!siteUser) die(want ? `网站上没有用户「${want}」` : '网站上没有管理员账号');
const cdb = ro(CLIENT);
const clientUser = cdb.prepare("SELECT id, username FROM account WHERE role = 'admin' ORDER BY id LIMIT 1").get();
cdb.close();
if (!clientUser) die('客户端里还没有账号（先打开一次客户端）');

const tmp = mkdtempSync(join(tmpdir(), 'j-anime-sync-tmp-'));
const child = (args, db) => {
  const r = spawnSync(process.execPath, [SELF, ...args], {
    // J_ANIME_DATA 指临时目录：importData 的安全备份之类不会写进站点目录
    env: { ...process.env, J_ANIME_DB: db, J_ANIME_DATA: tmp, NODE_NO_WARNINGS: '1' }, encoding: 'utf8'
  });
  if (r.status !== 0) die(`${args[0]} 失败：\n${r.stderr || r.stdout}`);
  return r.stdout.trim();
};

try {
  console.log(`🔄 网站「${siteUser.username}」→ 客户端`);
  // 1. 正式库只读快照
  const snap = join(tmp, 'site.db');
  const s = ro(DB_PATH); s.exec(`VACUUM INTO ${sql(snap)}`); s.close();
  // 2. 导出
  const json = join(tmp, 'mine.json');
  child(['--child-export', json, String(siteUser.id)], snap);
  const counts = JSON.parse(readFileSync(json, 'utf8')).counts;
  console.log(`   网站：番单 ${counts.entries} · 快速标记 ${counts.triage} · 观看记录 ${counts.logs}`);
  // 3. 备份客户端
  const bdir = join(CLIENT, '..', 'backups');
  mkdirSync(bdir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const bk = join(bdir, `before-site-sync-${stamp}.db`);
  const c = ro(CLIENT); c.exec(`VACUUM INTO ${sql(bk)}`); c.close();
  const old = readdirSync(bdir).filter((f) => f.startsWith('before-site-sync-')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 5))) rmSync(join(bdir, f), { force: true });
  console.log(`   客户端已备份：${bk}`);
  // 4. 导入
  const r = JSON.parse(child(['--child-import', json, String(clientUser.id), clientUser.username], CLIENT).split('\n').pop());
  console.log(`   导入：番单 ${r.entries} · 快速标记 ${r.triage} · 新增观看记录 ${r.logs}${r.unresolved ? ` · ${r.unresolved} 条对不上番剧` : ''}`);
  // 5. 逐条比对
  const rows = (p, uid) => {
    const d = ro(p);
    const m = new Map(d.prepare('SELECT anime_id, status, current_episode, my_score FROM user_entry_all WHERE user_id = ?').all(uid)
      .map((x) => [x.anime_id, `${x.status}|${x.current_episode}|${x.my_score}`]));
    d.close(); return m;
  };
  const A = rows(snap, siteUser.id), B = rows(CLIENT, clientUser.id);
  let diff = 0; for (const [k, v] of A) if (B.get(k) !== v) diff++;
  const onlyClient = [...B.keys()].filter((k) => !A.has(k)).length;
  if (diff) die(`比对：网站 ${A.size} 条里有 ${diff} 条和客户端不一致（客户端备份在 ${bk}）`);
  console.log(`\n✅ 同步完成：网站 ${A.size} 条番单，客户端全部一致${onlyClient ? `；另有 ${onlyClient} 条只在客户端（保留）` : ''}`);
  console.log('   客户端开着的话，刷新一下页面就能看到');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
