/**
 * 多账号（2026-10-19）：账号表、会话表，以及「个人数据按账号隔离」的那一层。
 *
 * ── 个人数据怎么隔离 ──
 * 真正的数据在 *_all 表里（多一列 user_id）；原来的表名改成视图：
 *     CREATE VIEW user_entry AS SELECT … FROM user_entry_all WHERE user_id = uid()
 * uid() 是 db.js 注册的 SQL 函数，返回当前请求的账号（见 userCtx.js；访客 = 0）。
 * 于是全站上百处 `FROM user_entry` 一行不用改，**漏写过滤条件也串不了号** ——
 * 默认就是隔离的，这比每条 SQL 手写 `AND user_id = ?` 安全得多。
 * 视图上挂了 INSTEAD OF 触发器，普通的 INSERT / UPDATE / DELETE 照样能写。
 *
 * ⚠️ 通过视图写入有三个限制（SQLite 本身的规则），需要时直接写 *_all 表：
 *   · 不支持 ON CONFLICT（upsert）
 *   · .changes 恒为 0（触发器里的改动不计数）
 *   · lastInsertRowid 不是新行的 id
 * 访客（uid=0）写入会被 CHECK (user_id > 0) 挡下 —— 第二道保险，第一道是接口要求登录。
 *
 * 同步脚本（没有登录态，uid=0）透过视图什么都看不见：要跨账号处理的（如去重合并番单）
 * 一律直接读写 *_all 表，见 dedup.js。
 *
 * ── 不按账号分的 ──
 * franchise_member.user_order（系列顺序）、manual_relation（手动关联）、watch_site（观看站）
 * 是对公共数据的修正，全站一份，只有管理员能改。
 */

/** 个人数据表：列定义 + 主键。user_id 由迁移统一加在最前面 */
const PERSONAL = {
  user_entry: {
    cols: `anime_id        INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
      status          TEXT NOT NULL,
      current_episode INTEGER,
      my_score        REAL,
      my_note         TEXT,
      is_rewatching   INTEGER NOT NULL DEFAULT 0,
      rewatch_count   INTEGER NOT NULL DEFAULT 0,
      started_at      TEXT,
      finished_at     TEXT,
      is_vague        INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))`,
    key: ['anime_id'],
    defaults: { is_rewatching: '0', rewatch_count: '0', is_vague: '0', created_at: "datetime('now')", updated_at: "datetime('now')" },
    indexes: ['CREATE INDEX IF NOT EXISTS idx_entry_status ON user_entry_all(user_id, status)']
  },
  triage: {
    cols: `anime_id   INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
      verdict    TEXT NOT NULL,
      batch_id   INTEGER,
      decided_at TEXT NOT NULL DEFAULT (datetime('now'))`,
    key: ['anime_id'],
    defaults: { decided_at: "datetime('now')" },
    indexes: ['CREATE INDEX IF NOT EXISTS idx_triage_verdict ON triage_all(user_id, verdict)',
              'CREATE INDEX IF NOT EXISTS idx_triage_batch ON triage_all(user_id, batch_id DESC)']
  },
  watch_log: {
    cols: `id         INTEGER PRIMARY KEY,
      anime_id   INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
      episode    INTEGER,
      action     TEXT NOT NULL,
      detail     TEXT,
      watched_at TEXT NOT NULL DEFAULT (datetime('now'))`,
    key: ['id'], rowid: true,
    defaults: { watched_at: "datetime('now')" },
    indexes: ['CREATE INDEX IF NOT EXISTS idx_log_anime ON watch_log_all(user_id, anime_id)',
              'CREATE INDEX IF NOT EXISTS idx_log_time ON watch_log_all(user_id, watched_at DESC)']
  },
  saved_filter: {
    cols: `id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      filter_json TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      is_default  INTEGER NOT NULL DEFAULT 0`,
    key: ['id'], rowid: true,
    defaults: { created_at: "datetime('now')", is_default: '0' },
    indexes: ['CREATE INDEX IF NOT EXISTS idx_filter_user ON saved_filter_all(user_id)']
  },
  user_tag: {
    cols: `anime_id INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
      tag      TEXT NOT NULL`,
    key: ['anime_id', 'tag'],
    defaults: {},
    indexes: []
  }
};
export const PERSONAL_TABLES = Object.keys(PERSONAL);

const colNames = (def) => def.cols.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);

const ACCOUNT_SQL = `
CREATE TABLE IF NOT EXISTS account (
  id                INTEGER PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email             TEXT UNIQUE COLLATE NOCASE,
  pw_hash           TEXT,
  role              TEXT NOT NULL DEFAULT 'user',
  email_verified_at TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS session (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);
CREATE TABLE IF NOT EXISTS signup_allow (
  email      TEXT PRIMARY KEY COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_setting (
  user_id INTEGER NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (user_id, key)
);`;

/** setting 表里原来属于「主人个人」的键 —— 迁移时搬进管理员的 user_setting */
export const isUserSettingKey = (k) =>
  ['hide_nsfw', 'year_min', 'year_max', 'share_token'].includes(k)
  || k.startsWith('watch_pick:') || k.startsWith('default_filter:');

const objType = (db, name) => db.prepare('SELECT type FROM sqlite_master WHERE name = ?').get(name)?.type ?? null;

function createLayer(db, name, def) {
  const cols = colNames(def);
  db.exec(`CREATE TABLE IF NOT EXISTS ${name}_all (
      user_id INTEGER NOT NULL CHECK (user_id > 0) REFERENCES account(id) ON DELETE CASCADE,
      ${def.cols}${def.rowid ? '' : `,\n      PRIMARY KEY (user_id, ${def.key.join(', ')})`})`);
  for (const ix of def.indexes) db.exec(ix);
  db.exec(`CREATE VIEW IF NOT EXISTS ${name} AS SELECT ${cols.join(', ')} FROM ${name}_all WHERE user_id = uid()`);
  // 有 rowid 主键的表（日志 / 筛选）插入时不给 id 就让 SQLite 自己分配
  const insCols = def.rowid ? cols.filter((c) => c !== 'id') : cols;
  const val = (c) => (def.defaults[c] ? `coalesce(NEW.${c}, ${def.defaults[c]})` : `NEW.${c}`);
  const match = (row) => `user_id = uid() AND ${def.key.map((k) => `${k} = ${row}.${k}`).join(' AND ')}`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${name}_ins INSTEAD OF INSERT ON ${name} BEGIN
      INSERT INTO ${name}_all (user_id, ${def.rowid ? 'id, ' : ''}${insCols.join(', ')})
      VALUES (uid(), ${def.rowid ? 'NEW.id, ' : ''}${insCols.map(val).join(', ')}); END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${name}_upd INSTEAD OF UPDATE ON ${name} BEGIN
      UPDATE ${name}_all SET ${cols.map((c) => `${c} = NEW.${c}`).join(', ')} WHERE ${match('OLD')}; END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${name}_del INSTEAD OF DELETE ON ${name} BEGIN
      DELETE FROM ${name}_all WHERE ${match('OLD')}; END`);
}

/**
 * 建账号层；老库（单用户）就地迁移：原来的个人数据全部归到管理员账号（id 1）。
 * 跑第二次是空操作。initSchema 会在 schema.sql 之前调它的 before、之后调 after。
 */
export function migrateBefore(db) {
  // 老库：个人表还是真表 → 先挪开，等 schema.sql 和新层建好再搬数据
  const old = PERSONAL_TABLES.filter((t) => objType(db, t) === 'table');
  for (const t of old) {
    for (const ix of db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(t))
      db.exec(`DROP INDEX ${ix.name}`);
    db.exec(`ALTER TABLE ${t} RENAME TO _old_${t}`);
  }
  return old;
}

export function migrateAfter(db, old, { adminPasswordHash = null, adminName = 'admin', adminEmail = null } = {}) {
  db.exec(ACCOUNT_SQL);
  for (const [name, def] of Object.entries(PERSONAL)) createLayer(db, name, def);
  if (!old.length) return null;

  // 老库有数据 → 主人的管理员账号接手。密码沿用原来的 J_ANIME_PASSWORD（由调用方算好 hash 传进来）；
  // 用户名 / 邮箱取 ~/.j-anime.env 的 J_ANIME_ADMIN_USER / J_ANIME_ADMIN_EMAIL（主人 2026-10-19：数据要归到「我的账号」，不是一个叫 admin 的号）
  db.exec('BEGIN');
  try {
    let admin = db.prepare("SELECT id FROM account WHERE role = 'admin' ORDER BY id LIMIT 1").get()?.id;
    if (!admin) admin = Number(db.prepare(`INSERT INTO account (username, email, pw_hash, role) VALUES (?, ?, ?, 'admin')`)
      .run(adminName, adminEmail, adminPasswordHash).lastInsertRowid);
    for (const t of old) {
      const have = new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(`_old_${t}`).map((r) => r.name));
      const cols = colNames(PERSONAL[t]).filter((c) => have.has(c));
      db.exec(`INSERT INTO ${t}_all (user_id, ${cols.join(', ')}) SELECT ${admin}, ${cols.join(', ')} FROM _old_${t}`);
      db.exec(`DROP TABLE _old_${t}`);
    }
    const keys = db.prepare('SELECT key, value FROM setting').all().filter((r) => isUserSettingKey(r.key));
    const put = db.prepare('INSERT OR REPLACE INTO user_setting (user_id, key, value) VALUES (?, ?, ?)');
    for (const r of keys) { put.run(admin, r.key, r.value); db.prepare('DELETE FROM setting WHERE key = ?').run(r.key); }
    db.exec('COMMIT');
    return { admin, tables: old.length, settings: keys.length };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
