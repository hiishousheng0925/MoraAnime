/**
 * bangumi/Archive 的解析（纯函数，无 I/O）。issue #2：主数据源迁到 Bangumi。
 *
 * Archive 是 Bangumi 每周导出的 wiki 原始数据（subject.jsonlines 等）。和 API 不同，
 * 结构化字段只有 name / name_cn / platform / date / score / rank / tags / nsfw / favorite，
 * 话数、放送日期、别名、制作公司都在 infobox 这串 wiki 文本里，要自己抠。
 * 格式按 2026-10-13 那份 dump 全量统计过（31,174 部动画），见下面各函数的注释。
 */

/** platform → 本库的 type。1 TV · 2 OVA · 3 剧场版 · 5 WEB · 0 其他 · 2006 动态漫画 */
export const PLATFORM_TYPE = { 1: 'TV', 2: 'OVA', 3: 'MOVIE', 5: 'ONA', 0: 'SPECIAL', 2006: 'ONA' };

/** 本库 type 能接受哪些 platform（匹配时用；SPECIAL / UNKNOWN 在两边都很杂，放宽） */
export const TYPE_PLATFORMS = {
  TV: [1, 5, 0], MOVIE: [3, 0], OVA: [2, 0, 5], ONA: [5, 1, 0, 2006], SPECIAL: [0, 1, 2, 5, 3], UNKNOWN: [0, 1, 2, 3, 5, 2006]
};

/** infobox 里取一个单行字段的值（`|话数= 25`），没有返回 null */
export function ibField(infobox, key) {
  const m = String(infobox ?? '').match(new RegExp(`\\|${key}\\s*=\\s*([^\\r\\n|]*)`));
  const v = m?.[1]?.trim();
  return v && v !== '*' && v !== '}}' && v !== '{' ? v : null;
}

/**
 * 别名：`|别名={ [叛逆的鲁路修R2] [Code Geass: ...] }`，偶有 `[ja|xxx]` 这种带语言前缀的。
 * 全量 79,499 个，SR1 那批简称（锻刀村、波奇、Re0…）就在这里。
 */
export function ibAliases(infobox) {
  const m = String(infobox ?? '').match(/\|别名\s*=\s*\{([\s\S]*?)\}/);
  if (!m) return [];
  return [...m[1].matchAll(/\[([^\]]+)\]/g)]
    .map((x) => x[1].replace(/^[^|]{1,12}\|/, '').trim())
    .filter((s) => s.length >= 2);
}

/**
 * 日期四种写法：2008年4月6日 / 2009-07-09 / 1987年 / 2002年9月（也有不补零的 2008-4-6）。
 * 只取到能确定的精度，返回 'YYYY-MM-DD' / 'YYYY-MM' / 'YYYY'，认不出返回 null。
 */
export function parseDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  let m;
  if ((m = t.match(/^(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})/)))
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if ((m = t.match(/^(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*月?/))) return `${m[1]}-${m[2].padStart(2, '0')}`;
  if ((m = t.match(/^(\d{4})\s*年?/))) return m[1];
  return null;
}

/** 话数：`25` / `24+2`（本篇 + 特别篇，合计）/ `*`（未定）→ 整数或 null */
export function parseEps(s) {
  if (!s) return null;
  const parts = String(s).match(/\d+/g);
  if (!parts) return null;
  const n = /^\s*\d+\s*(\+\s*\d+\s*)+$/.test(s) ? parts.reduce((a, b) => a + +b, 0) : +parts[0];
  return n > 0 && n < 10000 ? n : null;
}

const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
/** 放送星期：星期六 → 6（bgm 的 1=周一 … 7=周日，和 /calendar 一致） */
export const parseWeekday = (s) => (s && /^星期(.)$/.test(s.trim()) ? WEEKDAY[s.trim()[2]] ?? null : null);

/** 季度：按开播月份 1-3 冬 / 4-6 春 / 7-9 夏 / 10-12 秋 */
export function seasonOf(date) {
  const m = +String(date ?? '').slice(5, 7);
  return !m ? 'UNDEFINED' : m <= 3 ? 'WINTER' : m <= 6 ? 'SPRING' : m <= 9 ? 'SUMMER' : 'FALL';
}

/**
 * 日本番 / 非日本番，判不出返回 null（交给 AOD 那边的判据）。
 * 按 tag 和「制片国家」字段；A6 定案：国创不算日本动画，中日合拍（两边 tag 都有）算日本。
 */
const JP_TAGS = new Set(['日本', '日本动画', '日漫', '日本动漫']);
const NON_JP_TAGS = new Set(['中国', '国产', '国创', '中国动画', '国漫', '欧美', '美国', '美漫', '韩国',
  '法国', '英国', '加拿大', '台湾', '俄罗斯', '德国', '西班牙', '意大利', '澳大利亚']);
export function jpVerdict(subject) {
  const tags = (subject.tags ?? []).filter((t) => (t.count ?? 0) >= 2).map((t) => t.name);
  const country = ibField(subject.infobox, '制片国家/地区') ?? ibField(subject.infobox, '国家');
  if (tags.some((t) => JP_TAGS.has(t)) || /日本/.test(country ?? '')) return 1;
  if (tags.some((t) => NON_JP_TAGS.has(t)) || (country && !/日本/.test(country))) return 0;
  // 原名带假名基本就是日本作品
  if (/[぀-ヿ]/.test(subject.name ?? '')) return 1;
  return null;
}

/** 收藏人数合计（想看 + 看过 + 在看 + 搁置 + 抛弃）—— 「主流程度」的指标（DS2 拍板第 3 条） */
export const collectTotal = (s) => Object.values(s.favorite ?? {}).reduce((a, b) => a + (+b || 0), 0);

/** 评分人数 */
export const voteTotal = (s) => Object.values(s.score_details ?? {}).reduce((a, b) => a + (+b || 0), 0);

/** 一条 subject → 本库要的字段（不含匹配，只是解析） */
export function parseSubject(s) {
  const ib = s.infobox ?? '';
  const start = parseDate(s.date) ?? parseDate(ibField(ib, '放送开始')) ?? parseDate(ibField(ib, '上映年度'))
    ?? parseDate(ibField(ib, '发售日')) ?? parseDate(ibField(ib, '开始'));
  const end = parseDate(ibField(ib, '播放结束')) ?? parseDate(ibField(ib, '结束'));
  return {
    id: s.id,
    name: s.name || null,
    name_cn: s.name_cn || null,
    type: PLATFORM_TYPE[s.platform] ?? 'UNKNOWN',
    platform: s.platform,
    air_start: start,
    air_end: end,
    year: start ? +start.slice(0, 4) : null,
    season: seasonOf(start),
    eps: parseEps(ibField(ib, '话数')),
    weekday: parseWeekday(ibField(ib, '放送星期')),
    studio: ibField(ib, '动画制作'),
    summary: s.summary || null,
    nsfw: s.nsfw ? 1 : 0,
    score: s.score || null,
    rank: s.rank || null,
    votes: voteTotal(s),
    collection: collectTotal(s),
    is_jp: jpVerdict(s),
    aliases: ibAliases(ib),
    tags: (s.tags ?? []).filter((t) => (t.count ?? 0) >= 3).slice(0, 20).map((t) => t.name)
  };
}
