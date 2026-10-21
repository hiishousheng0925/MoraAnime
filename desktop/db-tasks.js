/**
 * 需要碰数据库的启动步骤。由主进程用 ELECTRON_RUN_AS_NODE=1 + process.execPath 起子进程跑
 * （和服务同一个 Node，node:sqlite 版本一致；主进程本身不打开数据库）。
 *
 *   bootstrap                    确保本地账号（id 1）存在，建一个新会话，stdout 输出 {"token": …}
 *   apply <新库> [版本号]          换库：新库 ATTACH 旧库，把个人数据搬过去，再原子替换
 *
 * 环境变量（主进程给）：
 *   J_ANIME_DATA   数据目录（库在 <数据>/j-anime.db）
 *   MORA_LIB       网站服务端代码目录（…/src/lib/server）—— 账号 / 会话 / 去重合并沿用网站自己的实现
 *   MORA_MIGRATE   scripts/migrate.js 的路径
 *   MORA_HOME      客户端用户目录（本地账号密码存在这里）
 */
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { CARRY_ON_SWAP, ANIME_REFS } from './catalog-tables.js';

const LIB = process.env.MORA_LIB;
const DATA = process.env.J_ANIME_DATA;
const DB = join(DATA, 'j-anime.db');
const lib = (f) => import(pathToFileURL(join(LIB, f)).href);

/** 会话的 user_agent 标记：每次启动换新令牌时只清自己建的，不动别的 */
export const SESSION_UA = 'MoraAnime desktop';
export const LOCAL_USER = 'me';

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'bootstrap') await bootstrap();
  else if (cmd === 'apply') await apply(rest[0], rest[1]);
  else throw new Error(`未知命令 ${cmd}`);
} catch (e) {
  console.error(e?.stack || String(e));
  process.exit(1);
}

/**
 * 单用户免登录：本地库里只有一个账号（id 1，管理员 —— 观看站 / 系列顺序这些「全站修正」在客户端也该能改）。
 * 账号先于服务存在，所以网站「库里没有账号时第一个注册的是管理员」那条路在客户端永远走不到。
 * 密码随机生成存在本机用户目录（万一被登出，可以用它登回来）。
 */
async function bootstrap() {
  const { getDb } = await lib('db.js');
  const { hashPassword } = await lib('password.js');
  const { createSession } = await lib('auth.js');
  const db = getDb();
  const credFile = join(process.env.MORA_HOME, 'local-account.json');
  let cred = null;
  try { cred = JSON.parse(readFileSync(credFile, 'utf8')); } catch { /* 首次 */ }
  const acct = db.prepare('SELECT id, username, pw_hash FROM account WHERE id = 1').get();
  if (!acct || !cred?.password || !acct.pw_hash) {
    const password = randomBytes(18).toString('base64url');
    if (!acct) {
      db.prepare("INSERT INTO account (id, username, role) VALUES (1, ?, 'admin')").run(LOCAL_USER);
    }
    db.prepare("UPDATE account SET pw_hash = ?, role = 'admin' WHERE id = 1").run(hashPassword(password));
    const username = db.prepare('SELECT username FROM account WHERE id = 1').get().username;
    writeFileSync(credFile, JSON.stringify({ username, password, note: 'MoraAnime 本地账号（客户端自动登录用）' }, null, 2));
  }
  db.prepare('DELETE FROM session WHERE user_agent = ?').run(SESSION_UA);
  const token = createSession(1, SESSION_UA);
  process.stdout.write(JSON.stringify({ token }) + '\n');
}

/**
 * 换库。顺序（任何一步失败都不碰现有库，只删临时文件）：
 *   1. 新库拷成 <数据>/j-anime.db.swap，跑一遍 migrate（schema 和当前客户端对齐）
 *   2. 旧库 checkpoint（WAL 合并进主文件，ATTACH 才能读到全部数据）
 *   3. swap ATTACH 旧库：个人表整表搬过去；指向 stub 的个人记录改挂 dup_of（沿用网站去重的合并写法）；
 *      手动关联取并集；封面本地缓存路径沿用
 *   4. integrity_check
 *   5. 旧库改名成 backups/j-anime.db.prev-<时间> → swap 改名成 j-anime.db；第二步失败就把旧库改回来
 */
async function apply(pending, version) {
  if (!pending || !existsSync(pending)) throw new Error(`新库不存在：${pending}`);
  if (!existsSync(DB)) throw new Error(`当前库不存在：${DB}`);
  const swap = DB + '.swap';
  rmSync(swap, { force: true }); rmSync(swap + '-wal', { force: true }); rmSync(swap + '-shm', { force: true });
  copyFileSync(pending, swap);
  const t0 = Date.now();
  try {
    const mig = spawnSync(process.execPath, [process.env.MORA_MIGRATE],
      { env: { ...process.env, J_ANIME_DB: swap }, encoding: 'utf8' });
    if (mig.status !== 0) throw new Error(`新库迁移失败：${mig.stderr || mig.stdout}`);

    { const old = new DatabaseSync(DB); old.exec('PRAGMA wal_checkpoint(TRUNCATE)'); old.close(); }

    const { applyAliasDupes } = await lib('dedup.js');
    const db = new DatabaseSync(swap);
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`ATTACH DATABASE '${DB.replace(/'/g, "''")}' AS o`);
    const has = (schema, t) => !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(t);
    const cols = (schema, t) => db.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(t, schema).map((r) => r.name);
    const report = { carried: {}, remapped: 0, orphans: 0 };

    db.exec('BEGIN');
    try {
      for (const t of CARRY_ON_SWAP) {
        if (!has('main', t) || !has('o', t)) continue;
        const oc = new Set(cols('o', t));
        const c = cols('main', t).filter((x) => oc.has(x)).map((x) => `"${x}"`).join(', ');
        db.exec(`DELETE FROM main."${t}"`);
        db.exec(`INSERT INTO main."${t}" (${c}) SELECT ${c} FROM o."${t}"`);
        report.carried[t] = db.prepare(`SELECT count(*) n FROM main."${t}"`).get().n;
      }
      // 手动关联：上游的修正 + 本机用户自己加的（取并集）
      if (has('o', 'manual_relation'))
        db.exec('INSERT OR IGNORE INTO main.manual_relation (a_id, b_id, created_at) SELECT a_id, b_id, created_at FROM o.manual_relation');
      // 封面本地缓存：文件还在本机的封面目录里，路径沿用，免得每张都重新下载
      db.exec(`UPDATE main.anime SET cover_local_path = (SELECT oa.cover_local_path FROM o.anime oa WHERE oa.id = main.anime.id)
               WHERE cover_local_path IS NULL AND EXISTS (SELECT 1 FROM o.anime oa WHERE oa.id = main.anime.id AND oa.cover_local_path IS NOT NULL)`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    // 上游去重把某些条目折成了 stub：个人记录里指向 stub 的改挂到保留的那条（沿 dup_of 链走到底）
    const winnerOf = (id) => {
      let cur = id;
      for (let i = 0; i < 10; i++) {
        const r = db.prepare('SELECT is_stub, dup_of FROM main.anime WHERE id = ?').get(cur);
        if (!r || !r.is_stub || !r.dup_of) return cur;
        cur = r.dup_of;
      }
      return cur;
    };
    const refIds = new Set();
    for (const [t, col] of Object.entries(ANIME_REFS))
      if (has('main', t)) for (const r of db.prepare(`SELECT DISTINCT ${col} id FROM main."${t}"`).all()) refIds.add(r.id);
    const pairs = [...refIds].map((id) => ({ loser: id, winner: winnerOf(id) })).filter((p) => p.winner !== p.loser);
    if (pairs.length) {
      const r = applyAliasDupes(db, pairs);
      // applyAliasDupes 不管标签：同一账号两边都有同名标签就只留一条
      db.exec('BEGIN');
      for (const { loser, winner } of pairs) {
        db.prepare('UPDATE OR IGNORE user_tag_all SET anime_id = ? WHERE anime_id = ?').run(winner, loser);
        db.prepare('DELETE FROM user_tag_all WHERE anime_id = ?').run(loser);
      }
      db.exec('COMMIT');
      report.remapped = r.moved;
    }
    // 上游删掉了的条目（极少见）：个人记录留着不删，条目回来时自动接上；只记个数
    report.orphans = db.prepare('SELECT count(*) n FROM main.user_entry_all ue WHERE NOT EXISTS (SELECT 1 FROM main.anime a WHERE a.id = ue.anime_id)').get().n;
    if (version) db.prepare("INSERT INTO main.meta (key, value) VALUES ('mora_catalog_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(version);
    db.exec('DETACH DATABASE o');
    const ok = db.prepare('PRAGMA quick_check').get();
    if (Object.values(ok)[0] !== 'ok') throw new Error(`新库校验失败：${JSON.stringify(ok)}`);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();

    // 原子替换：先把旧库挪开，再把 swap 改名过去；后一步失败就把旧库挪回来
    const backups = join(DATA, 'backups');
    mkdirSync(backups, { recursive: true });
    const prev = join(backups, `j-anime.db.prev-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    for (const ext of ['-wal', '-shm']) rmSync(DB + ext, { force: true });
    renameSync(DB, prev);
    try { renameSync(swap, DB); }
    catch (e) { renameSync(prev, DB); throw e; }
    for (const ext of ['-wal', '-shm']) rmSync(swap + ext, { force: true });
    // 换库前的旧库只留最近 2 份
    const olds = readdirSync(backups).filter((f) => f.startsWith('j-anime.db.prev-')).sort().reverse();
    for (const f of olds.slice(2)) rmSync(join(backups, f), { force: true });
    process.stdout.write(JSON.stringify({ ok: true, version, ms: Date.now() - t0, prev, ...report }) + '\n');
  } catch (e) {
    for (const ext of ['', '-wal', '-shm', '-journal']) rmSync(swap + ext, { force: true });
    throw e;
  }
}
