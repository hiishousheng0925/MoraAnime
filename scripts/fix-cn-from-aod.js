/**
 * 用 AOD 别名表里自带的简体中文名补 title_cn —— 零 API 请求。
 *
 * AOD 聚合的那些站里有中文站点，所以别名表里本来就躺着一批简体译名，
 * 而我们一直只从 Bangumi 取中文名，这批白放着：
 *   暗殺教室 第２期      → 暗杀教室 第二季
 *   CARDFIGHT!! ヴァンガード レギオンメイト編 → 卡片战斗先导者 双斗盟友篇
 *
 * ⚠️ 判据必须是「含简体专用字」，不能只判「有汉字没假名」。
 * 后者会把日文标题也算进来 —— 「秋物語」「15歳」「愛物語」都是没有假名的日文原题，
 * 当成中文名写进 title_cn 就是凭空造译名。含「们这说国长门关电车马龙」这类
 * 简体专用字才是「这串字是简体中文」的正面证据。
 * 同理不做繁→简机械转换：繁体别名多是港台译名，逐字转出来的结果未必是大陆译名，
 * 而且分不清「繁体中文」和「日文汉字」。
 *
 * 幂等（只填 title_cn IS NULL 的）。用法：node scripts/fix-cn-from-aod.js [--dry]
 */
import { getDb } from '../src/lib/server/db.js';
import { segment, fixCnSeason, SIMPLIFIED as SIMP } from '../src/lib/server/text.js';

const dry = process.argv.includes('--dry');
const db = getDb();

const KANA = /[぀-ヿ]/;
const LATIN = /[A-Za-z]/;

/**
 * 「Sekai Meisaku Douwa Zenshuu (世界名作童话全集)」这种罗马音+括号的复合写法，
 * 只取括号里的中文部分 —— 整串写进 title_cn 会在卡片上显示一长条罗马音。
 */
const unwrap = (s) => {
  const m = String(s).match(/[（(]([^（()）]*[一-鿿][^（()）]*)[)）]\s*$/);
  return (m && !/[一-鿿]/.test(s.slice(0, m.index)) ? m[1] : s).trim();
};

const rows = db.prepare(`SELECT a.id, a.year, a.type, a.title, a.title_ja, a.source_count, al.alias
  FROM anime a JOIN anime_alias al ON al.anime_id = a.id
  WHERE a.is_stub = 0 AND a.is_jp = 1 AND a.title_cn IS NULL
    AND coalesce(al.src, '') != 'bgm' AND al.is_cjk = 1`).all();

const cand = new Map();
for (const r of rows) {
  const alias = unwrap(r.alias);
  if (KANA.test(alias)) continue;                                   // 有假名 → 日文
  if (!SIMP.test(alias)) continue;                                  // 没有简体专用字 → 不能断定是中文
  // 别名就等于标题本身 → 要么是日文原题，要么这条是国创（原名就是中文），填了没意义
  if (alias === r.title_ja || alias === r.title) continue;
  if (alias.includes(';')) continue;                                // 「十万个冷笑话; 十万个冷笑话 大电影」这种把两个名字并在一起的
  if ((alias.match(LATIN) ?? []).length / alias.length > 0.4) continue;  // 拉丁占大头的复合写法
  /**
   * 季数得和罗马字标题对得上（e2e 14h 那条不变式在守）。
   * 但这里【不能像 enrich-bgm 那样硬套 fixCnSeason】—— 它在这批标题上会算错：
   *   「Honkai Impact 3rd - Reburn: II」里的 3rd 是游戏名的一部分，不是季数，
   *      于是「崩坏3 Reburn: II」被改成「崩坏3 Reburn: II 第三季」
   *   「Tu Bian Yingxiong X」的 X 被当成罗马数字 10 → 「凸变英雄 第十季」
   * 硬套等于凭空造季数。对不上的直接跳过 —— 这批本来就是白捡的，宁缺勿错。
   */
  if (fixCnSeason(alias, r.title) !== alias) continue;
  const cur = cand.get(r.id);
  // 同一条番有多个中文别名时取最长的（最完整，通常带季数）
  if (!cur || alias.length > cur.alias.length) cand.set(r.id, { ...r, alias });
}

/**
 * 剩下的错只可能来自上游别名本身挂错 —— AOD 按 source URL 合并条目，
 * 偶尔会把别的作品的别名并进来：
 *   「スポーツ大佐 第18話…」→「15名动画人」
 *   「1日外出録ハンチョウ」→「中间管理录利根川」（同作者的另一部）
 * 试过用「和原题的汉字有没有重合」自动挑，但简化字形对不上（編↔篇、悪↔恶），
 * 把「卡片战斗先导者 双斗盟友篇」「蜡笔小新」这些正确的也误伤了 ——
 * 所以不自动挑，下面把全部条目打出来，人工过一遍更快（总共一百多条）。
 */
console.log(`AOD 别名里能直接用的简体中文名：${cand.size} 条${dry ? '（--dry，不写库）' : ''}`);
const list = [...cand.values()].sort((a, b) => b.source_count - a.source_count);
for (const r of list)
  console.log(`  ${String(r.year ?? '?').padEnd(5)} ${String(r.type).padEnd(8)} ${r.source_count}站  `
    + `${String(r.title_ja || r.title).slice(0, 28).padEnd(30)} → ${r.alias}`);

if (!dry && list.length) {
  const upd = db.prepare('UPDATE anime SET title_cn = ? WHERE id = ? AND title_cn IS NULL');
  const delFts = db.prepare('DELETE FROM anime_fts WHERE rowid = ?');
  const insFts = db.prepare('INSERT INTO anime_fts (rowid, seg) VALUES (?, ?)');
  const names = db.prepare(`SELECT a.title, a.title_ja, a.title_cn,
      (SELECT group_concat(alias, ' ') FROM anime_alias WHERE anime_id = a.id) aliases
    FROM anime a WHERE a.id = ?`);
  let n = 0;
  for (const r of list) {
    n += upd.run(r.alias, r.id).changes;
    const x = names.get(r.id);                    // 新中文名要并进搜索索引
    delFts.run(r.id);
    insFts.run(r.id, segment([x.title, x.title_ja, x.title_cn, x.aliases].filter(Boolean).join(' ')));
  }
  console.log(`✔ 已补 ${n} 条中文名，并重建了这些条目的搜索索引`);
}
