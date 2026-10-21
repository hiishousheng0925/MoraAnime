/**
 * 生成 src/lib/server/simplified.js —— 「简体专用字」字表。
 *
 * 这张表回答一个问题：「这串字是简体中文，还是日文汉字？」
 * 用途有三处：判断现有 title_ja 是不是灌了中文（looksChinese）、
 * pickTitleJa 挑候选时给中文降权、从 AOD 别名里挑简体中文名（fix-cn-from-aod）。
 *
 * ⚠️ 原来这张表是【手工维护】的 183 个字，反复漏：
 *   · 早期混进了 国 恋 断 旧 来 机 斗 横 虫 党 黄 这些日文也这么写的字，
 *     后果是把「四国計測工業株式会社 CM」「鋼鉄三国志」判成中文
 *   · 后来又发现漏了 药 际 —— 于是《異世界薬局》的 title_ja 被存成台译
 *     「奇幻世界药局」，拿它去搜 bgm 搜不到正确条目，中文名错成「异世界舅舅」
 * 手工列举 2000+ 个字不可能不漏，所以改成从数据推。
 *
 * 推导方法（三步集合运算）：
 *   ① 日文汉字集 = 出现在【带假名的 AOD 别名】里的汉字。假名是「这是日文」的确证。
 *      ⚠️ 要先剔掉中日混排的脏别名（中文标题里夹片假名），否则 说 电 战 剧 动 场
 *      这些会被误判成「日文也用」。用下面的 SEED（高精度手工种子）来识别并剔除。
 *   ② 简化目标集 = OpenCC 繁→简表里，只在【简体侧】出现、繁体侧没出现过的字
 *      （即简化后才有的新字形）。数据来自 src/lib/server/hant.js。
 *   ③ 简体专用 = ② − ①，再和 SEED 取并集（种子里有 1 个字「黑」推不出来）。
 *
 * 实测判定：药 际 异 说 电 剧 → 简体专用；薬 国 学 体 恋 斗 来 → 日文也用。
 *
 * 需要数据库（要读 anime_alias）。平时不用跑，只有上游别名大量变动时重跑：
 *   node scripts/gen-simplified.js
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { getDb } from '../src/lib/server/db.js';

/**
 * 高精度手工种子。两个作用：
 *   a. 识别并剔除中日混排的脏别名（步骤①）
 *   b. 和推导结果取并集，补上推不出来的（实测只有「黑」一个）
 * 这些字全部人工确认过：日文写作另一个字形（说→説、电→電、剧→劇…）。
 */
const SEED = '们这说长门关电车马龙汉语见战边义亚产从众优传伤冲况净减凤刘创剧劳势动务单卖卫变叶吗员团园围图圆场坏块坚复够头夺奋妆妇婴宁实审宽宾对寻导层岁岛币帅师帐带帮庄庆库应庙废异弃张归录彻忆忧怀态总恶惊惧惨愿报拟挂挤挥换摆摄显晓晕术杀杂权杨极构枪柜标树样桥检楼欢汇泪泽洁浆浑浓涂润涨渐渔渗湾满滤滨灭灵炼烂烛烦烧热营兽鸟马鱼鸡鸭凤军农齐质贝页韦马饥饮饭饰饱饼馆驰驱驶验骄骗鲁鲜鲸鸣鸿麦黑';

const db = getDb();
const HAN = /[一-鿿]/g;
const seedRe = new RegExp(`[${SEED}]`);

// ① 日文汉字集
let kept = 0, dropped = 0;
const jp = new Set();
for (const r of db.prepare(`SELECT alias FROM anime_alias
  WHERE has_kana = 1 AND coalesce(src, '') != 'bgm'`).all()) {
  if (seedRe.test(r.alias)) { dropped++; continue; }   // 中日混排，不可信
  kept++;
  for (const ch of r.alias.match(HAN) ?? []) jp.add(ch);
}

// ② 简化目标集
const hant = readFileSync('src/lib/server/hant.js', 'utf8');
const T = hant.match(/const HANT = "([^"]+)"/)?.[1];
const S = hant.match(/const HANS = "([^"]+)"/)?.[1];
if (!T || !S) { console.error('❌ 读不到 hant.js 的字表'); process.exit(1); }
const trad = new Set([...T]);

// ③ 差集 + 并上种子
const derived = [...new Set([...S])].filter((c) => !trad.has(c) && !jp.has(c));
const all = [...new Set([...derived, ...SEED])].sort();

// 正则字符类里要转义的字符
const esc = (s) => s.replace(/[\\\]^-]/g, (m) => '\\' + m);

writeFileSync('src/lib/server/simplified.js', `/**
 * 简体专用字 —— 日文和繁体里都不会这么写，命中即可断定「这串字是简体中文」。
 *
 * ⚠️ 本文件由 scripts/gen-simplified.js 生成，不要手改。
 * 推导方法和为什么不能手工维护，见那个脚本开头的长注释。
 *
 * 判定抽样：药 际 异 说 电 剧 → 命中（简体专用）
 *           薬 国 学 体 恋 斗 来 → 不命中（日文也用这个字形）
 */
export const SIMPLIFIED = /[${esc(all.join(''))}]/;
`);

console.log(`✔ src/lib/server/simplified.js  ${all.length} 个字`);
console.log(`  带假名别名 ${kept + dropped} 条 → 剔掉混排 ${dropped} 条 → 用 ${kept} 条`);
console.log(`  日文汉字集 ${jp.size} · 简化目标集 ${new Set([...S]).size} · 推导出 ${derived.length}`);
console.log(`  种子 ${new Set([...SEED]).size} 个，其中推导没覆盖到的：`
  + ([...new Set([...SEED])].filter((c) => !derived.includes(c)).join('') || '无'));
