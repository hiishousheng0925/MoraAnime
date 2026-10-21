/**
 * 整站备份（exportAll，version 3）→ 恢复（importData 的 v3 分支）往返测试。
 * 每日备份用的就是这个格式，原来从没测过「真出事时能不能还原回来」。
 *
 * ⛔ 只在 os.tmpdir() 下的全新空库上跑：环境变量必须在 import 被测模块之前设好
 * （paths.js 在 import 时就算定 DB_PATH / BACKUP_DIR，db.js 的连接是单例）。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'j-anime-backup-unit-'));
process.env.J_ANIME_DATA = dir;
process.env.J_ANIME_DB = join(dir, 'test.db');
process.env.J_ANIME_BACKUPS = join(dir, 'backups');
process.env.J_ANIME_COVERS = join(dir, 'covers');
delete process.env.J_ANIME_AS_USER;
// 闸门（CLAUDE.md 第 1 条）：路径不含 test/tmp 就不跑
if (!/test|tmp|temp/i.test(process.env.J_ANIME_DB)) { console.error('J_ANIME_DB 不像测试库，拒绝运行'); process.exit(2); }

const { getDb, initSchema, DB_PATH } = await import('../../src/lib/server/db.js');
const { exportAll, importData } = await import('../../src/lib/server/backup.js');
const { withUser } = await import('../../src/lib/server/userCtx.js');
assert.equal(DB_PATH, process.env.J_ANIME_DB, 'paths.js 必须指向临时库');

let db;
const ADMIN = { id: 1, username: 'owner', role: 'admin' };
const USER = { id: 2, username: 'friend', role: 'user' };
const as = (u, fn) => withUser({ user: u, prefs: {} }, fn);

before(() => {
  db = getDb({ create: true });
  const log = console.log; console.log = () => {};
  try { initSchema(db); } finally { console.log = log; }
});
after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

const PERSONAL_ALL = ['user_entry_all', 'triage_all', 'watch_log_all', 'saved_filter_all', 'user_tag_all', 'user_setting'];
const SITE = ['watch_site', 'setting', 'manual_relation'];

/** 清掉个人数据和公共修正（番剧元数据、系列成员留着 —— 模拟「元数据重灌后还原个人记录」） */
function wipe() {
  for (const t of [...PERSONAL_ALL, ...SITE]) db.exec(`DELETE FROM ${t}`);
  db.exec('UPDATE franchise_member SET user_order = NULL');
}

function seed() {
  wipe();
  db.exec('DELETE FROM franchise_member; DELETE FROM franchise; DELETE FROM anime; DELETE FROM account');
  db.prepare(`INSERT INTO account (id, username, role) VALUES (1, 'owner', 'admin'), (2, 'friend', 'user')`).run();
  const insA = db.prepare(`INSERT INTO anime (id, uid, title, title_cn, type, episodes, year, anilist_id, mal_id, bgm_id, source_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  insA.run(10, 'u10', 'Bocchi the Rock!', '孤独摇滚', 'TV', 12, 2022, 130003, 47917, 328609, 5);
  insA.run(11, 'u11', 'Frieren', '葬送的芙莉莲', 'TV', 28, 2023, 154587, 52991, 400602, 5);
  insA.run(12, 'u12', 'Only Mal Id', null, 'MOVIE', 1, 2020, null, 99999, null, 2);
  insA.run(13, 'u13', 'Title Only', null, 'OVA', 2, 2019, null, null, null, 1);
  db.exec(`INSERT INTO franchise (id, name, size) VALUES (1, 'f', 2);
    INSERT INTO franchise_member (franchise_id, anime_id, release_order, user_order) VALUES (1, 10, 1, 2), (1, 11, 2, 1);
    INSERT INTO manual_relation (a_id, b_id) VALUES (10, 13);
    INSERT INTO watch_site (name, url, ord, enabled) VALUES ('站A', 'https://a.example/{cn}', 1, 1), ('站B', 'https://b.example/{ja}', 2, 0);
    INSERT INTO setting (key, value) VALUES ('screenshot_dir', 'D:/shots');`);

  // 管理员的个人数据
  const insE = db.prepare(`INSERT INTO user_entry_all (user_id, anime_id, status, current_episode, my_score, my_note,
    is_rewatching, rewatch_count, is_vague, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  insE.run(1, 10, 'completed', 12, 9.5, '神作', 1, 2, 0, '2022-10-01', '2022-12-25');
  insE.run(1, 12, 'watching', 0, null, null, 0, 0, 1, null, null);
  insE.run(1, 13, 'plan', null, 7, '', 0, 0, 0, null, null);
  insE.run(2, 11, 'on_hold', 5, 8.4, '朋友的', 0, 0, 0, '2023-10-01', null);
  const insT = db.prepare('INSERT INTO triage_all (user_id, anime_id, verdict, batch_id, decided_at) VALUES (?,?,?,?,?)');
  insT.run(1, 11, 'not_seen', 3, '2026-01-02 03:04:05');
  insT.run(2, 10, 'seen', 7, '2026-02-03 04:05:06');
  const insL = db.prepare('INSERT INTO watch_log_all (user_id, anime_id, episode, action, detail, watched_at) VALUES (?,?,?,?,?,?)');
  insL.run(1, 10, 3, 'progress', null, '2022-10-10 10:00:00');
  insL.run(1, 10, 12, 'complete', 'x', '2022-12-25 22:00:00');
  insL.run(2, 11, 5, 'progress', null, '2023-11-01 20:00:00');
  db.prepare('INSERT INTO saved_filter_all (user_id, name, filter_json) VALUES (?,?,?)').run(1, '我的组合', '{"y":2020}');
  const insS = db.prepare('INSERT INTO user_setting (user_id, key, value) VALUES (?,?,?)');
  insS.run(1, 'hide_nsfw', '1');
  insS.run(1, 'share_token', 'admin-secret-token');
  insS.run(1, 'watch_pick:10', '站A');
  insS.run(2, 'year_min', '2000');
  insS.run(2, 'share_token', 'friend-secret-token');
}

/** 和导入无关的列（自增 id、created_at/updated_at 会变成导入时刻）不比 */
const snap = () => ({
  entries: db.prepare(`SELECT user_id, anime_id, status, current_episode, my_score, my_note, is_rewatching,
    rewatch_count, is_vague, started_at, finished_at FROM user_entry_all ORDER BY user_id, anime_id`).all(),
  triage: db.prepare('SELECT user_id, anime_id, verdict, batch_id, decided_at FROM triage_all ORDER BY user_id, anime_id').all(),
  logs: db.prepare(`SELECT user_id, anime_id, episode, action, detail, watched_at FROM watch_log_all
    ORDER BY user_id, watched_at`).all(),
  filters: db.prepare('SELECT user_id, name, filter_json FROM saved_filter_all ORDER BY user_id, name').all(),
  userSettings: db.prepare("SELECT user_id, key, value FROM user_setting WHERE key <> 'share_token' ORDER BY user_id, key").all(),
  watchSites: db.prepare('SELECT name, url, ord, enabled FROM watch_site ORDER BY ord').all(),
  siteSettings: db.prepare('SELECT key, value FROM setting ORDER BY key').all(),
  relations: db.prepare('SELECT a_id, b_id FROM manual_relation ORDER BY a_id').all(),
  order: db.prepare('SELECT anime_id, user_order FROM franchise_member ORDER BY anime_id').all()
});
const plain = (x) => JSON.parse(JSON.stringify(x));
/** 像真正的每日备份那样走一遍 JSON 序列化 */
const backup = () => plain(exportAll());
const count = (sql, ...p) => db.prepare(sql).get(...p).c;

beforeEach(seed);

test('exportAll：version 3 整站格式，每个账号一份，分享令牌也在备份里', () => {
  const b = backup();
  assert.equal(b.app, 'j-anime');
  assert.equal(b.version, 3);
  assert.equal(b.kind, 'site');
  assert.deepEqual(b.accounts.map((a) => [a.id, a.username, a.role]), [[1, 'owner', 'admin'], [2, 'friend', 'user']]);
  assert.equal(b.counts.accounts, 2);
  assert.equal(b.counts.entries, 4);
  assert.equal(b.counts.triage, 2);
  assert.equal(b.counts.logs, 3);
  const [a1, a2] = b.accounts.map((a) => a.data);
  assert.equal(a1.entries.length, 3, '账号 1 只有自己的 3 条');
  assert.equal(a2.entries.length, 1, '账号 2 只有自己的 1 条');
  assert.equal(a2.entries[0].title, 'Frieren');
  // 每个账号那份里不重复带公共修正（只在顶层一份）
  assert.equal(a1.watchSites.length, 0);
  assert.equal(b.watchSites.length, 2);
  assert.equal(b.seriesOrder.length, 2);
  assert.equal(b.relations.length, 1);
  assert.deepEqual(b.siteSettings, [{ key: 'screenshot_dir', value: 'D:/shots' }]);
  assert.ok(a1.settings.some((s) => s.key === 'share_token'), '令牌导出了（是否还原由导入决定）');
});

test('往返：清空后逐个账号导入，个人记录和公共修正都回来，且互不串号', () => {
  const want = snap();
  const b = backup();
  wipe();
  assert.equal(count('SELECT count(*) c FROM user_entry_all'), 0);

  const s1 = as(ADMIN, () => importData(b));
  const s2 = as(USER, () => importData(b));
  assert.deepEqual(s1.unresolved, []);
  assert.deepEqual(s2.unresolved, []);
  assert.equal(s1.entries, 3); assert.equal(s2.entries, 1);
  assert.equal(s1.triage, 1); assert.equal(s2.triage, 1);
  assert.equal(s1.logs, 2); assert.equal(s2.logs, 1);
  assert.equal(s1.watchSites, 2); assert.equal(s2.watchSites, 0, '普通账号不还原公共修正');
  assert.equal(s1.relations, 1);
  assert.equal(s1.seriesOrder, 2);
  assert.deepEqual(snap(), want);
});

test('导入不还原 share_token（撤销过的分享链接不能被旧备份带回来）', () => {
  const b = backup();
  wipe();
  as(ADMIN, () => importData(b));
  as(USER, () => importData(b));
  assert.equal(count("SELECT count(*) c FROM user_setting WHERE key = 'share_token'"), 0);
  assert.equal(count("SELECT count(*) c FROM setting WHERE key = 'share_token'"), 0);
  // 其它个人设置照常还原
  assert.equal(db.prepare("SELECT value FROM user_setting WHERE user_id = 1 AND key = 'hide_nsfw'").get()?.value, '1');

  // 已有的新令牌也不会被备份里的旧令牌覆盖
  db.prepare("INSERT INTO user_setting (user_id, key, value) VALUES (1, 'share_token', 'new-token')").run();
  as(ADMIN, () => importData(b));
  assert.equal(db.prepare("SELECT value FROM user_setting WHERE user_id = 1 AND key = 'share_token'").get().value, 'new-token');

  // v2 单账号格式、以及塞进站点设置里的令牌，同样挡掉
  wipe();
  as(ADMIN, () => importData({ app: 'j-anime', version: 2, settings: [{ key: 'share_token', value: 'evil' }],
    siteSettings: [{ key: 'share_token', value: 'evil2' }] }));
  assert.equal(count("SELECT count(*) c FROM user_setting WHERE key = 'share_token'"), 0);
  assert.equal(count("SELECT count(*) c FROM setting WHERE key = 'share_token'"), 0);
});

test('非法 status / 评分 / 集数 / 短评 / 判定的条目整条跳过，合法的照常写入', () => {
  const b = backup();
  const mine = b.accounts.find((a) => a.id === 2).data;
  const base = mine.entries[0];   // Frieren，合法
  const bad = (patch, title) => ({ ...base, ...patch, anilist_id: null, mal_id: null, bgm_id: null, title, title_cn: title });
  // 每条坏记录都指向一部能解析到的番（按标题兜底），确保是规则挡下的，不是没匹配上
  mine.entries = [
    { ...base, my_score: 8.4, status: 'watching' },                   // 合法
    bad({ status: 'bogus' }, 'Bocchi the Rock!'),
    bad({ status: 'completed', my_score: 11 }, 'Only Mal Id'),
    bad({ status: 'completed', my_score: 8.45 }, 'Title Only'),
    { ...bad({ status: 'plan', current_episode: '3' }, 'Bocchi the Rock!'), year: 2022 },
    { ...bad({ status: 'plan', my_note: 'x'.repeat(2001) }, 'Only Mal Id'), year: 2020 }
  ];
  mine.triage = [{ ...mine.triage[0], verdict: 'hacked' }];
  wipe();
  const s = as(USER, () => importData(b));
  assert.equal(s.entries, 1, '只写进合法那条');
  assert.equal(s.unresolved.length, 5, '坏记录算进未匹配报给用户');
  assert.equal(s.triage, 0, '非法判定跳过');
  const rows = db.prepare('SELECT anime_id, status, my_score FROM user_entry_all ORDER BY anime_id').all().map(plain);
  assert.deepEqual(rows, [{ anime_id: 11, status: 'watching', my_score: 8.4 }]);
  assert.equal(count('SELECT count(*) c FROM triage_all'), 0);
});

test('普通账号导入整站备份：只还原自己那份，不碰公共修正和别人的数据', () => {
  const b = backup();
  wipe();
  const s = as(USER, () => importData(b));
  assert.equal(s.entries, 1);
  assert.equal(count('SELECT count(*) c FROM user_entry_all WHERE user_id = 1'), 0, '没把管理员的记录写进来');
  assert.equal(count('SELECT count(*) c FROM user_entry_all WHERE user_id = 2'), 1);
  assert.equal(count('SELECT count(*) c FROM watch_site'), 0);
  assert.equal(count('SELECT count(*) c FROM setting'), 0);
  assert.equal(count('SELECT count(*) c FROM manual_relation'), 0);
  assert.equal(count('SELECT count(*) c FROM franchise_member WHERE user_order IS NOT NULL'), 0);
});

test('replace：先在临时备份目录留一份，只清当前账号自己的记录', () => {
  const b = backup();
  // 账号 2 在备份之后又加了一条 —— replace 应该把它清掉；账号 1 的数据不能受影响
  db.prepare("INSERT INTO user_entry_all (user_id, anime_id, status) VALUES (2, 13, 'dropped')").run();
  const before1 = count('SELECT count(*) c FROM user_entry_all WHERE user_id = 1');
  const s = as(USER, () => importData(b, { replace: true }));
  assert.ok(s.safety && s.safety.startsWith(process.env.J_ANIME_BACKUPS), '安全备份写在测试目录');
  assert.ok(readdirSync(process.env.J_ANIME_BACKUPS).some((f) => /before-import-u2/.test(f)));
  assert.deepEqual(db.prepare('SELECT anime_id FROM user_entry_all WHERE user_id = 2').all().map((r) => r.anime_id), [11]);
  assert.equal(count('SELECT count(*) c FROM user_entry_all WHERE user_id = 1'), before1);
  assert.equal(count('SELECT count(*) c FROM watch_site'), 2, '普通账号 replace 不清观看站');
});

test('备份里没有当前账号那份：什么个人数据都不写，也不报错', () => {
  const b = backup();
  wipe();
  db.prepare("INSERT INTO account (id, username, role) VALUES (3, 'newbie', 'user')").run();
  const s = as({ id: 3, role: 'user' }, () => importData(b));
  assert.equal(s.entries + s.triage + s.logs + s.filters + s.settings, 0);
  assert.equal(count('SELECT count(*) c FROM user_entry_all'), 0);
});

test('不是 j-anime 的文件直接拒绝', () => {
  assert.throws(() => as(ADMIN, () => importData({ app: 'other', version: 3 })), /不是 j-anime/);
});

// 曾经的缺口（2026-10-21 已修）：exportData 不导出 saved_filter.is_default，
// 还原后「我的筛选」的默认那套丢失。
test('往返保留「我的筛选」的默认标记 is_default', () => {
  db.exec("UPDATE saved_filter_all SET is_default = 1 WHERE user_id = 1");
  const b = backup();
  wipe();
  as(ADMIN, () => importData(b));
  assert.equal(count('SELECT count(*) c FROM saved_filter_all WHERE user_id = 1 AND is_default = 1'), 1);
});

test('同一份备份不带 replace 导两次：筛选和带时间的观看日志不重复', () => {
  const b = backup();
  wipe();
  as(ADMIN, () => importData(b));
  const once = [count('SELECT count(*) c FROM saved_filter_all'), count('SELECT count(*) c FROM watch_log_all')];
  as(ADMIN, () => importData(b));
  assert.deepEqual([count('SELECT count(*) c FROM saved_filter_all'), count('SELECT count(*) c FROM watch_log_all')], once);
});

test('replace 也清掉自己的「我的筛选」，不会叠一份', () => {
  const b = backup();
  const n = count('SELECT count(*) c FROM saved_filter_all WHERE user_id = 1');
  as(ADMIN, () => importData(b, { replace: true }));
  assert.equal(count('SELECT count(*) c FROM saved_filter_all WHERE user_id = 1'), n);
});

test('重建库后账号 id 变了：按用户名认出自己那份；两样都对不上时标出 missingAccount', () => {
  const b = backup();
  wipe();
  db.exec("DELETE FROM account");
  db.prepare("INSERT INTO account (id, username, role) VALUES (7, 'owner', 'admin')").run();
  const s = as({ id: 7, username: 'owner', role: 'admin' }, () => importData(b));
  assert.ok(s.entries > 0 && !s.missingAccount, '按用户名找回 owner 的记录');
  assert.ok(count('SELECT count(*) c FROM user_entry_all WHERE user_id = 7') > 0);
  db.prepare("INSERT INTO account (id, username, role) VALUES (8, 'stranger', 'user')").run();
  assert.equal(as({ id: 8, username: 'stranger', role: 'user' }, () => importData(b)).missingAccount, true);
});
