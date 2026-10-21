/**
 * 系列分组（franchise）。
 *
 * 数据来源：AOD 的 relatedAnime（一组跨站 URL）+ 我手动补的 manual_relation。
 *
 * ⚠️ 两个关键局限，直接决定了这里的算法：
 *  1. AOD 的关联**没有方向和类型** —— 分不出前传/续作/外传。
 *  2. 关联极其宽松（44 万条边 / 2.3 万节点，平均每部 19 条），
 *     里面混了角色客串、同世界观、同原作改编。**纯连通分量会炸** ——
 *     实测直接做并查集会得到一个 5723 部的「系列」，完全没用。
 *
 * 所以合并需要**双条件**：既有关联边，标题词干还得相似。
 * 这样链式传播（A—B—C—D…）会在词干变化处被切断。
 * 「剧情顺序」（前传排前面）仍需 AniList 的 relationType，等 API 恢复。
 * 「剧情顺序」（前传排前面）需要 AniList 的 relationType，等 API 恢复。
 *
 * 顺带做一件文档里标为「不阻塞」但一直没做的事：
 *   3. 总集篇 / 回顾篇 标记为「可跳过」—— 追长番时能省掉大量时间
 */
import { getDb, initSchema, tx } from '../src/lib/server/db.js';
import { mergeUserOrder } from '../src/lib/server/seriesOrder.js';

const db = getDb();
initSchema(db);

// 总集篇关键词（日/中/英）
const SKIP_RE = /(総集編|総集篇|総てを|そうしゅうへん|总集篇|總集篇|回顾|recap|compilation|digest|summary|highlights|special edition|重编|再編集)/i;
const isSkippable = (a) => {
  if (!['SPECIAL', 'OVA', 'MOVIE', 'ONA'].includes(a.type)) return null;
  const hay = [a.title, a.title_ja, a.title_cn].filter(Boolean).join(' ');
  if (SKIP_RE.test(hay)) return '总集篇 / 回顾篇（剧情与正片重复）';
  return null;
};

const info = db.prepare(`SELECT id, title, title_ja, title_cn, type, year, season, episodes,
  bgm_collection, source_count FROM anime WHERE id = ?`);

console.log('📖 读取关联边…');
// URL → anime_id
const urlMap = new Map(
  db.prepare('SELECT url, anime_id FROM anime_source').all().map((r) => [r.url, r.anime_id]));

const edges = [];
for (const r of db.prepare('SELECT anime_id, url FROM anime_related_raw').all()) {
  const to = urlMap.get(r.url);
  if (to && to !== r.anime_id) edges.push([r.anime_id, to]);
}
for (const r of db.prepare('SELECT a_id, b_id FROM manual_relation').all()) edges.push([r.a_id, r.b_id]);
console.log(`   可解析的边 ${edges.length}（含手动 ${db.prepare('SELECT count(*) c FROM manual_relation').get().c} 条）`);

/**
 * 标题词干：去掉季数/篇章/剧场版等后缀，只留核心名。
 * 「葬送のフリーレン 第2期」→「葬送のフリーレン」
 */
const STRIP = new RegExp(
  '(' +
  '第[0-9０-９一二三四五六七八九十]+[季期部章]|' +
  '(?:2nd|3rd|4th|[0-9]+th)\\s*season|season\\s*[0-9]+|' +
  'part\\s*[0-9ivx]+|final\\s*season|[0-9]+(?:st|nd|rd|th)?\\s*シーズン|' +
  '劇場版|剧场版|総集編|总集篇|the\\s+movie|movie\\s*[0-9]*|ova|ona|special|sp|' +
  '第[0-9０-９]+話|前編|後編|前篇|后篇|完結編|完结篇' +
  ')', 'gi');

const stem = (s) => String(s || '')
  .replace(/[（(\[【][^)）\]】]*[)）\]】]/g, ' ')
  .replace(STRIP, ' ')
  .replace(/[^\p{L}\p{N}]+/gu, '')
  .toLowerCase();

/** bigram Dice 相似度 */
function sim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bg = (x) => { const m = new Set(); for (let i = 0; i < x.length - 1; i++) m.add(x.slice(i, i + 2)); return m; };
  const A = bg(a), B = bg(b);
  let hit = 0; for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
}

/** 两部番是否算同一系列：一方词干包含另一方，或相似度够高 */
const stems = new Map();
const stemOf = (id) => {
  if (!stems.has(id)) {
    const r = info.get(id);
    stems.set(id, r ? stem(r.title_ja || r.title) || stem(r.title) : '');
  }
  return stems.get(id);
};
function sameSeries(a, b) {
  const sa = stemOf(a), sb = stemOf(b);
  if (!sa || !sb) return false;
  const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  if (short.length >= 4 && long.includes(short)) return true;
  return sim(sa, sb) >= 0.72;
}

// 并查集
const parent = new Map();
const find = (x) => {
  if (!parent.has(x)) parent.set(x, x);
  let r = x;
  while (parent.get(r) !== r) r = parent.get(r);
  while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
  return r;
};
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
let kept = 0, cut = 0;
for (const [a, b] of edges) {
  if (sameSeries(a, b)) { union(a, b); kept++; } else cut++;
}
console.log(`   词干校验后：保留 ${kept} 条，切断 ${cut} 条（角色客串/同世界观等误连）`);

const groups = new Map();
for (const k of parent.keys()) {
  const r = find(k);
  if (!groups.has(r)) groups.set(r, []);
  groups.get(r).push(k);
}
const multi = [...groups.values()].filter((g) => g.length > 1);
const sizes = multi.map((g) => g.length).sort((a, b) => b - a);
console.log(`   连通分量 ${groups.size}，多于 1 部的系列 ${multi.length}`);
console.log(`   最大系列 ${sizes[0] ?? 0} 部，前 5 大：${sizes.slice(0, 5).join(' / ')}`);
if (sizes[0] > 60) console.warn(`   ⚠️ 最大系列 ${sizes[0]} 部，可能仍有误连`);

const SEASON_ORD = { WINTER: 1, SPRING: 2, SUMMER: 3, FALL: 4 };

/**
 * ⚠️ 主人在详情页手动调过的系列顺序（user_order）必须挺过重建。
 * 原来整表 DELETE 后不写回，月度同步一跑《物语》这类手排的顺序就回到了播出顺序，
 * 而 user.js 的注释还写着「同步脚本不会覆盖它」。
 * 重建后系列成员可能变了（新番并进来），所以不能原样抄：手排过的按手排顺序，
 * 新成员插在它播出顺序上的前一部后面。
 */
const savedOrder = new Map(db.prepare(
  'SELECT anime_id, user_order FROM franchise_member WHERE user_order IS NOT NULL').all()
  .map((r) => [r.anime_id, r.user_order]));

console.log('💾 写入…');
let skipped = 0, kept_order = 0;
tx(db, () => {
  db.exec('DELETE FROM franchise_member; DELETE FROM franchise;');
  const insF = db.prepare('INSERT INTO franchise (name, size) VALUES (?, ?) RETURNING id');
  const insM = db.prepare(`INSERT INTO franchise_member
    (franchise_id, anime_id, release_order, is_skippable, skip_reason, user_order) VALUES (?,?,?,?,?,?)`);

  for (const ids of multi) {
    const rows = ids.map((id) => info.get(id)).filter(Boolean);
    if (rows.length < 2) continue;
    // 播出顺序：年份 → 季度 → TV 优先 → 收录站多的优先
    rows.sort((a, b) =>
      (a.year ?? 9999) - (b.year ?? 9999) ||
      (SEASON_ORD[a.season] ?? 0) - (SEASON_ORD[b.season] ?? 0) ||
      (a.type === 'TV' ? -1 : 0) - (b.type === 'TV' ? -1 : 0) ||
      (b.source_count ?? 0) - (a.source_count ?? 0));
    // 系列名取「收录站最多 + 收藏最高」的那部
    const anchor = [...rows].sort((a, b) =>
      (b.source_count ?? 0) - (a.source_count ?? 0) ||
      (b.bgm_collection ?? 0) - (a.bgm_collection ?? 0))[0];
    const { id: fid } = insF.get(anchor.title_cn || anchor.title, rows.length);
    const manual = mergeUserOrder(rows.map((r) => r.id), savedOrder);
    if (manual) kept_order++;
    rows.forEach((r, i) => {
      const reason = isSkippable(r);
      if (reason) skipped++;
      insM.run(fid, r.id, i + 1, reason ? 1 : 0, reason, manual?.get(r.id) ?? null);
    });
  }
});

const c = (s) => db.prepare(s).get().c;
console.log('\n✅ 完成');
console.log(`   系列数        ${c('SELECT count(*) c FROM franchise')}`);
console.log(`   已归入系列    ${c('SELECT count(*) c FROM franchise_member')} / ${c('SELECT count(*) c FROM anime WHERE is_stub=0')}`);
console.log(`   标为可跳过    ${skipped}`);
console.log(`   保留手排顺序  ${kept_order} 个系列（重建前有 ${savedOrder.size} 部手排过）`);
console.log(`   最大系列      ${db.prepare('SELECT name, size FROM franchise ORDER BY size DESC LIMIT 1').get()?.size} 部`);
console.log('\n   最大的 5 个系列：');
for (const r of db.prepare('SELECT name, size FROM franchise ORDER BY size DESC LIMIT 5').all())
  console.log(`     ${String(r.size).padStart(3)} 部  ${r.name}`);
console.log('\n   可跳过样例：');
for (const r of db.prepare(`SELECT coalesce(a.title_cn,a.title) t, a.year, fm.skip_reason
  FROM franchise_member fm JOIN anime a ON a.id=fm.anime_id
  WHERE fm.is_skippable=1 ORDER BY a.bgm_collection DESC NULLS LAST LIMIT 5`).all())
  console.log(`     ${r.year ?? '?'}  ${String(r.t).slice(0, 40)}`);
db.prepare(`INSERT INTO sync_log (kind,started_at,finished_at,items,status)
            VALUES ('franchise',datetime('now'),datetime('now'),?,'ok')`).run(c('SELECT count(*) c FROM franchise'));
