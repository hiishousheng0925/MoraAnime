/**
 * 数据库层 —— 用 Node 内置的 node:sqlite（Node 22+）
 *
 * 为什么不用 better-sqlite3：Node 25 没有它的预编译二进制，
 * 源码编译需要 node-gyp 工具链且实测失败。node:sqlite 是内置的，
 * 零原生依赖、零构建步骤，实测 SQLite 3.51.2 + FTS5 全部可用。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH } from './paths.js';
import { currentUid } from './userCtx.js';
import { migrateBefore, migrateAfter } from './multiUser.js';
import { hashPassword } from './password.js';

export { DB_PATH };

// 只用来读随源码一起走的 schema.sql —— 这是代码路径，不是数据路径。
// 数据路径一律走 paths.js（生产构建后相对路径会指错，见那里的说明）。
const __dirname = dirname(fileURLToPath(import.meta.url));

let _db;
/** @param {{create?: boolean}} [opts] create=true 才允许新建空库（只有 init-db.js 该传） */
export function getDb(opts) {
  if (_db) return _db;
  // node:sqlite 打不开不会报错，它会直接新建一个空库 —— 部署时路径配错的话，
  // 站点能正常起来但一条番都没有，而且完全看不出哪里错了。所以这里挡一下。
  if (!existsSync(DB_PATH) && opts?.create !== true)
    throw new Error(
      `数据库不存在：${DB_PATH}\n` +
      `  生产环境请设 J_ANIME_DATA 指向数据目录（里面要有 j-anime.db）\n` +
      `  要新建空库请跑：node scripts/init-db.js`);
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  _db.exec('PRAGMA synchronous = NORMAL');
  _db.exec('PRAGMA busy_timeout = 20000');
  // 页缓存 64MB（缺省只有 2MB，而库有 200MB）。根布局每个请求都跑 triageStats，
  // 它的 count(*) 要走遍 4 万行 —— 缓存装不下就每次都回文件系统读页。
  // Windows 上实测这一条 80ms → 10ms，五个页面因此从 400-600ms 掉回 300ms 以内。
  _db.exec('PRAGMA cache_size = -65536');
  /**
   * uid()：当前请求的账号 id（访客 = 0）。个人数据的视图靠它过滤（见 multiUser.js）。
   * deterministic 让 SQLite 每条语句只调一次（实测 2 万行的 JOIN 里只调 1 次），并且能走索引。
   */
  _db.function('uid', { deterministic: true }, () => currentUid());
  return _db;
}

/**
 * 轻量迁移：CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，
 * 所以新增列要单独 ALTER。已存在就静默跳过。
 */
const MIGRATIONS = [
  ['anime', 'cover_local_path', 'TEXT'],
  ['anime', 'cover_dead', 'INTEGER NOT NULL DEFAULT 0'],
  ['anime', 'is_nsfw', 'INTEGER NOT NULL DEFAULT 0'],
  ['franchise_member', 'user_order', 'INTEGER'],
  ['anime_studio', 'studio_norm', 'TEXT'],
  ['anime', 'status_eff', 'TEXT'],
  ['anime', 'bgm_air_start', 'TEXT'],
  ['anime', 'bgm_air_end', 'TEXT'],
  ['anime', 'bgm_eps', 'INTEGER'],
  // 别名来源：'aod' = 灌库带来的，'bgm' = 补中文名时加的。
  // 全量灌库只能清掉自己那批，否则会把 bgm 中文名别名一起删了
  ['anime_alias', 'src', 'TEXT'],
  /**
   * 被折叠进哪一条（见 dedup.js）。不写下来的话 repairOrphans 会把折掉的条目
   * 又放回可见 —— 它判断「有归属」只看标题/中文名/外部 ID 能不能对上，而
   * 「弱虫ペダル (劇場版)」和「弱虫ペダル」这类恰恰是标题对不上才需要折。
   * 实测：折 31 条、当场被放回 26 条，每天同步来回震荡。
   */
  ['anime', 'dup_of', 'INTEGER'],
  /**
   * 匹配痕迹：当初是拿哪个 bgm 标题、多高的相似度匹上的（见 enrich-bgm.js 的 pick）。
   * 主人 2026-09-09 拍板加这两列。为什么需要：已经固化的错误匹配【离线查不出来】——
   * 试过三种探测器（bgm_id 一对多 578 组、跨系列 74 组、中文名与日文原名汉字重合率
   * 178 条），精度都不够用，因为库里没留下「当初匹配用了什么」。
   * 只对今后的匹配生效，攒一段时间后就能筛「相似度低的重跑一遍」。
   */
  ['anime', 'bgm_match_score', 'REAL'],
  ['anime', 'bgm_name_ja', 'TEXT'],
  /**
   * #2 换数据源：Bangumi Archive 的 nsfw 标记单独存一列 —— mark-nsfw.js 每天先清零再按
   * AOD 标签重标，直接写 is_nsfw 会被它冲掉；它改为「AOD 标签 OR bgm_nsfw」。
   * bgm_match_rule 记下匹配命中了哪几项（名 / 季 / 年 / 集 / 型 / 原），旧错配查不出来的教训（DEC1）。
   */
  ['anime', 'bgm_nsfw', 'INTEGER'],
  ['anime', 'bgm_match_rule', 'TEXT'],
  /**
   * 封面主色相（方案 C 按封面取色，见 coverHue.js）：NULL = 还没算，-1 = 没有可用颜色，0–359 = 色相。
   * 不批量回填：封面缓存时 / 详情页打开时按需算
   */
  ['anime', 'cover_hue', 'INTEGER']
];

function migrate(db) {
  for (const [table, col, type] of MIGRATIONS) {
    const exists = db.prepare(`SELECT count(*) c FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, col).c;
    if (!exists) {
      const t = db.prepare(`SELECT count(*) c FROM sqlite_master WHERE type='table' AND name=?`).get(table).c;
      if (t) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
  }
}

/** 当前库里有哪些索引 —— 用来判断这一轮 schema 有没有动过索引 */
const indexSet = (db) => db.prepare(
  "SELECT group_concat(name) g FROM (SELECT name FROM sqlite_master WHERE type='index' ORDER BY name)"
).get().g ?? '';

export function initSchema(db = getDb()) {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  const before = indexSet(db);
  // 多账号（2026-10-19）：老库的个人表先挪开，下面建完再搬进管理员账号（见 multiUser.js）
  const oldPersonal = migrateBefore(db);
  // 先建表（跳过依赖新列的索引），再迁移，再补索引
  const stmts = sql.split(';').map((x) => x.trim()).filter(Boolean);
  const deferred = [];
  for (const st of stmts) {
    try { db.exec(st); }
    catch (e) {
      if (/no such column/i.test(e.message)) deferred.push(st);
      else throw e;
    }
  }
  migrate(db);
  for (const st of deferred) db.exec(st);
  const pw = process.env.J_ANIME_PASSWORD;
  const moved = migrateAfter(db, oldPersonal, { adminPasswordHash: pw ? hashPassword(pw) : null,
    adminName: process.env.J_ANIME_ADMIN_USER || 'admin', adminEmail: process.env.J_ANIME_ADMIN_EMAIL?.toLowerCase() || null });
  if (moved) console.log(`  👤 多账号迁移：${moved.tables} 张个人表、${moved.settings} 项个人设置归到管理员账号 #${moved.admin}`);

  /**
   * ⚠️ 新建索引之后必须 ANALYZE，否则规划器拿不到新索引的选择度，
   * 会继续按旧的 sqlite_stat1 选计划 —— 实测「三个题材」的 count(*)：
   *     建了索引但没 ANALYZE  64.8ms
   *     建了索引且 ANALYZE    19.4ms   （3.3×）
   * 但也【不能每次启动都跑】—— ANALYZE 要扫一遍各索引，正式站每次重启都付这个钱
   * 是白付。所以只在「索引集合真的变了」的那一次跑，之后自动安静下来。
   */
  const after = indexSet(db);
  if (after !== before) {
    db.exec('ANALYZE');
    console.log('  ⚙️  索引有变动，已重新 ANALYZE');
  }
  return db;
}

/** node:sqlite 没有 better-sqlite3 的 db.transaction()，自己包一个 */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export const one = (db, sql, ...p) => db.prepare(sql).get(...p);
export const all = (db, sql, ...p) => db.prepare(sql).all(...p);
