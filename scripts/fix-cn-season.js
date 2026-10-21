/**
 * 一次性修复：用罗马字标题的季数校正 bgm 抄来的中文名。
 *
 * bgm 对分季的粒度和 AOD 不同，一个 bgm 条目常被匹配到多个 AOD 条目
 * （实测 604 个 bgm_id 挂在 1,300 条上）。目录里的表现是三张
 * 「间谍过家家 第二季」年份却是 2022 / 2023 / 2025 —— 只有 2023 那条对。
 * 同类还有《86》《胆大党》。
 *
 * 判据与改法见 src/lib/server/text.js: fixCnSeason
 * enrich-bgm 已在写入时应用同一函数，这里只修历史数据。
 *
 * ⚠️ 默认【只修罗马字带 Part / Cour 标记的条目】，不全库重跑。
 * 因为 fixCnSeason 认季数靠的是启发式，对「把版本号写进作品名」的会误判：
 *   「Honkai Impact 3rd - Reburn: II」→ 3rd 被当成第 3 季 → 「崩坏3 Reburn: II 第三季」
 *   「Tu Bian Yingxiong X」→ X 被当成罗马数字 10 → 「凸变英雄 第十季」
 * 实测全库重跑会造出 7 条这样的。窄范围里没有这个风险 ——
 * 有显式 Part 标记的就是分割播出的条目，那才是要修的那类：
 *   《关于我转生变成史莱姆这档事》第二季分割播出（2021 冬 + 2021 夏），
 *   两段的中文名都是「第二季」，目录里看起来就是重复条目。
 * 真要全库扫一遍：加 --all，改完自己核对。
 */
import { getDb, initSchema, tx, DB_PATH } from '../src/lib/server/db.js';
import { fixCnSeason, seasonOrd, partOrd, segment } from '../src/lib/server/text.js';

const db = getDb();
initSchema(db);
const DRY = process.argv.includes('--dry-run') || process.argv.includes('--dry');
const ALL = process.argv.includes('--all');
/**
 * --trailing：只修 TV 里「罗马字结尾是单独一个 2–9、中文名却没写季数」的（#15）。
 * One Punch Man 3 → 一拳超人、Chihayafuru 2/3 → 都叫「歌牌情缘」这一类。
 */
const TRAILING = process.argv.includes('--trailing');
/**
 * 中文名已经用别的写法带了季数就不动（dry-run 实测 163 条候选里这类占了一大半）：
 *   「快把我哥带走2」「明日之丈2」「斗龙战士5」—— 数字直接写在名字里
 *   「偶像活动 第二年」「银河天使X」—— 用「第N年」或字母代号表示第几部
 * 照改会造出「快把我哥带走2 第二季」这种重复表达。
 */
const NUM_CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const carriesOrd = (cn, n) => new RegExp(`${n}|第\\s*${NUM_CN[n]}|[A-Za-zⅠ-Ⅹ]\\s*$`).test(cn);

const rows = db.prepare('SELECT id, title, title_ja, title_cn, type FROM anime WHERE title_cn IS NOT NULL').all();
const changes = [];
for (const r of rows) {
  /**
   * 默认范围：罗马字标题里【季数和分部号同时出现】的条目。
   *
   * 只有这种情况是无歧义的 —— 「2nd Season Part 2」明确说了「第二季的第二段」，
   * 中文名必须两个都写，否则和「2nd Season」那条同名。
   *
   * 光有分部号（「Part II」「Part 2」）不够：那个 II 到底是分段还是季数说不清，
   * 而 seasonOrd 认不出中缀罗马数字和英文序数词，硬算会把季数丢掉 ——
   * 实测这类会把「无职转生 第二季」改成「第2部分」、
   * 「钻石王牌 act2 第二季 第2部分」改成「第2部分」（Second Season 认不出来），
   * 还会造出「鲁邦三世 第二期 第2部分」这种重复表达。宁缺勿错。
   */
  const tv = r.type === 'TV';
  if (TRAILING) {
    const n = seasonOrd(r.title, { trailingNum: true });
    if (!tv || seasonOrd(r.title) > 1 || n <= 1 || carriesOrd(r.title_cn, n)
        || /剧场版|劇場版|电影|OVA/.test(r.title_cn)) continue;   // 中文名本身挂错了（#14），留给 #2 根治
  } else if (!ALL && !(seasonOrd(r.title) > 1 && partOrd(r.title) > 1)) continue;
  const next = fixCnSeason(r.title_cn, r.title, { tv });
  if (next !== r.title_cn) changes.push({ ...r, next });
}

console.log(`${DB_PATH}`);
console.log(`扫描 ${rows.length} 个中文名，${ALL ? '【--all 全库】' : TRAILING ? '其中 TV 结尾数字季数的' : '其中季数+分部号都明写的'}需要校正 `
  + `${changes.length} 条${DRY ? '（不写库）' : ''}\n`);
for (const c of changes.slice(0, 30))
  console.log(`  ${String(c.title_cn).padEnd(24)} → ${String(c.next).padEnd(26)} | ${c.title.slice(0, 42)}`);
if (changes.length > 30) console.log(`  …还有 ${changes.length - 30} 条`);

if (DRY || !changes.length) process.exit(0);

// 中文名进了搜索索引，改完必须重建对应行，否则按新名字搜不到
const upd = db.prepare('UPDATE anime SET title_cn = ? WHERE id = ?');
const delAlias = db.prepare("DELETE FROM anime_alias WHERE anime_id = ? AND src = 'bgm'");
const insAlias = db.prepare(`INSERT INTO anime_alias (anime_id,alias,has_kana,is_cjk,src)
  SELECT ?,?,0,1,'bgm' WHERE NOT EXISTS (SELECT 1 FROM anime_alias WHERE anime_id=? AND alias=?)`);
const delFts = db.prepare('DELETE FROM anime_fts WHERE rowid = ?');
const insFts = db.prepare('INSERT INTO anime_fts (rowid, seg) VALUES (?, ?)');
const names = db.prepare(`SELECT (SELECT group_concat(alias,' ') FROM anime_alias WHERE anime_id=?) a`);

tx(db, () => {
  for (const c of changes) {
    upd.run(c.next, c.id);
    delAlias.run(c.id);
    if (c.next) insAlias.run(c.id, c.next, c.id, c.next);
    delFts.run(c.id);
    insFts.run(c.id, segment([c.title, c.title_ja, c.next, names.get(c.id).a].filter(Boolean).join(' ')));
  }
});
console.log(`\n✅ 已校正 ${changes.length} 条，并重建了对应的搜索索引行`);

/**
 * 自检：同一年、同一类型下中文名不该重复 —— 分部号存在的意义就是区分它们。
 * 剩下的重复多半是别的成因（上游同一部拆成多条），列出来人工看。
 */
const dup = db.prepare(`SELECT title_cn, year, type, count(*) c, group_concat(id) ids FROM anime
  WHERE is_stub = 0 AND title_cn IS NOT NULL AND year IS NOT NULL
  GROUP BY title_cn, year, type HAVING c > 1 ORDER BY c DESC, title_cn LIMIT 10`).all();
console.log(`\n自检：同年同类型下中文名重复 ${dup.length ? dup.length + ' 组' : '0 组 ✅'}`);
for (const d of dup) console.log(`  ${d.year} ${String(d.type).padEnd(8)} ${d.title_cn} × ${d.c}  (id ${d.ids})`);
