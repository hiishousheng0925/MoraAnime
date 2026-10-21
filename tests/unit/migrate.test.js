/**
 * scripts/migrate.js（initSchema + MIGRATIONS + 多账号迁移）：
 *   · 全新空库 / 「旧版」单用户库都能迁移成功
 *   · 跑第二次是空操作（schema 和数据都不变，不再重复迁移、不再 ANALYZE）
 *   · 关键表 / 列 / 索引都在
 *
 * migrate.js 是命令行脚本（顶层就 getDb()），用子进程跑，J_ANIME_DB 指向 os.tmpdir() 下的临时库。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), 'j-anime-migrate-unit-'));
  dirs.push(d);
  const db = join(d, 'test.db');
  // 闸门（CLAUDE.md 第 1 条）
  if (!/test|tmp|temp/i.test(db)) throw new Error(`不像测试库：${db}`);
  return { d, db };
}

function runMigrate({ d, db }) {
  const env = { ...process.env, J_ANIME_DATA: d, J_ANIME_DB: db, J_ANIME_BACKUPS: join(d, 'backups'),
                J_ANIME_COVERS: join(d, 'covers'), J_ANIME_ADMIN_USER: 'owner', J_ANIME_ADMIN_EMAIL: 'Owner@Example.com' };
  delete env.J_ANIME_AS_USER;
  delete env.J_ANIME_PASSWORD;
  const r = spawnSync(process.execPath, ['--no-warnings', join(ROOT, 'scripts/migrate.js')], { env, encoding: 'utf8', cwd: d });
  assert.equal(r.status, 0, `migrate.js 失败：\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

/** 整个 schema（排序后的 sqlite_master）+ 各表行数：用来判断第二次跑有没有改任何东西 */
function fingerprint(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type, name").all();
    const rows = Object.fromEntries(schema.filter((s) => s.type === 'table' && !/^anime_fts_/.test(s.name))
      .map((s) => [s.name, db.prepare(`SELECT count(*) c FROM "${s.name}"`).get().c]));
    const data = {
      entries: db.prepare('SELECT * FROM user_entry_all ORDER BY user_id, anime_id').all(),
      settings: db.prepare('SELECT * FROM user_setting ORDER BY user_id, key').all(),
      site: db.prepare('SELECT * FROM setting ORDER BY key').all(),
      meta: db.prepare('SELECT * FROM meta ORDER BY key').all()
    };
    return JSON.parse(JSON.stringify({ schema, rows, data }));
  } finally { db.close(); }
}

const open = (file) => new DatabaseSync(file, { readOnly: true });
const has = (db, type, name) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name);
const cols = (db, t) => db.prepare('SELECT name FROM pragma_table_info(?)').all(t).map((r) => r.name);

function assertCurrentSchema(file) {
  const db = open(file);
  try {
    for (const ix of ['idx_anime_anilist', 'idx_anime_title', 'idx_anime_mal', 'idx_anime_bgm',
                      'idx_studio_pair', 'idx_entry_status', 'idx_triage_verdict', 'idx_log_time', 'idx_session_user'])
      assert.ok(has(db, 'index', ix), `缺索引 ${ix}`);
    for (const t of ['anime', 'account', 'session', 'user_setting', 'setting', 'meta', 'watch_site', 'manual_relation',
                     'user_entry_all', 'triage_all', 'watch_log_all', 'saved_filter_all', 'user_tag_all'])
      assert.ok(has(db, 'table', t), `缺表 ${t}`);
    for (const v of ['user_entry', 'triage', 'watch_log', 'saved_filter', 'user_tag'])
      assert.ok(has(db, 'view', v), `${v} 应该是视图`);
    const a = cols(db, 'anime');
    for (const c of ['cover_local_path', 'cover_dead', 'is_nsfw', 'status_eff', 'dup_of', 'bgm_match_score', 'bgm_nsfw', 'cover_hue'])
      assert.ok(a.includes(c), `anime 缺列 ${c}`);
    assert.ok(cols(db, 'franchise_member').includes('user_order'));
    assert.ok(cols(db, 'anime_alias').includes('src'));
    assert.ok(cols(db, 'anime_studio').includes('studio_norm'));
    assert.ok(cols(db, 'saved_filter_all').includes('is_default'));
    // 按标题 / anilist_id 定位真的走索引（备份导入的解析器依赖这两条）
    const plan = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');
    assert.match(plan('SELECT id FROM anime WHERE anilist_id = 1'), /idx_anime_anilist/);
    assert.match(plan("SELECT id FROM anime WHERE title = 'x'"), /idx_anime_title/);
  } finally { db.close(); }
}

test('全新空库：迁移成功，关键表 / 列 / 索引齐全；再跑一次什么都不变', () => {
  const t = tmpDb();
  writeFileSync(t.db, '');   // getDb 不许新建库，先放一个空文件（init-db.js 的情形）
  const out1 = runMigrate(t);
  assert.match(out1, /schema 已就位/);
  assert.doesNotMatch(out1, /多账号迁移/, '空库没有可迁移的个人数据');
  assertCurrentSchema(t.db);
  const fp1 = fingerprint(t.db);

  const out2 = runMigrate(t);
  assert.doesNotMatch(out2, /索引有变动/, '第二次不该再 ANALYZE');
  assert.deepEqual(fingerprint(t.db), fp1, '第二次跑是空操作');
});

/** 2026-10-19 之前的单用户库：个人表是真表、没有账号表，anime / franchise_member 缺后来加的列 */
function makeOldDb(file) {
  const schema = readFileSync(join(ROOT, 'src/lib/server/schema.sql'), 'utf8');
  const animeDdl = schema.match(/CREATE TABLE IF NOT EXISTS anime \([\s\S]*?\n\);/)[0];
  const db = new DatabaseSync(file);
  try {
    db.exec(animeDdl);
    db.exec(`
      CREATE TABLE franchise (id INTEGER PRIMARY KEY, name TEXT, size INTEGER NOT NULL DEFAULT 0,
        computed_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE franchise_member (franchise_id INTEGER NOT NULL, anime_id INTEGER NOT NULL, release_order INTEGER,
        is_skippable INTEGER NOT NULL DEFAULT 0, skip_reason TEXT, PRIMARY KEY (franchise_id, anime_id));
      CREATE TABLE anime_alias (anime_id INTEGER NOT NULL, alias TEXT NOT NULL,
        has_kana INTEGER NOT NULL DEFAULT 0, is_cjk INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE anime_studio (anime_id INTEGER NOT NULL, studio TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'studio');
      CREATE TABLE user_entry (anime_id INTEGER PRIMARY KEY, status TEXT NOT NULL, current_episode INTEGER,
        my_score REAL, my_note TEXT, is_rewatching INTEGER NOT NULL DEFAULT 0, rewatch_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT, finished_at TEXT, is_vague INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE INDEX idx_entry_status ON user_entry(status);
      CREATE TABLE triage (anime_id INTEGER PRIMARY KEY, verdict TEXT NOT NULL, batch_id INTEGER,
        decided_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE watch_log (id INTEGER PRIMARY KEY, anime_id INTEGER NOT NULL, episode INTEGER, action TEXT NOT NULL,
        detail TEXT, watched_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE saved_filter (id INTEGER PRIMARY KEY, name TEXT NOT NULL, filter_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT);

      INSERT INTO anime (id, uid, title, type, episodes, year, anilist_id) VALUES
        (1, 'u1', 'Old One', 'TV', 12, 2010, 111), (2, 'u2', 'Old Two', 'TV', 24, 2012, 222);
      INSERT INTO anime_studio (anime_id, studio) VALUES (1, '8-bit');
      INSERT INTO user_entry (anime_id, status, current_episode, my_score) VALUES (1, 'completed', NULL, 9), (2, 'watching', 3, NULL);
      INSERT INTO triage (anime_id, verdict) VALUES (2, 'seen');
      INSERT INTO watch_log (anime_id, episode, action) VALUES (2, 3, 'progress');
      INSERT INTO saved_filter (name, filter_json) VALUES ('老组合', '{}');
      INSERT INTO setting (key, value) VALUES ('hide_nsfw', '1'), ('share_token', 'tok'), ('screenshot_dir', 'D:/s');`);
  } finally { db.close(); }
}

test('旧版单用户库：个人数据归到管理员账号、个人设置搬进 user_setting；再跑一次是空操作', () => {
  const t = tmpDb();
  makeOldDb(t.db);
  const out1 = runMigrate(t);
  assert.match(out1, /多账号迁移：4 张个人表、2 项个人设置/);
  assertCurrentSchema(t.db);

  const db = open(t.db);
  try {
    const admin = db.prepare("SELECT id, username, email, role FROM account").all().map((r) => ({ ...r }));
    assert.deepEqual(admin, [{ id: 1, username: 'owner', email: 'owner@example.com', role: 'admin' }]);
    assert.deepEqual(db.prepare('SELECT user_id, anime_id, status, current_episode, my_score FROM user_entry_all ORDER BY anime_id').all().map((r) => ({ ...r })),
      [{ user_id: 1, anime_id: 1, status: 'completed', current_episode: 12, my_score: 9 },   // 「看完」集数被回填
       { user_id: 1, anime_id: 2, status: 'watching', current_episode: 3, my_score: null }]);
    assert.equal(db.prepare('SELECT count(*) c FROM triage_all WHERE user_id = 1').get().c, 1);
    assert.equal(db.prepare('SELECT count(*) c FROM watch_log_all WHERE user_id = 1').get().c, 1);
    assert.equal(db.prepare('SELECT count(*) c FROM saved_filter_all WHERE user_id = 1').get().c, 1);
    assert.deepEqual(db.prepare('SELECT key, value FROM user_setting WHERE user_id = 1 ORDER BY key').all().map((r) => ({ ...r })),
      [{ key: 'hide_nsfw', value: '1' }, { key: 'share_token', value: 'tok' }]);
    assert.deepEqual(db.prepare('SELECT key FROM setting').all().map((r) => r.key), ['screenshot_dir'], '站点设置留在 setting');
    assert.equal(db.prepare("SELECT count(*) c FROM sqlite_master WHERE name LIKE '_old_%'").get().c, 0, '临时表清掉了');
    assert.equal(db.prepare('SELECT studio_norm FROM anime_studio').get().studio_norm, '8bit', '公司名归一回填了');
  } finally { db.close(); }

  const fp1 = fingerprint(t.db);
  const out2 = runMigrate(t);
  assert.doesNotMatch(out2, /多账号迁移/, '第二次不再迁移');
  assert.doesNotMatch(out2, /索引有变动/);
  assert.doesNotMatch(out2, /回填|重新归一/);
  assert.deepEqual(fingerprint(t.db), fp1, '第二次跑是空操作');
});
