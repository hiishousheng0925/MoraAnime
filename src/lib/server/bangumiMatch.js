/**
 * AOD 条目 → Bangumi 条目 的匹配（#2，根治 #12 续作挂前作）。纯函数，输入索引和一行，输出结果。
 *
 * 原来的匹配是拿 AOD 标题去 bgm 搜索 API 模糊比相似度，Bangumi 一个条目常被匹给系列里好几季
 * （实测 2,750 组 / 6,732 条共用 bgm_id），续作显示前作的评分简介。现在有了 Archive 全量：
 *   候选 = 名字 / 别名精确命中 ∪ 现有 bgm_id ∪ 现有 bgm_id 沿「前传 / 续集」关系能走到的整条主线
 *   硬条件 = 类型兼容 + 年份 ±1
 *   打分 = 季数 / 分部号是否一致（权重最大）+ 名字精确 + 年份精确 + 集数 + 类型精确
 *   只有最高分过门槛、且明显领先第二名才算匹配上；拿不准就不匹配（宁缺勿错）
 */
import { seasonOrd, partOrd } from './text.js';
import { TYPE_PLATFORMS } from './bangumiArchive.js';

/** 名字归一：全角半角统一、小写、去掉空白和标点 */
export const normName = (s) => String(s ?? '').normalize('NFKC').toLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, '');

/**
 * 季数 / 分部号。Bangumi 的写法要先整理一下再交给 seasonOrd / partOrd：
 *   「Part.2」→「Part 2」；「后半部分 / 後半 / 下半」→ 第 2 部分（Re：从零开始 第二季 后半部分）
 *   分部号 0 和 1 视为相同（AOD 的前半段通常不写 Part 1）
 */
export function ordOf(s, { trailingNum = false } = {}) {
  // NFKC：Bangumi 原名常用全角罗马数字（魔王学院の不適合者 Ⅱ）→ II，seasonOrd 才认得
  const t = String(s ?? '').normalize('NFKC').replace(/part\s*\.\s*/gi, 'Part ')
    .replace(/(?:后半|後半|下半)(?:部分|クール)?/g, ' 第2部分 ').replace(/(?:前半|上半)(?:部分|クール)?/g, ' 第1部分 ');
  let season = seasonOrd(t, { trailingNum });
  // 紧跟在汉字 / 假名 / 句读后面的单个 2–9：「因为太怕痛就全点防御力了。2」「ゆるキャン△2」
  const m = season === 1 && t.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}。！？!?△☆♪)）」』]\s*([2-9])$/u);
  if (m) season = +m[1];
  // 「钻石王牌 act2」「ダイヤのA actII」：act 后面紧跟的数字是季数
  const a = season === 1 && t.match(/\bact\s*(\d|i{1,3}|iv|v)\b/i);
  if (a) season = /\d/.test(a[1]) ? +a[1] : { i: 1, ii: 2, iii: 3, iv: 4, v: 5 }[a[1].toLowerCase()];
  return { season, part: Math.max(1, partOrd(t)) };
}

/**
 * 建索引。subjects：Map<id, parsed subject>（见 bangumiArchive.parseSubject）；
 * relations：[{a, b, type}]，只用 2 前传 / 3 续集 两种连成「主线」。
 */
export function buildIndex(subjects, relations) {
  const byName = new Map();
  const add = (k, id) => { if (k.length < 2) return; (byName.get(k) ?? byName.set(k, new Set()).get(k)).add(id); };
  const ord = new Map();
  for (const s of subjects.values()) {
    for (const n of [s.name, s.name_cn, ...(s.aliases ?? [])]) if (n) add(normName(n), s.id);
    const o = ordOf(s.name_cn || s.name);
    const oj = ordOf(s.name);
    // 中文名和原名谁写了季数信它谁（有的 name_cn 省掉「第二季」，原名写着「2期」）
    ord.set(s.id, { season: Math.max(o.season, oj.season), part: Math.max(o.part, oj.part) });
  }
  const line = new Map();
  for (const r of relations) {
    if (r.type !== 2 && r.type !== 3) continue;
    if (!subjects.has(r.a) || !subjects.has(r.b)) continue;
    (line.get(r.a) ?? line.set(r.a, new Set()).get(r.a)).add(r.b);
    (line.get(r.b) ?? line.set(r.b, new Set()).get(r.b)).add(r.a);
  }
  return { subjects, byName, ord, line };
}

/** 从一个条目沿主线能走到的全部条目（含自己），最多 maxDepth 层 */
function lineOf(idx, id, maxDepth = 12) {
  const seen = new Set([id]);
  let frontier = [id];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const x of frontier) for (const y of idx.line.get(x) ?? []) if (!seen.has(y)) { seen.add(y); next.push(y); }
    frontier = next;
  }
  return seen;
}

const THRESHOLD = 4;
const MARGIN = 1;

/**
 * 类型分三档（2026-10-18 在正式库副本上逐类看过「原来有 bgm_id、现在没匹配上」的 2,341 条后定的）：
 *   对口   +2   TV↔TV、剧场版↔剧场版…
 *   兼容    0   TYPE_PLATFORMS 里列的（特别篇两边都很杂）
 *   跨档   −2   短片在 OVA / 剧场版 / WEB 之间两边各记各的（觉醒的方舟 OVA ↔ 剧场版、+模型姐妹 ONA ↔ OVA），
 *              只有主标题精确一致才允许；TV ↔ 剧场版另要集数一致（FLCL Progressive 6 集）
 */
const CANON = { TV: [1], MOVIE: [3], OVA: [2], ONA: [5, 2006], SPECIAL: [0, 2] };
const CROSS = { TV: [2, 3], MOVIE: [2, 5, 0], OVA: [3, 5], ONA: [2, 3], SPECIAL: [3], UNKNOWN: [] };

/**
 * row：{ title, title_ja, title_cn, type, year, episodes, bgm_id, aliases: string[] }
 * 返回 { id, score, rule, second } 或 { id: null, ... }
 */
export function matchRow(idx, row) {
  // 主标题精确命中比别名命中可信：AOD 的别名里常混着系列总称（「Owari no Seraph」挂在 OAD 条目上）
  const exactMain = new Set(), exact = new Set();
  for (const n of [row.title_ja, row.title].filter(Boolean).map(normName))
    for (const id of idx.byName.get(n) ?? []) { exactMain.add(id); exact.add(id); }
  for (const n of (row.aliases ?? []).filter(Boolean).map(normName))
    for (const id of idx.byName.get(n) ?? []) exact.add(id);
  // 中文名只当候选来源，不算「名字精确」—— 它本身可能就是从错配的那一季抄来的
  const cnHits = row.title_cn ? idx.byName.get(normName(row.title_cn)) ?? new Set() : new Set();
  const cands = new Set([...exact, ...cnHits]);
  if (row.bgm_id && idx.subjects.has(row.bgm_id)) for (const id of lineOf(idx, row.bgm_id)) cands.add(id);
  for (const id of [...exact]) for (const x of lineOf(idx, id, 3)) cands.add(x);

  const tv = row.type === 'TV';
  const want = ordOf(row.title, { trailingNum: tv });
  const okPlat = TYPE_PLATFORMS[row.type] ?? TYPE_PLATFORMS.UNKNOWN;
  const scored = [];
  const serial = row.type === 'TV' || row.type === 'ONA';   // 剧场版 / OVA 的编号多半是「第 N 部」，不是季数
  for (const id of cands) {
    const s = idx.subjects.get(id);
    if (!s) continue;
    const canon = (CANON[row.type] ?? []).includes(s.platform);
    const eqEps = row.episodes > 0 && s.eps > 0 && row.episodes === s.eps;
    // 集数差 4 倍以上一律不配：那是另一部作品（租借女友 × halca 联动短片 1 集 ↔ 正片 12 集），
    // 和 enrich-bgm 的 epsClash / fix-bgm-clash 同一个判据
    // 例外：（主标题精确 或 就是原来的 bgm_id）+ 类型对口 + 同年 —— 那是两边数集的口径不同，不是另一部作品
    // （齐木楠雄的灾难 AOD 按 5 分钟一段数成 120 集、bgm 按播出档 24 集；未播新番 AOD 先写 1 集占位）
    const sameWork = (exactMain.has(id) || id === row.bgm_id) && canon && row.year && s.year === row.year;
    if (!sameWork && row.episodes > 0 && s.eps > 0 && Math.max(row.episodes, s.eps) >= 4 * Math.min(row.episodes, s.eps)) continue;
    let typeScore;
    if (canon) typeScore = 2;
    else if (okPlat.includes(s.platform)) typeScore = 0;
    else if ((CROSS[row.type] ?? []).includes(s.platform) && exactMain.has(id)
             && !(row.type === 'TV' && s.platform === 3 && !(eqEps && row.episodes > 1))) typeScore = -2;
    else continue;
    // 年份 ±1；主标题精确 + 类型对口 + 集数一致（或都是单集）时放宽到 ±3 —— 老 OVA 的发行年两边常记得不一样
    const loose = exactMain.has(id) && canon && (eqEps || (row.episodes <= 1 && (s.eps ?? 1) <= 1));
    if (row.year && s.year && Math.abs(s.year - row.year) > (loose ? 3 : 1)) continue;
    const o = idx.ord.get(id);
    let score = typeScore;
    const why = canon ? ['型'] : [];
    if (exactMain.has(id)) { score += 4; why.push('名'); }
    else if (exact.has(id)) { score += 2; why.push('别'); }
    /**
     * 季数：两边都写明了且不同 → 重罚（这正是「续作挂前作」）；
     * AOD 写明第 N 季、Bangumi 没写 → 也重罚（胆大党 第二季 → 胆大党）；
     * AOD 没写、Bangumi 写了 → 轻罚（Aria the Natural 就是第二季，标题里不写）。
     * 剧场版 / OVA 只轻罚（空之境界 Movie 5 ↔ 第五章）。
     */
    if (o.season === want.season) { score += 3; why.push('季'); }
    else if (!serial) score -= 2;
    else if (want.season > 1) score -= 6;
    else score -= 3;
    if (o.part === want.part) score += 1; else score -= serial ? 4 : 2;
    if (row.year && s.year === row.year) { score += 2; why.push('年'); }
    if (row.episodes > 0 && s.eps > 0) {
      if (eqEps) { score += 1; why.push('集'); }
      else if (Math.max(row.episodes, s.eps) / Math.min(row.episodes, s.eps) > 1.5) score -= 2;
    }
    // 特别篇被匹到 TV 正片是最常见的错配方向（终结的炽天使 OAD → TV）
    if (row.type === 'SPECIAL' && s.platform === 1) score -= 2;
    // 名字、年份、集数一样都对不上，只剩「原来就挂着它」—— 那正是要纠正的旧错配
    // （AOD 没年份的《Vampire》1968 一直挂着 2024 年的「吸血鬼幸存者」）
    if (!exact.has(id) && !(row.year && s.year === row.year) && !eqEps) score -= 4;
    if (id === row.bgm_id) { score += 0.5; why.push('原'); }
    scored.push({ id, score, why: why.join('') });
  }
  scored.sort((a, b) => b.score - a.score || (b.id === row.bgm_id) - (a.id === row.bgm_id));
  const [best, second] = scored;
  const miss = (rule) => ({ id: null, score: best?.score ?? null, rule, second: second?.id ?? null, best: best?.id ?? null });
  if (!best || best.score < THRESHOLD) return miss(best ? '分低' : '无候选');
  // 拉不开差距时：原来的 bgm_id 本身过线、且没人比它分高 → 留着它（同分的另一个候选不足以推翻旧匹配）
  if (second && best.score - second.score < MARGIN && best.id !== row.bgm_id) return miss('拿不准');
  return { id: best.id, score: best.score, rule: best.why, second: second?.id ?? null };
}
