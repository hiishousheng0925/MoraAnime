/**
 * 换库（db-tasks.js apply）里「藏在公共表里的个人数据」和换库中断的善后 —— 2026-10-22 审查加的。
 *
 *   node --test desktop/test/
 *
 * 用仓库里的网站源码（src/lib/server、scripts/migrate.js）在临时目录建两份小库：
 * 旧库 = 用户本机的（手排过系列顺序、积累了片源统计），新库 = 站主发的（站主自己的顺序 / 统计、有一条折成了 stub）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { recoverInterruptedSwap, SWAP_READY } from '../catalog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATE = join(ROOT, 'scripts', 'migrate.js');

/** 建空库（init-db.js 是网站唯一允许新建空库的入口） */
function freshDb(path) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'init-db.js')], { env: { ...process.env, J_ANIME_DB: path, J_ANIME_DATA: dirname(path) }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return new DatabaseSync(path);
}

/** anime：[id, 是否 stub, dup_of]；members：[franchise, anime, release_order, user_order] */
function fill(db, { anime, members, meta }) {
  const ins = db.prepare('INSERT INTO anime (id, uid, title, is_stub, dup_of) VALUES (?, ?, ?, ?, ?)');
  for (const [id, stub = 0, dup = null] of anime) ins.run(id, `u${id}`, `t${id}`, stub, dup);
  for (const f of new Set(members.map((m) => m[0]))) db.prepare('INSERT INTO franchise (id, name) VALUES (?, ?)').run(f, `f${f}`);
  const im = db.prepare('INSERT INTO franchise_member (franchise_id, anime_id, release_order, user_order) VALUES (?, ?, ?, ?)');
  for (const [f, a, ro, uo = null] of members) im.run(f, a, ro, uo);
  for (const [k, v] of Object.entries(meta)) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
  db.close();
}

test('换库：本机手排的系列顺序按 anime_id 搬过去（stub 改挂赢家、新成员插进去），片源统计以本机为准', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mora-swap-test-'));
  try {
    const data = join(tmp, 'data');
    mkdirSync(data);
    // 旧库（本机）：系列 10 拖成 2,3,1；系列 20 把 5 拖到最前；系列 30 没动过
    fill(freshDb(join(data, 'j-anime.db')), {
      anime: [[1], [2], [3], [4], [5], [6], [8], [9]],
      members: [[10, 1, 1, 3], [10, 2, 2, 1], [10, 3, 3, 2], [20, 4, 1, 2], [20, 5, 2, 1], [30, 8, 1], [30, 9, 2]],
      meta: { 'src_stat2:siteA': '{"ok":5,"fail":1}', 'src_stat2:siteB': '{"ok":2,"fail":0}' }
    });
    // 新库（站主）：系列重新编号、加了新番 7；5 折成 stub → 6；站主自己排了系列 21 / 30
    fill(freshDb(join(tmp, 'new.db')), {
      anime: [[1], [2], [3], [4], [5, 1, 6], [6], [7], [8], [9]],
      members: [[11, 1, 1], [11, 2, 2], [11, 3, 3], [11, 7, 4], [21, 4, 1, 1], [21, 6, 2, 2], [30, 8, 1, 2], [30, 9, 2, 1]],
      meta: { 'src_stat2:siteA': '{"ok":0,"fail":9}', 'src_stat2:siteC': '{"ok":1,"fail":1}', other: 'x' }
    });
    const r = spawnSync(process.execPath, [join(ROOT, 'desktop', 'db-tasks.js'), 'apply', join(tmp, 'new.db'), 'v-test'], {
      env: { ...process.env, J_ANIME_DATA: data, MORA_HOME: tmp, MORA_LIB: join(ROOT, 'src', 'lib', 'server'), MORA_MIGRATE: MIGRATE },
      encoding: 'utf8'
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const rep = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(rep.seriesOrder, 2, '系列 11、21 用本机顺序');

    const db = new DatabaseSync(join(data, 'j-anime.db'), { readOnly: true });
    const order = (f) => Object.fromEntries(db.prepare('SELECT anime_id a, user_order o FROM franchise_member WHERE franchise_id = ?').all(f).map((x) => [x.a, x.o]));
    // 手排的相对顺序 2,3,1 保持；新番 7 按播出顺序插在 3 后面
    assert.deepEqual(order(11), { 2: 1, 3: 2, 7: 3, 1: 4 });
    // 5 折成了 6：本机「5 在最前」变成「6 在最前」，盖过站主的顺序
    assert.deepEqual(order(21), { 6: 1, 4: 2 });
    // 本机没手排过的系列：沿用站主的
    assert.deepEqual(order(30), { 9: 1, 8: 2 });

    const meta = (k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value;
    assert.equal(meta('src_stat2:siteA'), '{"ok":5,"fail":1}', '本机有的以本机为准');
    assert.equal(meta('src_stat2:siteB'), '{"ok":2,"fail":0}', '本机独有的搬过去');
    assert.equal(meta('src_stat2:siteC'), '{"ok":1,"fail":1}', '本机没记过的沿用新库');
    assert.equal(meta('other'), 'x', '别的 meta 不动');
    assert.equal(meta('mora_catalog_version'), 'v-test');
    db.close();

    assert.ok(!existsSync(join(data, 'j-anime.db' + SWAP_READY)), '换完要删掉就绪标记');
    assert.ok(!existsSync(join(data, 'j-anime.db.swap')));
    assert.equal(readdirSync(join(data, 'backups')).filter((f) => f.startsWith('j-anime.db.prev-')).length, 1);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('换库两次改名之间断电：按标记 / 备份把库接回来，不当成首次启动', async (t) => {
  const setup = ({ db, swap, marker, prev }) => {
    const data = mkdtempSync(join(tmpdir(), 'mora-recover-test-'));
    const backups = join(data, 'backups');
    mkdirSync(backups);
    if (db) writeFileSync(join(data, 'j-anime.db'), 'DB');
    if (swap) writeFileSync(join(data, 'j-anime.db.swap'), 'SWAP');
    const prevPath = join(backups, 'j-anime.db.prev-2026-10-22T00-00-00-000Z');
    if (prev) {
      writeFileSync(join(backups, 'j-anime.db.prev-2026-10-01T00-00-00-000Z'), 'OLDER');
      writeFileSync(prevPath, 'PREV');
    }
    if (marker) writeFileSync(join(data, 'j-anime.db' + SWAP_READY), JSON.stringify({ prev: prevPath }));
    const cur = () => (existsSync(join(data, 'j-anime.db')) ? readFileSync(join(data, 'j-anime.db'), 'utf8') : null);
    t.after(() => rmSync(data, { recursive: true, force: true }));
    return { data, cur, has: (f) => existsSync(join(data, f)) };
  };

  await t.test('有库：不动，只清掉残留标记', () => {
    const s = setup({ db: true, swap: true, marker: true, prev: true });
    assert.equal(recoverInterruptedSwap(s.data), null);
    assert.equal(s.cur(), 'DB');
    assert.ok(!s.has('j-anime.db' + SWAP_READY));
  });
  await t.test('有标记 + swap：swap 是完整的新库，接上它', () => {
    const s = setup({ swap: true, marker: true, prev: true });
    assert.equal(recoverInterruptedSwap(s.data).restored, 'swap');
    assert.equal(s.cur(), 'SWAP');
    assert.ok(!s.has('j-anime.db.swap') && !s.has('j-anime.db' + SWAP_READY));
  });
  await t.test('有标记、swap 没了：接回标记里的旧库', () => {
    const s = setup({ marker: true, prev: true });
    assert.equal(recoverInterruptedSwap(s.data).restored, 'prev');
    assert.equal(s.cur(), 'PREV');
  });
  await t.test('没标记但有 swap（来历不明）：保守接回最新的 prev，swap 挪进 backups 不删', () => {
    const s = setup({ swap: true, prev: true });
    const r = recoverInterruptedSwap(s.data);
    assert.equal(r.restored, 'prev');
    assert.equal(s.cur(), 'PREV');
    assert.ok(readdirSync(join(s.data, 'backups')).some((f) => f.startsWith('j-anime.db.swap-orphan-')));
  });
  await t.test('没标记也没 swap：不是换库中断，不动（可能是用户自己删的库）', () => {
    const s = setup({ prev: true });
    assert.equal(recoverInterruptedSwap(s.data), null);
    assert.equal(s.cur(), null);
  });
});

test('换库：观看站随番剧库下发当默认值；本机配过的保留本机的（2026-10-23）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mora-swap-test-'));
  const site = (db, rows) => { for (const [n, u] of rows) db.prepare('INSERT INTO watch_site (name, url, ord, enabled) VALUES (?, ?, 0, 1)').run(n, u); };
  const apply = (data, newDb) => {
    const r = spawnSync(process.execPath, [join(ROOT, 'desktop', 'db-tasks.js'), 'apply', newDb, 'v-ws'], {
      env: { ...process.env, J_ANIME_DATA: data, MORA_HOME: tmp, MORA_LIB: join(ROOT, 'src', 'lib', 'server'), MORA_MIGRATE: MIGRATE },
      encoding: 'utf8'
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  };
  const names = (path) => { const d = new DatabaseSync(path, { readOnly: true }); const v = d.prepare('SELECT name FROM watch_site ORDER BY name').all().map((x) => x.name); d.close(); return v; };
  try {
    const data = join(tmp, 'data');
    mkdirSync(data);
    // ① 本机一个观看站都没有 → 用新库带来的
    freshDb(join(data, 'j-anime.db')).close();
    let n = freshDb(join(tmp, 'new1.db')); site(n, [['AGE', 'https://a/{q}'], ['樱花', 'https://b/{q}']]); n.close();
    apply(data, join(tmp, 'new1.db'));
    assert.deepEqual(names(join(data, 'j-anime.db')), ['AGE', '樱花']);
    // ② 本机改过（只留自己加的一个）→ 下次换库不被新库覆盖
    const db = new DatabaseSync(join(data, 'j-anime.db'));
    db.exec('DELETE FROM watch_site'); site(db, [['自建', 'https://c/{q}']]); db.close();
    n = freshDb(join(tmp, 'new2.db')); site(n, [['AGE', 'https://a/{q}'], ['Otage', 'https://d/{q}']]); n.close();
    apply(data, join(tmp, 'new2.db'));
    assert.deepEqual(names(join(data, 'j-anime.db')), ['自建']);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
