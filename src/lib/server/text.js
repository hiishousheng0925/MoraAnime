/**
 * CJK 逐字切分 —— 让 FTS5 的 unicode61 能匹配中日文子串。
 * unicode61 遇到没有空格的中文会把整个标题当成一个 token，
 * trigram 又要求 >=3 字符（「鬼灭」这种 2 字查询会失效）。
 * 所以入库和查询时都把 CJK 拆成单字，用空格连起来。
 *
 *   「葬送的芙莉莲 Season 2」→「葬 送 的 芙 莉 莲 season 2」
 *   查询「芙莉莲」→「芙 莉 莲」→ 作为 phrase 查询命中
 */
import { toSimplified } from './hant.js';
import { SIMPLIFIED } from './simplified.js';

const CJK = /[㐀-䶿一-鿿぀-ヿ豈-﫿々〆]/;

export function segment(str) {
  if (!str) return '';
  /**
   * 先归一到简体：索引和查询都走这个函数，两边同时归一，
   * 搜「劇場版」就能命中只存了「剧场版」的条目，反之也一样。见 hant.js
   */
  let out = '';
  for (const ch of toSimplified(str)) {
    if (CJK.test(ch)) out += ` ${ch} `;
    else out += ch;
  }
  return out.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 查询串里的一段（用户用空白隔开的一块）→ 一个 FTS5 条件。
 *   含 CJK            → 整段一个 phrase（逐字、保证顺序）
 *   单个拉丁词         → 前缀匹配；但单字符不加通配 ——「k」* 会命中所有 k 开头的词
 *   连接符连起来的拉丁词（K-ON、HUNTER×HUNTER、Re:ゼロ 的拉丁部分）
 *                     → 当一个 phrase；末词 ≥3 字符才留前缀通配
 *   实测「K-ON」原来拆成 "k"* AND "on"*，命中 507 部，轻音 TV 排第 411 名。
 */
function chunkQuery(chunk) {
  const parts = segment(chunk).split(' ').filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((p) => CJK.test(p))) return `"${parts.join(' ')}"`;
  if (parts.length === 1) return parts[0].length > 1 ? `"${parts[0]}"*` : `"${parts[0]}"`;
  return `"${parts.join(' ')}"${parts.at(-1).length >= 3 ? '*' : ''}`;
}

/**
 * 把用户查询串转成 FTS5 查询：按空白切段，段与段之间 AND。
 * 原来整串 CJK 拼成一个连续 phrase，「EVA 序」「魔法少女小圆 叛逆的物语」
 * （库里两段中间还夹着「[新篇]」）这类带空格的写法全搜不到。
 */
export function toFtsQuery(q) {
  const conds = String(q ?? '').split(/\s+/).map(chunkQuery).filter(Boolean);
  return conds.length ? conds.join(' AND ') : null;
}

export const hasKana = (s) => /[぀-ヿ]/.test(s || '');

/**
 * 从别名里挑日文标题（拿去搜 bgm，也是去重的锚）。
 *
 * 三条经验都是实测踩出来的：
 *
 * ① 不能「优先假名」。夫婦以上、恋人未満。整个标题一个假名都没有，唯一的假名
 *    别名是缩写「ふうこい」—— 优先假名就锚成了缩写，搜 bgm 直接搜不到。
 *    改成【所有含 CJK 的候选一起按长度比】。
 * ② 要剔掉「拉丁文占大头」的复合别名：
 *    「Genjitsu Shugi Yuusha no Oukoku Saikenki Dai 2 Bu (現実主義勇者の王国再建記 第2部)」
 *    最长，但拿它去搜 bgm 命中率是 0。这种带括号的复合写法，取括号里的日文部分。
 * ③ 结尾的年份后缀要去掉：「[推しの子] (2024)」搜出来的相似度只有 0.09。
 *
 * 都没有 CJK 时返回 null，调用方退回用罗马字标题去搜（NINJA KAMUI 这类本来就是拉丁标题）。
 */
const stripNoise = (s) => {
  let t = String(s).replace(/[（(]\s*(19|20)\d{2}\s*[)）]\s*$/, '').trim();
  // Latin (日本語) → 只取括号里的日文
  const m = t.match(/[（(]([^（()）]*[぀-鿿][^（()）]*)[)）]\s*$/);
  if (m && !CJK.test(t.slice(0, m.index))) t = m[1].trim();
  return t;
};
/** 拉丁字母占比 —— 超过四成就当成「罗马字为主的复合别名」，不适合当日文标题 */
const latinRatio = (s) => (s.match(/[A-Za-z]/g) ?? []).length / Math.max(1, s.length);

/**
 * 简体专用字（日文里不会出现）。只列最常撞车的一批 —— 用来在「长度相同」时
 * 把简体中文名排在日文原题后面：「怪兽8号 第二季」和「怪獣8号 第2期」一样长，
 * 按字典序会挑到简体那个，而日文原题更适合拿去搜 bgm。
 * 不求全，覆盖不到的情况只是锚成中文名，搜索照样能命中（bgm 的 name_cn 也参与比对）。
 */
// 简体专用字表移到 server/simplified.js（由 scripts/gen-simplified.js 从数据推导）
export { SIMPLIFIED } from './simplified.js';

/**
 * 「这串字看起来是中文而不是日文」—— 没有假名，且含简体专用字。
 * 只拿来判断「现有的 title_ja 是不是坏的、该不该覆盖」，不参与挑选，
 * 所以字表里混进 斗/来/机 这类日文也用的汉字也不会造成实质误伤：
 * 真的日文标题几乎都带假名，先被 hasKana 挡在外面。
 */
export const looksChinese = (s) => !!s && !hasKana(s) && SIMPLIFIED.test(s);

/**
 * 泰文 / 韩文（谚文）/ 西里尔字母。含这些的别名一律不当 title_ja（#16）：
 * hasCjk 只看有没有汉字，泰文名里的「卍」、韩文里夹的汉字都能混过去 ——
 * 实测东京复仇者的 title_ja 成了「โตเกียว卍รีเวนเจอร์ส」，南家三姐妹、中二病剧场版成了韩文。
 */
const FOREIGN_SCRIPT = /[\u0E00-\u0E7F\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\u0400-\u04FF]/;

/** title_ja 混了泰文 / 韩文 / 西里尔 —— 等同于坏掉，fix-title-ja 据此覆盖 */
export const hasForeignScript = (s) => FOREIGN_SCRIPT.test(s || '');

export const pickTitleJa = (syns, title) => {
  /**
   * 排序：先「不含简体专用字」，再长度，最后字典序（字典序保证确定性 ——
   * 否则同一部番的两条记录别名顺序不同会挑出不同的 title_ja，去重的锚就对不上）。
   *
   * ⚠️ 简体这一项必须压在长度前面。曾经是「先长度、简体只做同长度时的抢七」，
   * 于是更长的中文名会赢过更短的日文原题：
   *   《異世界薬局》的候选里「奇幻世界药局」(6 字，台译) 比「異世界薬局」(5 字) 长
   *   → title_ja 被存成台译 → 拿它去搜 bgm 搜不到正确条目
   *   → 中文名错成「异世界舅舅」（匹到了《異世界おじさん》）
   *
   * 这个顺序第一次试的时候退回过 —— 当时字表是手工维护的 183 个字，混进了
   * 斗/来/机 这类日文也用的字，把《愛と勇斗〜はじめてのおつかい〜》误判成中文。
   * 现在字表由 scripts/gen-simplified.js 从数据推导（2,608 个字），
   * 那类误伤没有了，才敢把它提到长度前面。
   */
  const byLen = (a, b) => (SIMPLIFIED.test(a) ? 1 : 0) - (SIMPLIFIED.test(b) ? 1 : 0)
    || b.length - a.length
    || (a < b ? -1 : a > b ? 1 : 0);
  /**
   * ⚠️ 不要在这里用 latinRatio 硬筛。日文标题混拉丁字母太常见了，
   * 一筛就把正确答案筛掉，只剩纯汉字的中文名，于是 title_ja 灌进中文
   * （实测 82 部日本番中招）：
   *   「BORUTO-ボルト- NARUTO NEXT GENERATIONS」(0.62) 被筛掉 → 「火影忍者 博人传之火影次世代」
   *   「DARKER THAN BLACK -黒の契約者-」(0.61) 被筛掉 → 「黑之契约者」
   *   「ドロヘドロ Season 3」(0.53) 被筛掉 → 「异兽魔都」
   * 罗马音/英文标题本来就被 hasCjk 拦住了，不需要 latinRatio 再拦一道；
   * 它真正有用的地方只有下面「没有假名候选」的兜底路径。
   */
  const cands = [...(syns || []), title]
    .filter(Boolean)
    .map(stripNoise)
    .filter(hasCjk)
    .filter((s) => !FOREIGN_SCRIPT.test(s))
    .sort(byLen);
  if (!cands.length) return null;

  /**
   * ④ 带假名的候选优先 —— 但只在它「不比最长的短太多」时。
   *
   * 纯按长度挑会挑到中文名：「【我推的孩子】 第二季」(11) 比日文原题
   * 「【推しの子】 第2期」(10) 长一个字，于是 title_ja 成了中文名，
   * 拿去搜 bgm 相似度只有 0.09。而反过来「优先假名」也不行：
   * 夫婦以上、恋人未満。整个标题没有假名，唯一的假名别名是缩写「ふうこい」。
   * 六成这个阈值把两种情况都分开了（10 ≥ 0.6×11 取假名；4 < 0.6×10 取汉字）。
   */
  const kana = cands.filter(hasKana);
  const best = kana.find((k) => k.length >= cands[0].length * 0.6);
  if (best) return best;
  /**
   * 没有够长的假名候选 → 只能挑汉字标题。这里才排掉拉丁占比过高的（多半是罗马音/英文标题）。
   *
   * ⚠️ 必须先按「有没有简体专用字」分档、再在档内挑，不能直接对 cands 用 find ——
   * 否则拉丁占比这道筛会把罚分 0 的日文候选筛掉、跨档掉进中文那一档：
   *   攻殻機動隊 STAND ALONE COMPLEX  拉丁占比 0.46 被筛 → title_ja = 「攻壳机动队」
   *   劇場版 NARUTO                  拉丁占比 0.46 被筛 → title_ja = 「火影忍者剧场版」
   *   RWBY 氷雪帝国                  拉丁占比 0.44 被筛 → title_ja = 「四色战记 冰雪帝国」
   * 排序里简体压在长度前面，就是要让中文永远输给日文，这道兜底不能把它推翻。
   * 整档都是中文时（.hack//境界线 —— AOD 里根本没有日文标题）才只能挑中文。
   */
  const notCn = cands.filter((s) => !SIMPLIFIED.test(s));
  const pool = notCn.length ? notCn : cands;
  /**
   * ⚠️ 同样不能让这道筛挑到一个【短得离谱】的候选 —— 缩写别名就是这么赢的：
   *   《魔法少女育成計画 restart》拉丁占比 0.44 被筛掉 → title_ja = 「まほいく」
   *   拿 4 个字的缩写去搜 bgm 当然搜不到，这部 9 个站收录的番就一直没有中文名。
   * 和上面「假名候选优先」用同一个 0.6 长度门槛：够长的才有资格参加这一轮，
   * 全都不够长就回到最长的那个（宁可带点拉丁字母，也不要缩写）。
   */
  const long = pool.filter((s) => s.length >= pool[0].length * 0.6);
  return long.find((s) => latinRatio(s) <= 0.4) ?? pool[0];
};

export const hasCjk = (s) => CJK.test(s || '');

/** 归一化标题，用于重复条目分组 */
export const normTitle = (s) =>
  (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').trim();

/**
 * 制作公司名归一。
 * 实测 2,950 个原始名里有 383 组是同一家的不同写法
 * （toei animation / toei animation co., ltd. 被拆成 743 + 393 两条）。
 * 去掉公司后缀与标点后合并，筛选按归一名走。
 */
export function normStudio(s) {
  return String(s || '').toLowerCase()
    // 变音符号去掉：dōga kōbō = doga kobo（#109）
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/\b(co\.?,?\s*ltd\.?|inc\.?|ltd\.?|corp\.?|corporation|k\.?k\.?|company|studios?|llc)\b/g, ' ')
    .replace(/[.,()·・]/g, ' ')
    // 连字符、纯数字词后面的空格不算：8-bit / 8 bit / 8bit 是同一家（#109：统计页原来分成两家）。
    // 只认「整个词都是数字」的：a-1 pictures 里的 1 前面是 a，不能并成 a1pictures
    .replace(/-/g, '')
    .replace(/(^|\s)(\d+)\s+(?=[a-z])/g, '$1$2')
    .replace(/\beightbit\b/g, '8bit')
    // 带点的缩写去掉点以后是一串单字母：a c g t = acgt、a p p p = appp、aic a s t a = aic asta（#109）
    .replace(/(?:^|\s)((?:[a-z]\s){2,}[a-z])(?=\s|$)/g, (m, run) => m.replace(run, run.replace(/\s/g, '')))
    .replace(/\s+/g, ' ')
    .trim();
}
/** normStudio 的版本：规则改了就加一，migrate.js 据此重算库里存的 studio_norm */
export const STUDIO_NORM_VERSION = 4;

/**
 * 去重键：在 normTitle 之上再抹平「同一部番的不同写法」。
 *
 * 起因：AOD 按 source URL 合并条目，但各站点的条目常常没被识别成同一部 ——
 * 实测《鎧伝サムライトルーパー》(2026) 被拆成 7 条，分别来自
 * MAL / AniDB / LiveChart / aniSearch / anime-planet / Simkl，
 * 目录里就是 5 张封面一样的卡。normTitle 只去空格标点，抹不平这些差异：
 *
 *   Part 2 / Part II / 2nd Cour / Dai 2 Cour   ← 序数与分割标记的四种写法
 *   Yoroi Shin Den / Yoroi-Shinden             ← 断词不同（normTitle 已能处理）
 *   Xxx (2026) / Xxx (TV)                      ← 年份、载体后缀
 *   TOMICA & TOM / Tomica to Tom               ← 日文「と」的三种罗马字写法
 *
 * ⚠️ 只做「写法」归一，不做语义猜测。分季仍然是不同的键
 * （base 与 base#2 不同），因为它们确实是不同作品。
 */
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

export function dedupKey(title, year) {
  let t = String(title ?? '').toLowerCase();
  if (year) t = t.replace(new RegExp(`\\(?\\b${year}\\b\\)?`, 'g'), ' ');   // 去 (2026) 这类后缀
  t = t.replace(/\b(tv|tv series|the animation)\b/g, ' ');                  // 载体后缀
  t = t.replace(/\s*&\s*|\band\b/g, ' to ');                               // 「と」：& / and / to
  t = t.replace(/\bdai\s*(?=\d)/g, ' ');                                    // 第N期的 dai
  t = t.replace(/\b(\d+)(st|nd|rd|th)\b/g, ' $1 ');                         // 2nd → 2
  t = t.replace(/\b(part|cour|season|chapter|kuuru)\b/g, ' # ');            // 分割标记统一成 #
  t = t.replace(/#\s*([ivx]+)\b/g, (m, r) => (ROMAN[r] ? `# ${ROMAN[r]}` : m));  // 罗马数字
  t = t.replace(/\b(\d+)\s*#/g, '# $1');                                    // 「2 期」数字在前
  t = t.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.*?)\s*#\s*(\d+)\s*$/);
  return normTitle(m ? m[1] : t.replace(/#/g, ' ')) + (m ? `#${m[2]}` : '');
}

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const NUM_CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const RO_NUM = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

/**
 * 抽标题里的季数，抽不到就是 1。中文与罗马字两套写法都认。
 *
 * ⚠️ 季数和分部号（Part / Cour）是两回事，必须分开解析 —— 见 partOrd。
 * 原来这里把 part 也当季数，两个后果：
 *   「4th Season Part 2」被算成第 2 季 → 中文名成了「第2部分」，丢了「第四季」
 *   「2nd Season Part 2」和「2nd Season」算出同一个数 → 目录里两张卡都叫
 *   「关于我转生变成史莱姆这档事 第二季」，主人以为是重复条目
 *   （史莱姆第二季是分割播出：2021 冬 12 集 + 2021 夏 12 集，两条都对）
 */
export function seasonOrd(t, { trailingNum = false } = {}) {
  if (!t) return 1;
  const s = String(t);
  let m;
  // 中文：季/期/幕/章算季数；「部分」「部」归 partOrd
  if ((m = s.match(/第\s*([0-9]+|[一二三四五六七八九十])\s*(?:季|期|幕|章)/)))
    return /\d/.test(m[1]) ? +m[1] : CN_NUM[m[1]];
  /**
   * ⚠️ 先把「Part N / Cour N」整段摘掉再找季数。
   * 否则同一个数字会被 seasonOrd 和 partOrd 各数一次：
   *   「Lupin III: Part II」→ 结尾的 II 被当季数 2，Part II 又是分部 2
   *   「One-Punch Man 3: Part II」「Sword Gai The Animation Part II」同理
   * 后果是这些条目被误判成「季数和分部号都明写」，中文名被加上重复的
   * 「第二季 第2部分」。摘掉之后它们的季数回落到 1，就不会误改了。
   */
  const l = s.toLowerCase().replace(/\b(?:part|cour)\s*[ivx0-9]+\b/g, ' ').trim();
  if ((m = l.match(/\b(?:season|chapter)\s*([0-9]+)\b/))) return +m[1];
  if ((m = l.match(/\b([0-9]+)(?:st|nd|rd|th)\s*(?:season)?\b/))) return +m[1];
  if ((m = l.match(/\bdai\s*([0-9]+)\s*(?:ki|bu|shou)?\b/))) return +m[1];
  if ((m = l.match(/\bseason\s+([ivx]+)\b/)) && RO_NUM[m[1]]) return RO_NUM[m[1]];
  if ((m = l.match(/\s([ivx]{1,4})$/)) && RO_NUM[m[1]] > 1) return RO_NUM[m[1]];
  /**
   * 结尾是单独一个 2–9：「One Punch Man 3」「Chihayafuru 2」「Hibike! Euphonium 3」（#15，123 部 TV）。
   * ⚠️ 只在调用方确认是 TV 时才认（trailingNum）：剧场版 / OVA 的结尾数字多半是「第 N 部」
   * （「Kara no Kyoukai 2」「Detective Conan Movie 19」），不是季数。
   * 前面紧跟 movie / film / ova / vol 之类的也不算；两位数一律不算（年份、编号）。
   */
  if (trailingNum && (m = l.match(/(?:^|[^a-z0-9])([a-z][a-z'!.?-]*)\s+([2-9])$/))
      && !/^(?:movie|film|ova|oad|ona|special|specials|sp|vol|volume|episode|ep|no|part|cour|gekijouban|eiga)$/.test(m[1]))
    return +m[2];
  return 1;
}

/**
 * 抽分部号（Part 2 / Cour 2 / 第2部分），没有就是 0。
 *
 * 分割播出（split-cour）的番一季拆成两段，AOD 按段各记一条，
 * 而 bgm 只有整季那一个条目 —— 只按季数校正中文名，两段就会同名。
 */
export function partOrd(t) {
  if (!t) return 0;
  let m;
  // Bangumi 的分割播出常写「后半部分 / 後半 / 下半」（Re：从零开始的异世界生活 第二季 后半部分）
  if (/(?:后半|後半|下半)(?:部分|クール)?/.test(String(t))) return 2;
  if ((m = String(t).match(/第\s*([0-9]+|[一二三四五六七八九十])\s*(?:部分|部)/)))
    return /\d/.test(m[1]) ? +m[1] : CN_NUM[m[1]];
  const l = String(t).toLowerCase();
  if ((m = l.match(/\b(?:part|cour)\s*([0-9]+)\b/))) return +m[1];
  if ((m = l.match(/\bpart\s+([ivx]+)\b/)) && RO_NUM[m[1]]) return RO_NUM[m[1]];
  return 0;
}

/**
 * 用罗马字标题的季数校正 bgm 抄来的中文名。
 *
 * 起因：bgm 对分季的粒度和 AOD 不同，一个 bgm 条目常被匹配到多个 AOD 条目
 * （实测 604 个 bgm_id 挂在 1,300 条上）。结果是目录里出现三张
 * 「间谍过家家 第二季」，年份分别是 2022 / 2023 / 2025 —— 只有 2023 那条是对的，
 * 另两条一个是第一季、一个是第三季。同类还有《86》《胆大党》。
 *
 * 判据：罗马字标题的季数是可信的（AOD 的条目粒度就是按季分的），
 * 中文名的季数不一致就按罗马字改。实测 8,696 个中文名里有 410 条（4.7%）不一致。
 *
 * 清掉中文名不如补对 —— 「86 -不存在的战区-」补成「… 第二季」比退回罗马字有用。
 */
export function fixCnSeason(titleCn, romajiTitle, { tv = false } = {}) {
  if (!titleCn) return titleCn;
  const wantS = seasonOrd(romajiTitle, { trailingNum: tv });
  const wantP = partOrd(romajiTitle);
  if (seasonOrd(titleCn) === wantS && partOrd(titleCn) === wantP) return titleCn;
  // 先摘掉中文名里原有的季数/分部标记（它属于别的一季或别的一段）
  const base = String(titleCn)
    .replace(/\s*第\s*(?:[0-9]+|[一二三四五六七八九十])\s*(?:季|期|部分|部|幕|章)\s*/g, ' ')
    .replace(/\s+/g, ' ').trim();
  // 季数和分部号都写上 —— 分割播出的两段只差分部号，少写一个就同名
  let out = base;
  if (wantS > 1) out += ` 第${wantS <= 10 ? NUM_CN[wantS] : wantS}季`;
  if (wantP > 1) out += ` 第${wantP}部分`;
  return out;
}
