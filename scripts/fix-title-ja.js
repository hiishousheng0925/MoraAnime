/**
 * 重算 title_ja —— 从别名里取【最长】的带假名别名（见 text.js: pickTitleJa）。
 *
 * 旧逻辑取第一个，于是「ふつつかな悪女ではございますが 〜雛宮蝶鼠とりかえ伝〜」
 * 的 title_ja 被存成缩写「ふつつか」。日文标题是判断「两条记录是不是同一部番」
 * 的锚（server/dedup.js），锚成缩写重复条目就合不掉。
 *
 * 幂等。用法：node scripts/fix-title-ja.js [--dry]
 */
import { getDb } from '../src/lib/server/db.js';
import { pickTitleJa, looksChinese, hasForeignScript } from '../src/lib/server/text.js';

const dry = process.argv.includes('--dry');
const db = getDb();

/**
 * ⚠️ 必须把汉字别名也读进来（原来只读 has_kana=1）。
 * 怪獣8号 / 闇芝居 / 桃源暗鬼 这类标题全是汉字、一个假名都没有 ——
 * 只读带假名的别名时它们的 title_ja 一直是 NULL，而中文名补全的队列条件是
 * `title_ja IS NOT NULL`，于是这 1,100 多条日本作品永远进不了队列。
 */
/**
 * ⚠️ 排掉 src='bgm' 的别名。enrich-bgm 命中后会把 bgm 的中文名也插进 anime_alias
 * （给搜索用），那些按构造一定是中文，绝不可能是日文标题。而 title_cn 存的是
 * fixCnSeason 校正过的名字、别名存的是原名，两者常常不一样
 * （别名「异兽魔都」／title_cn「异兽魔都 第三季」），
 * 所以下面那句 `a !== r.title_cn` 拦不住 —— 得按来源排。
 */
const aliases = new Map();
for (const a of db.prepare(`SELECT anime_id, alias FROM anime_alias
  WHERE (has_kana = 1 OR is_cjk = 1) AND coalesce(src,'') != 'bgm'`).all())
  (aliases.get(a.anime_id) ?? aliases.set(a.anime_id, []).get(a.anime_id)).push(a.alias);

const upd = db.prepare('UPDATE anime SET title_ja = ? WHERE id = ?');
let changed = 0;
const samples = [];
for (const r of db.prepare('SELECT id, title, title_ja, title_cn FROM anime').all()) {
  /**
   * 候选里排掉中文名本身：这一步只在没有假名别名时才起作用，而那时候「最长的汉字别名」
   * 很可能正是简体中文名（「暗芝居 第十四季」比「闇芝居」长）。
   * title_ja 是拿去搜 bgm 和做去重锚点的，用日文原题更准。
   */
  const cands = (aliases.get(r.id) ?? []).filter((a) => a !== r.title_cn);
  const next = pickTitleJa(cands, r.title);
  if (!next || next === r.title_ja) continue;
  /**
   * 只覆盖「空的」或「灌了中文的」title_ja。
   *
   * pickTitleJa 放宽了候选筛选（原来 latinRatio>0.4 一律不要，把
   * 「BORUTO-ボルト- NARUTO NEXT GENERATIONS」这类拉丁+假名混排的日文原题
   * 也筛掉了），放宽后全库有 1,500 条 title_ja 会变。可 title_ja 是去重的锚，
   * 实测那 1,500 条会连带多折叠 48 条，其中「光」(2025) 被折进「光」(2020)、
   * 系列第一季被折进第二季这类明显是错的。
   * 真正坏掉的只有 82 条（title_ja 是中文）—— 只修这些，锚不乱动。
   */
  // 混了泰文 / 韩文的也算坏掉（#16：东京复仇者、南家三姐妹、中二病剧场版…）
  if (r.title_ja && !looksChinese(r.title_ja) && !hasForeignScript(r.title_ja)) continue;
  changed++;
  if (samples.length < 10) samples.push(`  ${String(r.id).padStart(6)}  ${r.title_ja ?? '(空)'}  →  ${next}`);
  if (!dry) upd.run(next, r.id);
}
console.log(`重算 title_ja：${changed} 条${dry ? '（--dry，不写库）' : ' 已更新'}`);
for (const s of samples) console.log(s);
