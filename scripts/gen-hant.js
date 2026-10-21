/**
 * 重新生成 src/lib/server/hant.js 的繁→简字表。
 *
 * 平时不用跑 —— 字表烤进源码是为了让运行时依赖保持为零。
 * 只有上游字表更新、或者发现漏字时才需要重跑：
 *   node scripts/gen-hant.js
 *
 * 数据来自 OpenCC 的 TSCharacters.txt（Apache-2.0，github.com/BYVoid/OpenCC）。
 */
import { writeFileSync } from 'node:fs';

const URL_TS = 'https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TSCharacters.txt';
const OUT = 'src/lib/server/hant.js';

const res = await fetch(URL_TS);
if (!res.ok) { console.error(`❌ 取字表失败 HTTP ${res.status}`); process.exit(1); }
const txt = await res.text();

const pairs = [];
let sameShape = 0, astral = 0, multi = 0;
for (const line of txt.split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const [k, rest] = line.split('\t');
  if (!k || !rest) continue;
  const vs = rest.trim().split(/\s+/);
  const v = vs[0];
  if (vs.length > 1) multi++;
  if ([...k].length !== 1 || [...v].length !== 1) continue;
  if (k === v) { sameShape++; continue; }
  /**
   * 超出 BMP 的字要剔掉：它们在 JS 里是代理对，占两个 UTF-16 码元，
   * 而下面把字表存成两个等长字符串、按下标配对 —— 混进代理对就会整体错位。
   * 实测错位后「劇場版」被转成「克圆版」。这些都是 CJK 扩展 B 区以上的生僻字，
   * 番名里不会出现。
   */
  if (k.codePointAt(0) > 0xffff || v.codePointAt(0) > 0xffff) { astral++; continue; }
  pairs.push([k, v]);
}

const HANT = pairs.map(([k]) => k).join('');
const HANS = pairs.map(([, v]) => v).join('');
if (HANT.length !== HANS.length || HANT.length !== pairs.length) {
  console.error('❌ 两个字串长度对不上，生成中止'); process.exit(1);
}

const body = `/**
 * 繁体 → 简体 单字映射，把搜索索引和查询串归一到同一种字形。
 *
 * 为什么需要：上游别名表里简繁混杂 —— AOD 同一部番同时收了
 * 「DARKER THAN BLACK -黑之契約者-」(繁) 和「-黑之契约者-」(简)，
 * Bangumi 给的 name_cn 是简体，而主人两种都可能打。不归一的话
 * 搜「劇場版」搜不到只存了「剧场版」的条目，反之也一样。
 *
 * 字表来自 OpenCC 的 TSCharacters.txt（Apache-2.0，github.com/BYVoid/OpenCC），
 * 一次性烤成下面两个等长字符串 —— 本项目运行时依赖是零，不为这个装包。
 * 重新生成：node scripts/gen-hant.js
 *
 * 已剔掉：简繁同形的字、超出 BMP 的生僻字（JS 里是代理对会让下标错位 ——
 * 实测错位后「劇場版」被转成「克圆版」）。多候选取第一个，OpenCC 默认行为。
 *
 * ⚠️ 日文汉字会被一起归一（劇場版 → 剧场版、機動 → 机动）。这是有意的：
 * 索引和查询走同一个函数，两边都归一，匹配照样成立，而且日文原题和中文译名
 * 之间还能互相搜到。代价是极少数字形不同的词被合并 —— 对搜索召回是好事。
 */
const HANT = ${JSON.stringify(HANT)};
const HANS = ${JSON.stringify(HANS)};

const MAP = new Map();
for (let i = 0; i < HANT.length; i++) MAP.set(HANT[i], HANS[i]);

/** 逐字转简体。非繁体字原样返回，所以对假名、拉丁字母是空操作 */
export function toSimplified(s) {
  if (!s) return '';
  let out = '';
  for (const ch of String(s)) out += MAP.get(ch) ?? ch;
  return out;
}
`;
writeFileSync(OUT, body);
console.log(`✔ ${OUT}  ${pairs.length} 对映射`);
console.log(`  跳过：简繁同形 ${sameShape} · 超出 BMP ${astral} · （多候选取首个 ${multi} 条）`);
for (const s of ['劇場版 鬼滅の刃', '進擊的巨人', '咒術迴戰']) {
  const { toSimplified } = await import(`../${OUT}?t=${Date.now()}`);
  console.log(`  自检 ${s} → ${toSimplified(s)}`); break;
}
