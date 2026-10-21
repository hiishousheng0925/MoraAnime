/**
 * 片源搜索结果打分：哪一条是「这部番、这一季」。
 *
 * 各站按关键词返回的是一串近似结果 —— 搜「药屋少女的呢喃 第三季」，AGE / baimao 会把第二季也一起给出来，
 * 长得一模一样地并排。观看页要自动选中一条，所以得能分出季数：
 *   同名（去掉季数后）+ 同季 → 最高；包含关系（「剧场版 xxx」「xxx 特别篇」）次之；季数不同 → 负分，不自动选。
 */
import { normName } from '../bangumiMatch.js';
import { seasonOrd, partOrd } from '../text.js';
import { toSimplified } from '../hant.js';

// 「部分」要排在「部」前面：原来「第2部分」只摘掉「第2部」，剩一个「分」字参与比名字
const SEASON_MARK = /第\s*(?:[0-9]+|[一二三四五六七八九十]+)\s*(?:季|期|部分|部|章)|season\s*\d+|\d+(?:st|nd|rd|th)\s*season|part\.?\s*\d+|[前后]半(?:部分)?/gi;
/** 汉字后面紧跟的罗马数字也是季数：「无职转生Ⅱ ～到了异世界就拿出真本事～」（AGE / akianime 的写法） */
const CJK_ROMAN = /([\p{Script=Han}])(Ⅱ|Ⅲ|Ⅳ|Ⅴ|II|III|IV)(?=[\s～~:：·-]|$)/u;
/** 中日文名结尾的季数：「转生成为魔剑了 2」「転生したら剣でしたII」（seasonOrd 只认拉丁单词后的数字） */
const CJK_TAIL = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー])\s*(?:([2-9])|(II|III|IV|V|Ⅱ|Ⅲ|Ⅳ|Ⅴ))$/u;
const ROMAN = { II: 2, III: 3, IV: 4, V: 5, 'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5 };

export function seasonOf(s) {
  const n = seasonOrd(s, { trailingNum: true });
  if (n !== 1) return n;
  const t = String(s ?? '').trim();
  const m = t.match(CJK_TAIL);
  if (m) return m[2] ? +m[2] : ROMAN[m[3]];
  const r = t.match(CJK_ROMAN);
  return r ? ROMAN[r[2]] : 1;
}

/** 分部号：「第2部分」「后半」「Part.2」（partOrd 不认「Part.2」中间的点）；没写 = 0 */
export function partOf(s) {
  const t = String(s ?? '');
  return partOrd(t) || +(t.match(/part\.?\s*([1-9])/i)?.[1] ?? 0) || (/后半/.test(t) ? 2 : /前半/.test(t) ? 1 : 0);
}

/** 去掉季数后的名字（原样，给片源站当搜索词用）：「转生就是剑 第二季」→「转生就是剑」 */
export const stripSeason = (s) => String(s ?? '').replace(SEASON_MARK, ' ').replace(CJK_ROMAN, '$1').replace(CJK_TAIL, '$1')
  .replace(/\s+/g, ' ').trim();

const base = (s) => normName(stripSeason(s)).replace(/[\s\p{P}\p{S}]/gu, '');

/**
 * 包含关系要「短的那个本身够长、且占长的一半以上」才算（#92）：太空小五义的别名「小英雄」包在
 * 「猪猪侠大电影之竞速小英雄」里，原来照样拿 70 分被自动开播；「进击的巨人」包在
 * 「进击的巨人最终季完结篇前篇」里也拿过 70 分。「剧场版 xxx」「xxx ～●●的魔法～」这类仍然算
 */
const MIN_NESTED = 4;
function nested(x, y) {
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return [...short].length >= MIN_NESTED && short.length * 2 >= long.length;
}

/**
 * @param {string} name 片源站给的名字
 * @param {string[]} wants 这部番的各个名字，第一个是主标题（中文名）
 * 季数一律以主标题为准，别名只比名字：Bangumi 给 Fate/stay night [UBW] 第二季 记的别名里有不带季数的
 * 「命运之夜 无限剑制」，按别名自己的季数算，第一季那条就和它同名同季拿了满分
 */
export function scoreHit(name, wants) {
  const b = base(name);
  if (!b || !wants.length) return 0;
  const target = seasonOf(wants[0]), mine = seasonOf(name);
  // 分部：两边都写了且不同 → 不自动选；这一页是后半、对方没写分部 → 小扣（很多站把上下半合成一条「第二季」）；
  // 这一页没写分部、对方写着第 2 部分 → 不自动选（无职转生 第二季 页面曾给「第二季 第2部分」打出 70 分）
  const tp = partOf(wants[0]), hp = partOf(name);
  const partPen = tp && hp ? (tp === hp ? 0 : -50) : tp > 1 ? -15 : hp > 1 ? -50 : 0;
  let best = 0;
  for (const w of wants) {
    const wb = base(w);
    if (!wb) continue;
    const same = b === wb;
    if (!same && !((b.includes(wb) || wb.includes(b)) && nested(b, wb))) continue;
    const s = (same ? 60 : 30) + (mine === target ? 40 : -50) + partPen
      + (normName(name) === normName(w) ? 5 : 0);
    best = Math.max(best, s);
  }
  return best;
}

/**
 * 观看页自动搜索用的关键词（最多 3 个）。
 *
 * 片源站的搜索基本是字面匹配，各站给同一部番起的名字又五花八门 ——「转生就是剑 第二季」：
 * 7sefun 叫「转生就是剑第二季」（没空格）、akianime / DM84 / ezdmw 叫「转生成为魔剑了 第二季」，
 * 只拿原名搜，10 个站里只有 baimao 一个能搜到（2026-10-18 主人对比 Kazumi 发现）。
 * 所以再加两个「去掉季数」的词：各季会一起搜出来，由 scoreHit 挑出这一季。
 *   ① 原名  ② 原名去掉季数  ③ 中文别名里去掉季数后出现最多的那个（和②不同才加）
 */
export function searchKeywords(q, wants) {
  const out = [q.trim()];
  const add = (k) => { if (k && !out.some((x) => base(x) === base(k) && x.replace(/\s/g, '') === k.replace(/\s/g, ''))) out.push(k); };
  add(stripSeason(q));
  const cn = wants.filter((w) => /\p{Script=Han}/u.test(w) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(w));
  const freq = new Map();
  // 繁体别名先转简体：「轉生就是劍」和原名是同一个词，片源站也都用简体
  for (const w of cn) { const k = stripSeason(toSimplified(w)); if (k && base(k) !== base(q)) freq.set(k, (freq.get(k) ?? 0) + 1); }
  // 别名太短不拿来搜：「小英雄」搜出来全是别的番（#92）
  const top = [...freq].filter(([k]) => [...base(k)].length >= MIN_NESTED)
    .sort((x, y) => y[1] - x[1] || y[0].length - x[0].length)[0]?.[0];
  // 没有中文名、原名带假名的（CLANNAD ~After Story~ クラナド…）：中文站搜不到日文，换罗马字 / 英文名（#95）
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(q)) {
    const latin = wants.find((w) => /^[\p{Script=Latin}\d\s\p{P}\p{S}]+$/u.test(w) && /[a-z]/i.test(w));
    if (latin) out.splice(1, 0, latin.normalize('NFKC'));
  }
  add(top);
  return out.slice(0, 3);
}
