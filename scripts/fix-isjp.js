/**
 * 回填 is_jp —— 两步：先把误判成非日本的加回来，再把国创减掉。
 *
 * ① 加回来。旧判据只看别名里有没有假名，于是化物語 / 暗殺教室 / 亜人 / ACCA / 風夏
 *    这类纯汉字标题的日本番被判成非日本作品。而目录页默认 jpOnly、快速标记出题池
 *    也要求 is_jp=1 —— 判错就等于这部番在站里搜不到、也永远不会出现在快速标记里。
 *    判据是 AOD 的产地标签 'japanese production'（和 ingest-aod.js 保持一致）。
 *
 * ② 减掉国创（主人 2026-09-09 拍板）。带 'chinese production' 且【没有】
 *    'japanese production' 的 112 部全是国创 —— 逐条核过，一部误判都没有：
 *    快把我哥带走2、银之守墓人、崩坏3 女武神的餐桌、凹凸世界、大鱼·海棠、镖人、
 *    穿书自救指南、罗小黑战记、哪吒闹海、铁扇公主。
 *
 *    ⚠️ 这一步和这个文件以前的注释（「只加不减，反向排除会误伤灵剑山」）相反 ——
 *    那个顾虑是对的但不成立：中日合拍片 AOD 会同时打两个产地标签（时光代理人 英都篇
 *    那 4 部），`NOT japanese production` 已经把它们留住了。灵契 / 银之守墓人 /
 *    从前有座灵剑山 / 斗神姬 / 狐妖小红娘日语版 那一类是绘梦-Emon 的片子：
 *    中国 IP、中国出资、东京工作室制作、日本声优、日本电视台播 —— 按出资算国创，
 *    主人拍板归国创。韩国那边不受影响：is_jp=1 里 'korean production' 一条都没有，
 *    神之塔照旧是 is_jp=1。
 *
 *    代价说清楚：罗小黑战记（#556 / #723）、哪吒闹海（#442）、大鱼·海棠、
 *    三国演义、铁扇公主 会一起从目录 / 排行榜 / 季度浏览消失。主人知道并接受。
 *
 * ③ 没有产地标签的日本番（2026-10-18 体检 DQ6，约 410 部）。只认标签就漏掉了
 *    伤物语 I–III、Fate HF 剧场版、Free! 剧场版、亜人 三部曲、銀魂 新訳紅桜篇…
 *    —— 纯汉字/纯英文标题、又没有 'japanese production' 标签。补三条判据，
 *    任一命中且【没有任何非日本产地标签】才加回：
 *      a. 新字体：title_ja 含日本独有的新字体（鉄 桜 亜 剣 戦…，简繁中文都不这么写），
 *         且 title_ja 有假名、或制作公司是「日本番为主」的公司；title_ja 带简体专用字的不算。
 *         只看字形会误伤国创：AOD 给国创的 title_ja 常是日文译名（剣王朝、山海経 霊獣図鑑）
 *      b. 制作公司：有 title_ja，且某个制作公司带产地标签的作品 ≥10 部、≥95% 是日本产地。
 *         没有 title_ja 的不认 —— 否则 Rick and Morty 武士篇、Robotech 这类美国片会跟着
 *         日本代工厂进来
 *      c. 同系列：同一 franchise 里另有 ≥2 部带 'japanese production'，且没有任何一部带非日本产地
 *    三条都先排除两种国创痕迹：title_ja 带简体专用字且没有新字体字（简体字表会误伤
 *    「死滅回游」的「游」，有新字体就说明是日文），或罗马字里有汉语拼音音节
 *    （zhuan / xian / qing / chuan…，日文罗马字不会这么拼）—— 否则合味道 × Re:0、仙剑奇侠传、
 *    明日方舟一周年 PV 这类联名会跟着日本制作公司 / 同系列进来。
 *    b、c 都按【产地标签】算，不按 is_jp 算：按 is_jp 算的话今天补回的明天又抬高公司占比、
 *    再带进一批（实测第二遍又多出原神、阴阳师），每日同步会一路蔓延。按标签算一遍就收敛。
 *
 * ④ 反向：有韩国 / 朝鲜 / 美国 / 台湾产地标签、且没有任何日本标签（含「xx-japanese
 *    co-production」）的置 0。体检时 39 部韩国番（啵乐乐、Pucca、冬季恋歌…）是 is_jp=1。
 *    神之塔是 korean-japanese co-production，不受影响。
 *    已知漏网：Tom to Jerry（2021）一个产地标签都没有，只有假名别名，这里判不出来。
 *
 * 几步不会互相打架：② ④ 置 0 的都带非日本产地标签，① ③ 都要求没有这类标签（① 要求日本标签）。
 * 幂等，可以反复跑。用法：node scripts/fix-isjp.js [--dry]
 */
import { getDb } from '../src/lib/server/db.js';
import { SIMPLIFIED } from '../src/lib/server/simplified.js';

const dry = process.argv.includes('--dry');
const db = getDb();

const hasTag = (tag) => `EXISTS (
  SELECT 1 FROM anime_tag t WHERE t.anime_id = anime.id AND t.tag = '${tag}')`;

const ADD = `is_jp = 0 AND ${hasTag('japanese production')}`;
const SUB = `is_jp = 1 AND ${hasTag('chinese production')} AND NOT ${hasTag('japanese production')}`;

for (const [label, where, val] of [['补回日本番', ADD, 1], ['剔除国创', SUB, 0]]) {
  const n = db.prepare(`SELECT count(*) c FROM anime WHERE ${where}`).get().c;
  const sample = db.prepare(`SELECT id, title, title_cn, year FROM anime WHERE ${where} AND is_stub = 0
    ORDER BY source_count DESC, year DESC LIMIT 6`).all();
  console.log(`${label}：待修正 ${n} 条${dry ? '（--dry，不写库）' : ''}`);
  for (const r of sample) console.log(`  ${String(r.id).padStart(6)}  ${(r.title_cn || r.title).slice(0, 34)} (${r.year})`);
  if (!dry && n) {
    db.prepare(`UPDATE anime SET is_jp = ${val} WHERE ${where}`).run();
    console.log(`  ✔ 已修正 ${n} 条，剩余 ${db.prepare(`SELECT count(*) c FROM anime WHERE ${where}`).get().c} 条`);
  }
}

/** 日本独有的新字体：中文简体、繁体都不用这些字形（寝 斗 学 这类简体也写的不在内） */
const SHINJITAI = new RegExp('[亜悪圧囲栄駅円塩応桜穏価絵拡覚楽巻歓観関気帰偽戯犠拠挙峡狭暁勲恵掲渓経蛍軽継鶏撃倹剣険圏検権県験'
  + '広効鉱済砕剤桟賛残歯児実釈収従渋獣縦粛処奨焼乗剰壌嬢譲醸粋酔髄瀬斉摂専戦銭繊捜挿巣総聡騒蔵臓続帯滝択沢単団弾'
  + '遅昼鋳庁徴聴逓鉄転伝稲闘読縄弐悩脳覇拝廃売発髪抜払仏歩豊毎満黙訳薬揺謡頼覧竜両猟緑涙塁霊齢暦歴恋労]');
const KANA = /[\u3040-\u30ff]/;
/**
 * 只有汉语拼音才有的音节（日文罗马字没有 zh / x / q，也没有 chuan / cheng 这类）。
 * 拼音常把一个词的几个音节连写（Xingzhe、Xilie），所以只要求词首是这些音节、后面接字母也算；
 * Quest / Queen 这类英文词按 que 开头会被误认，单独放过。
 */
const PINYIN = /\b(?!que(?:st|en)|quiz)(?:zh[aeiou]|x(?:i|u[aen])|q(?:i|u[aen])|ch(?:uan|uang|ui|un|uo|ong|eng|en)\b)[a-z]*/i;
const looksChinese = (tj, title) => (SIMPLIFIED.test(tj) && !SHINJITAI.test(tj)) || PINYIN.test(title);

/** 任何非日本的产地标签（合拍片的 co-production 不算） */
const FOREIGN = `EXISTS (SELECT 1 FROM anime_tag t WHERE t.anime_id = a.id AND t.tag LIKE '% production'
  AND t.tag NOT LIKE '%co-production' AND t.tag NOT IN ('japanese production', 'ai used in production', 'animation production'))`;
const JP_TAG = `EXISTS (SELECT 1 FROM anime_tag t WHERE t.anime_id = b.id AND t.tag = 'japanese production')`;
const ANY_TAG = `EXISTS (SELECT 1 FROM anime_tag t WHERE t.anime_id = b.id AND t.tag LIKE '% production'
  AND t.tag NOT LIKE '%co-production' AND t.tag NOT IN ('ai used in production', 'animation production'))`;
/** 「日本番为主」的制作公司：带产地标签的作品 ≥10 部、≥95% 是日本产地 */
const jpStudio = new Set(db.prepare(`SELECT s.studio_norm FROM anime_studio s JOIN anime b ON b.id = s.anime_id
  WHERE s.role = 'studio' AND b.is_stub = 0 AND ${ANY_TAG}
  GROUP BY s.studio_norm HAVING count(*) >= 10 AND avg(${JP_TAG}) >= 0.95`).all().map((r) => r.studio_norm));
const studiosOf = db.prepare(`SELECT studio_norm FROM anime_studio WHERE anime_id = ? AND role = 'studio'`);
const franchiseJp = db.prepare(`SELECT sum(${JP_TAG}) jp, sum(${ANY_TAG} AND NOT ${JP_TAG}) foreign_n FROM franchise_member m
  JOIN franchise_member m2 ON m2.franchise_id = m.franchise_id AND m2.anime_id <> m.anime_id
  JOIN anime b ON b.id = m2.anime_id WHERE m.anime_id = ?`);

const why = new Map();
for (const a of db.prepare(`SELECT a.id, a.title, a.title_ja FROM anime a WHERE a.is_jp = 0 AND NOT ${FOREIGN}`).all()) {
  const tj = a.title_ja ?? '';
  if (looksChinese(tj, a.title ?? '')) continue;
  const byStudio = !!tj && studiosOf.all(a.id).some((s) => jpStudio.has(s.studio_norm));
  const shin = SHINJITAI.test(tj) && (KANA.test(tj) || byStudio);
  const fr = franchiseJp.get(a.id);
  const byFranchise = (fr.jp ?? 0) >= 2 && !fr.foreign_n;
  if (shin || byStudio || byFranchise)
    why.set(a.id, [shin && '新字体', byStudio && '制作公司', byFranchise && '同系列'].filter(Boolean).join('+'));
}
const SUB2 = `a.is_jp = 1 AND EXISTS (SELECT 1 FROM anime_tag t WHERE t.anime_id = a.id AND t.tag IN
    ('south korean production', 'north korean production', 'american production', 'taiwanese production'))
  AND NOT EXISTS (SELECT 1 FROM anime_tag t WHERE t.anime_id = a.id
    AND (t.tag = 'japanese production' OR t.tag LIKE '%japanese co-production'))`;
const sub2 = db.prepare(`SELECT a.id FROM anime a WHERE ${SUB2}`).all().map((r) => r.id);

const show = (ids, note) => {
  const q = db.prepare('SELECT id, title, title_cn, year, type FROM anime WHERE id = ?');
  const rows = ids.map((id) => q.get(id)).filter(Boolean);
  for (const r of rows.slice(0, 8))
    console.log(`  ${String(r.id).padStart(6)}  ${(r.title_cn || r.title).slice(0, 34)} (${r.type} ${r.year})${note ? ` [${note(r.id)}]` : ''}`);
};
console.log(`补回无标签的日本番：待修正 ${why.size} 条${dry ? '（--dry，不写库）' : ''}`);
for (const k of ['新字体', '制作公司', '同系列'])
  console.log(`  其中含「${k}」判据 ${[...why.values()].filter((v) => v.includes(k)).length} 条`);
show([...why.keys()], (id) => why.get(id));
console.log(`剔除韩国/美国/台湾产地：待修正 ${sub2.length} 条${dry ? '（--dry，不写库）' : ''}`);
show(sub2);
if (!dry) {
  const set = db.prepare('UPDATE anime SET is_jp = ? WHERE id = ?');
  db.exec('BEGIN');
  for (const id of why.keys()) set.run(1, id);
  for (const id of sub2) set.run(0, id);
  db.exec('COMMIT');
  console.log(`  ✔ 已修正 ${why.size} + ${sub2.length} 条`);
  console.log(`  日本作品总数 ${db.prepare('SELECT count(*) c FROM anime WHERE is_jp=1').get().c}`);
}
