/**
 * 统计页专项复核。
 *
 * 思路：不复用 stats() 的 SQL 去验 stats()（那只是把同一个逻辑跑两遍）。
 * 而是把原始表整张拉出来，用纯 JS 按需求文档的口径重算一遍，再和 stats() 比。
 * 两条独立路径算出同一个数，才算对。
 *
 * 用法：node scripts/test.js stats-audit
 */
const BASE = process.env.BASE || 'http://localhost:5173';

import { assertTestCopy } from './copy-gate.js';
assertTestCopy('请用  node scripts/test.js stats-audit');

let pass = 0, fail = 0;
const fails = [];
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  (${detail})` : ''}`); }
  else { fail++; fails.push(`${name} ${detail}`); console.log(`  ❌ ${name}  ${detail}`); }
};
const eq = (got, want, name) => ok(got === want, name, `得到 ${got} / 应为 ${want}`);
const same = (a, b, name) => {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  ok(x === y, name, x === y ? '' : `\n     得到 ${x}\n     应为 ${y}`);
};
/** 对象比较：键顺序无关（SQL 的 GROUP BY 顺序不该被断言绑死） */
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(process.env.J_ANIME_DB);
// 多账号：个人表是按 uid() 过滤的视图（见 multiUser.js），裸连接要自己注册；按管理员（id 1）核对
db.function('uid', { deterministic: true }, () => Number(process.env.J_ANIME_AS_USER) || 1);
const authed = { headers: { cookie: `j_anime_sid=${process.env.TEST_SESSION}` } };
const { setEntry, stats } = await import('../src/lib/server/queries.js');
const { GENRE_MAP } = await import('../src/lib/genres.js');

db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');

// ───────────────────────── 造一份口径覆盖完整的样本 ─────────────────────────
// 每种状态都要有，且要覆盖「填了进度 / 没填进度」两种情况 —— 集数口径的坑全在这。
const cand = db.prepare(`
  SELECT a.id, a.year, a.type, a.episodes, a.duration_sec FROM anime a
  WHERE a.is_stub = 0 AND a.year IS NOT NULL AND a.episodes >= 12 AND a.type = 'TV'
    AND EXISTS (SELECT 1 FROM anime_studio s WHERE s.anime_id = a.id AND s.role = 'studio'
                AND s.studio_norm IS NOT NULL AND s.studio_norm != '')
    AND EXISTS (SELECT 1 FROM anime_tag t WHERE t.anime_id = a.id)
  ORDER BY a.bgm_collection DESC LIMIT 200`).all();
const movies = db.prepare(`
  SELECT a.id, a.year, a.type, a.episodes, a.duration_sec FROM anime a
  WHERE a.is_stub = 0 AND a.year IS NOT NULL AND a.type = 'MOVIE' AND a.episodes = 1
  ORDER BY a.bgm_collection DESC LIMIT 30`).all();

// 年份互不相同，方便逐年核对
const tv = [];
for (const c of cand) if (!tv.some((x) => x.year === c.year)) tv.push(c);
if (tv.length < 6 || !movies.length) { console.error('样本不足'); process.exit(1); }

const SEED = [
  { a: tv[0], status: 'completed', ep: null, score: 9 },   // 看完·没填进度 → 应按总集数算
  { a: tv[1], status: 'completed', ep: 6,    score: 7.9 }, // 看完·填了 6   → 按 6 算（重看了一半也可能）；7.9 分归「7 分」档
  { a: tv[2], status: 'watching',  ep: 5,    score: null },
  { a: tv[3], status: 'watching',  ep: null, score: null }, // 在看·没填 → 应算 0，不能按总集数
  { a: tv[4], status: 'on_hold',   ep: 3,    score: 6.5 }, // 一位小数（2026-10-21 起）
  { a: tv[5], status: 'dropped',   ep: 7,    score: 4 },
  { a: movies[0], status: 'plan',  ep: null, score: null }  // 想看 → 分布里一律不算
];
for (const s of SEED) setEntry(s.a.id, { status: s.status, current_episode: s.ep, my_score: s.score });

// 观看日志（按本地日期造，转成 UTC 存 —— 和应用写入一致）：
// 3 天连续、断一天、再 2 天（其中一天两条）→ 最长连续 3
const LOG_DAYS = [-12, -11, -10, -8, -7, -7];
{
  const ins = db.prepare(`INSERT INTO watch_log_all (user_id, anime_id, episode, action, watched_at)
    VALUES (1, ?, 1, 'watch_ep', datetime(date('now', 'localtime', ? || ' day') || ' 12:00:00', 'utc'))`);
  for (const d of LOG_DAYS) ins.run(tv[0].id, String(d));
}

console.log('\n样本：');
for (const s of SEED)
  console.log(`  ${String(s.a.id).padStart(6)} ${s.a.year} ${s.a.type.padEnd(5)} 共${String(s.a.episodes).padStart(3)}集`
    + ` ${String(s.a.duration_sec ?? '(无时长)').padStart(9)}s/集  →  ${s.status.padEnd(9)} 进度 ${s.ep ?? '未填'} 分 ${s.score ?? '—'}`);

// ───────────────────────── 独立重算（纯 JS，不碰 stats 的 SQL） ─────────────────────────
const rows = db.prepare('SELECT * FROM user_entry').all();
const meta = new Map(db.prepare(`SELECT id, year, type, episodes, duration_sec FROM anime
  WHERE id IN (${rows.map(() => '?').join(',')})`).all(...rows.map((r) => r.anime_id)).map((a) => [a.id, a]));

const watchedRows = rows.filter((r) => r.status !== 'plan');   // ← 口径定义：除「想看」以外都看过
const epsOf = (r) => {
  const a = meta.get(r.anime_id);
  return r.status === 'completed' ? (r.current_episode ?? a.episodes ?? 0) : (r.current_episode ?? 0);
};

const want = {
  total: rows.length,
  watchedCount: watchedRows.length,
  episodes: watchedRows.reduce((n, r) => n + epsOf(r), 0),
  hours: Math.round(watchedRows.reduce((n, r) => n + epsOf(r) * (meta.get(r.anime_id).duration_sec ?? 1440), 0) / 3600),
  avgScore: (() => {
    const v = watchedRows.filter((r) => r.my_score != null).map((r) => r.my_score);
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
  })(),
  byStatus: rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {}),
  byYear: (() => {
    const m = new Map();
    for (const r of watchedRows) { const y = meta.get(r.anime_id).year; if (y != null) m.set(y, (m.get(y) ?? 0) + 1); }
    return [...m].sort((a, b) => a[0] - b[0]).map(([year, c]) => ({ year, c }));
  })(),
  byType: (() => {
    const m = new Map();
    for (const r of watchedRows) { const t = meta.get(r.anime_id).type; m.set(t, (m.get(t) ?? 0) + 1); }
    return [...m].sort((a, b) => b[1] - a[1]).map(([type, c]) => ({ type, c }));
  })(),
  scoreDist: (() => {
    const m = new Map();
    for (const r of watchedRows) if (r.my_score != null) {
      const s = Math.trunc(r.my_score); m.set(s, (m.get(s) ?? 0) + 1);
    }
    return [...m].sort((a, b) => a[0] - b[0]).map(([s, c]) => ({ s, c }));
  })()
};

// 题材：逐部番取标签集合，按中文题材求「有交集的番数」
const tagsOf = new Map();
for (const r of db.prepare(`SELECT anime_id, tag FROM anime_tag
  WHERE anime_id IN (${watchedRows.map(() => '?').join(',')})`).all(...watchedRows.map((r) => r.anime_id))) {
  if (!tagsOf.has(r.anime_id)) tagsOf.set(r.anime_id, new Set());
  tagsOf.get(r.anime_id).add(r.tag);
}
want.genres = Object.entries(GENRE_MAP)
  .map(([cn, tags]) => [cn, [...tagsOf.values()].filter((set) => tags.some((t) => set.has(t))).length])
  .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 16);

// 公司：按 studio_norm 统计「看过的番」数
const stuOf = new Map();
for (const r of db.prepare(`SELECT anime_id, studio_norm k FROM anime_studio
  WHERE role='studio' AND studio_norm IS NOT NULL AND studio_norm != ''
    AND anime_id IN (${watchedRows.map(() => '?').join(',')})`).all(...watchedRows.map((r) => r.anime_id))) {
  if (!stuOf.has(r.k)) stuOf.set(r.k, new Set());
  stuOf.get(r.k).add(r.anime_id);
}
// hero 标签：最多题材 / 峰值年份（同数取更晚）
want.topGenre = want.genres.length ? { name: want.genres[0][0], c: want.genres[0][1] } : null;
want.peakYear = (() => {
  let best = null;
  for (const r of want.byYear) if (!best || r.c > best.c || (r.c === best.c && r.year > best.year)) best = { year: r.year, c: r.c };
  return best;
})();

want.studios = [...stuOf].map(([k, set]) => [k, set.size])
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12);

// ───────────────────────── 比对 ─────────────────────────
const got = stats();

console.log('\n━━━ 1. 概览四个数字 ━━━');
eq(got.total, want.total, '番单总数（含想看）');
eq(got.watchedCount, want.watchedCount, '看过部数（不含想看）');
eq(got.episodes, want.episodes, '看过集数');
eq(got.hours, want.hours, '约合小时');
eq(got.avgScore, want.avgScore, '我的平均分');
same(sortKeys(got.byStatus), sortKeys(want.byStatus), '状态分项');

// 这几条是把口径写死，防止以后又被改回去
const tvDone = SEED[0], tvHalf = SEED[1], tvNoProg = SEED[3];
eq(got.episodes,
   tvDone.a.episodes + 6 + 5 + 0 + 3 + 7,
   `集数=看完补满(${tvDone.a.episodes})+6+5+0(在看未填)+3(搁置)+7(弃番)`);

console.log('\n━━━ 2. 分布图必须同一口径 ━━━');
same(got.byYear.map((r) => ({ year: r.year, c: r.c })), want.byYear, '作品年份分布');
same(got.byType.map((r) => ({ type: r.type, c: r.c })), want.byType, '类型构成');
same(got.scoreDist.map((r) => ({ s: r.s, c: r.c })), want.scoreDist, '评分分布');
same(got.genres, want.genres, '题材分布');
same(got.studios.map((s) => [s.studio, s.c]), want.studios, '制作公司');

const planYear = meta.get(SEED[6].a.id).year;
ok(!got.byYear.some((r) => r.year === planYear) || want.byYear.some((r) => r.year === planYear),
   '想看的年份不出现在年份分布', `想看=${planYear}`);
ok(!got.byType.some((r) => r.type === 'MOVIE'), '想看的剧场版不进类型构成');
ok(got.byType.reduce((n, r) => n + r.c, 0) === got.watchedCount, '类型构成合计=看过部数');
ok(got.byYear.reduce((n, r) => n + r.c, 0) === got.watchedCount, '年份分布合计=看过部数');
ok(got.genres.every(([, n]) => n <= got.watchedCount), '任一题材计数不超过看过部数');
ok(got.studios.every((s) => s.c <= got.watchedCount), '任一公司计数不超过看过部数');
ok(got.scoreDist.reduce((n, r) => n + r.c, 0) === watchedRows.filter((r) => r.my_score != null).length,
   '评分分布合计=打过分的部数');
// 一位小数按整数向下归档：7.9 在 7 分档、6.5 在 6 分档（不是四舍五入）
same(got.scoreDist.map((r) => ({ s: r.s, c: r.c })), [{ s: 4, c: 1 }, { s: 6, c: 1 }, { s: 7, c: 1 }, { s: 9, c: 1 }],
     '小数评分向下归档（7.9→7、6.5→6）');

console.log('\n━━━ 2b. 回顾 hero 的新字段 ━━━');
same(got.topGenre, want.topGenre, '最多的题材 = 题材分布第一名');
same(got.peakYear, want.peakYear, '峰值年份（同口径、同数取更晚）');
ok(!!got.peakYear && got.byYear.every((r) => r.c <= got.peakYear.c), '峰值年份的部数是年份分布最大值');
eq(got.longestStreak, 3, '最长连续天数（本地日期，日志在 -12/-11/-10/-8/-7/-7 天）');
{
  const firstLog = db.prepare("SELECT date(min(watched_at),'localtime') d FROM watch_log_all WHERE user_id = 1").get().d;
  const firstEntry = db.prepare("SELECT date(min(created_at),'localtime') d FROM user_entry_all WHERE user_id = 1").get().d;
  eq(got.since, [firstLog, firstEntry].filter(Boolean).sort()[0], '起始日期 = 番单 / 日志里最早的本地日期');
}

console.log('\n━━━ 3. 题材去重（不是取标签最大值） ━━━');
{
  // 旧算法：各标签计数取 max。构造一个能区分两者的场景才有意义 ——
  // 找一个中文题材，它的多个标签分别落在不同的番上
  let split = null;
  for (const [cn, tags] of Object.entries(GENRE_MAP)) {
    const hit = new Map();  // tag -> Set(anime)
    for (const t of tags) {
      const s = new Set([...tagsOf].filter(([, set]) => set.has(t)).map(([id]) => id));
      if (s.size) hit.set(t, s);
    }
    if (hit.size < 2) continue;
    const union = new Set([...hit.values()].flatMap((s) => [...s]));
    const max = Math.max(...[...hit.values()].map((s) => s.size));
    if (union.size > max) { split = { cn, union: union.size, max }; break; }
  }
  if (split) {
    const n = got.genres.find(([g]) => g === split.cn)?.[1] ?? null;
    ok(n === split.union, `「${split.cn}」按番去重`, `去重=${split.union} 旧的取max=${split.max} 实得=${n}`);
  } else ok(true, '本样本没有跨标签分裂的题材（无法区分两种算法，跳过）');
}

console.log('\n━━━ 4. 公司展示名与链接 ━━━');
for (const s of got.studios.slice(0, 5)) {
  ok(/^[A-Z0-9]/.test(s.label), `「${s.label}」首字母大写`);
  ok(!/co\.,?\s*ltd|inc\./i.test(s.label), `「${s.label}」不带公司后缀`);
  ok(s.studio === s.studio.toLowerCase(), `「${s.label}」链接值是 norm`, s.studio);
}
{
  const { listAnime } = await import('../src/lib/server/queries.js');
  const s = got.studios[0];
  ok(listAnime({ studio: s.studio, types: null }).total > 0, '公司链接能筛到结果', s.studio);
}

console.log('\n━━━ 5. 页面渲染出的数字和后端一致 ━━━');
{
  const r = await fetch(`${BASE}/stats`, authed);
  const html = await r.text();
  eq(r.status, 200, '统计页 200');
  // 首屏 hero 的数字都带 data-stat（2026-10 UI 大改：4 张 KPI 卡合成了一块 hero），千分位按 en-US
  const num = (key) => {
    const m = html.match(new RegExp(`data-stat="${key}"[^>]*>([^<]+)<`));
    return m ? m[1].trim() : null;
  };
  const fmt = (n) => Number(n).toLocaleString('en-US');
  eq(num('total'), fmt(got.total), '页面「番单总数」');
  eq(num('episodes'), fmt(got.episodes), '页面「看过集数」');
  eq(num('hours'), fmt(got.hours), '页面「约合小时」');
  eq(num('avg'), got.avgScore.toFixed(1), '页面「我的平均分」');
  eq(num('genre'), got.topGenre.name, '页面「最多的题材」');
  eq(num('year'), String(got.peakYear.year), '页面「最多的年份」');
  eq(num('streak'), String(got.longestStreak), '页面「最长连续」');
  ok(html.includes(`最多的题材 · ${got.topGenre.c} 部`), '页面写了最多题材的部数');
  ok(html.includes(`${got.peakYear.year} · ${got.peakYear.c} 部`), '年份柱峰值标了「年份 · 部数」');
  ok(html.includes(`看过 ${got.watchedCount} 部`), '页面标注了看过部数');
  ok(html.includes(`看过的 ${got.watchedCount} 部`), '分布图标注了口径');
  for (const s of got.studios.slice(0, 3)) ok(html.includes(s.label), `页面显示「${s.label}」`);
  ok(!/[a-z]+ co\.,? ltd/i.test(html), '页面没有残留的小写公司全名');
  for (const [g, n] of got.genres.slice(0, 3))
    ok(new RegExp(`${g}[\\s\\S]{0,600}>${n}<`).test(html), `页面题材「${g}」= ${n}`);
}

console.log('\n━━━ 6. 空番单 ━━━');
{
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');
  const z = stats();
  eq(z.total, 0, '总数 0');
  eq(z.episodes, 0, '集数 0');
  eq(z.hours, 0, '小时 0');
  eq(z.avgScore, null, '平均分 null');
  same(z.byYear, [], '年份分布空');
  same(z.studios, [], '公司空');
  same(z.genres, [], '题材空');
  eq(z.topGenre, null, '最多题材 null');
  eq(z.peakYear, null, '峰值年份 null');
  eq(z.longestStreak, 0, '最长连续 0');
  const r = await fetch(`${BASE}/stats`, authed);
  const html = await r.text();
  ok(r.status === 200 && html.includes('暂无观看记录'), '页面走空态、不报错');
}

console.log('\n' + '═'.repeat(52));
console.log(`  通过 ${pass}   失败 ${fail}`);
if (fail) { console.log('\n失败项：'); fails.forEach((f) => console.log('  ✗ ' + f)); }
console.log('═'.repeat(52));
// 不用 process.exit()：Windows 上它会撞 libuv 的断言
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
// 进程异常退出，58 条全过也被判成失败（实测每次必现）。设退出码、让事件循环自然结束就没有。
process.exitCode = fail ? 1 : 0;
