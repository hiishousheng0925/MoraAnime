/**
 * 全站唯一的文案与选项来源。
 * 重构前 TYPE_CN 抄了 4 份、WATCH_STATUS 4 份、SORTS 3 份，改一处得找四个文件。
 */
export const TYPE_CN = {
  TV: 'TV', MOVIE: '剧场版', ONA: 'ONA', OVA: 'OVA', SPECIAL: 'SP', UNKNOWN: '未知'
};
export const WATCH_STATUS = {
  plan: '想看', watching: '在看', completed: '看完', on_hold: '搁置', dropped: '弃番'
};
/**
 * 状态配色。两个位置两种呈现，色相共用一套：蓝（在播）→ 紫（还没播）→ 灰（播完/不知道）。
 *
 * STATUS_BADGE 压在封面图上：透明度和「TV」角标一致（/70），各自保留自己的颜色。
 *   底色必须够深 —— 同样 70% 半透明，落在浅色封面上配白字：
 *   sky-700 只有 3.3:1、blue-800 4.1、blue-900 4.499（差一点点），得再深一档才够。
 *   「连载中」用 #152a8c 而不是调色板里的某一档：sky-950 够暗但偏青（蓝度只有 +19），
 *   blue-950 是 +33，这个深蓝是 +69，同时还有 5.1:1 的余量。
 *   白封面 / 黑封面实测：连载中 5.1 / 15.3 · 未上映 6.1 / 17.5 · 已完结 6.6 / 19.0
 * STATUS_TONE 用在详情页那种纯色卡片上：那里没有封面干扰，实底 + 白字更清楚。
 *   （原来详情页自己写的 bg-emerald-500/20 + text-emerald-300 在亮色模式只有 1.19:1）
 */
export const STATUS_BADGE = {
  // 「连载中」不在这里：2026-10 UI 大改起封面上画成右上角的绿色小圆点（PosterCard 里的 bg-live），
  // 太常见了，写字角标挡封面又没信息量。少见的状态才保留文字角标。
  UPCOMING: 'bg-violet-950/70 text-white',
  FINISHED: 'bg-slate-900/70 text-white',
  UNKNOWN:  'bg-slate-900/70 text-white'
};
/**
 * 封面左下「我的状态」徽标（PosterCard）。按状态分色，一眼分得出在看和看完：
 *   在看 = 主题色实底（最该被看见）· 看完 = 深色玻璃底 + 亮绿字 · 想看 = 深底 + 白描边
 *   搁置 / 弃番 = 深底灰字（低调）
 * 压在任意封面上，所以除「在看」外都是固定的深色底 /70（和左上角标同一个透明度）+ 固定字色，不随主题变。
 * 实测最坏情况（纯白封面，底色合成 #4d4d4d）：亮绿 4.85:1 · slate-300 5.69:1 · 白 8.4:1
 */
export const MY_STATUS_BADGE = {
  watching:  'bg-accent text-on-accent',
  completed: 'bg-black/70 text-live',
  plan:      'bg-black/70 text-white ring-1 ring-inset ring-white/75',
  on_hold:   'bg-black/70 text-slate-300',
  dropped:   'bg-black/70 text-slate-300'
};
/**
 * 列表行里「我的状态」小标签（排行榜行、快速搜索结果）—— 不压在封面上，所以用淡底而不是 MY_STATUS_BADGE 的黑底。
 * 两处原来各写一份，「想看」一处是灰底一处是描边。取描边：想看还没开始，和在看 / 看完的实色底拉开；
 * 搁置 / 弃番压成弱色，不和想看混在一起。
 */
export const MY_STATUS_TAG = {
  watching:  'bg-accent/15 text-accent-ink',
  completed: 'bg-live/15 text-live-ink',
  plan:      'ring-1 ring-inset ring-ink-600 text-ink-200',
  on_hold:   'bg-ink-800 text-ink-400',
  dropped:   'bg-ink-800 text-ink-400'
};
export const STATUS_TONE = {
  ONGOING:  'bg-sky-700 text-white',
  UPCOMING: 'bg-violet-700 text-white',
  FINISHED: 'bg-slate-600 text-white',
  UNKNOWN:  'bg-slate-600 text-white'
};

export const STATUS_CN = {
  FINISHED: '已完结', ONGOING: '连载中', UPCOMING: '未上映', UNKNOWN: '未知'
};

/**
 * 评分可信门槛。
 * 实测未上映的番大量只有 3-8 票就显示出一个分数（胆大党三期 8.4 分 / 8 票、
 * GATE 二期 7.7 分 / 3 票），和真有几千票的同分番在卡片上长得一样，属于误导。
 * 未上映一律不显示分数；已播出的按票数把门。
 */
export const MIN_VOTES_FOR_SCORE = 100;

/** 观看页自动选片源的门槛：片源结果至少是「名字包含 + 同季」（打分见 server/sources/rank.js） */
export const WATCH_AUTO_PICK = 70;
export const showScore = (a) =>
  a?.bgm_score != null && a.status_eff !== 'UPCOMING' && (a.bgm_votes ?? 0) >= MIN_VOTES_FOR_SCORE;
export const SEASON_CN = { WINTER: '冬', SPRING: '春', SUMMER: '夏', FALL: '秋' };

/**
 * 季度对应的月份。
 * ⚠️ 动画业界按「番组季度（cour）」划分，一年从 1 月的冬番开始 ——
 * 和「1-3 月是春天」的日常直觉不同。AniList / MAL / bangumi 口径一致，
 * 实测 AOD 也吻合（鬼灭 2019-04 → SPRING，芙莉莲二期 2026-01 → WINTER）。
 * 所以标签上必须写出月份，否则用户会以为排错了。
 */
export const SEASON_MONTHS = { WINTER: '1-3月', SPRING: '4-6月', SUMMER: '7-9月', FALL: '10-12月' };

/** [值, 文案] 形式的选项列表，喂给 MultiChip / Select */
/** 筛选器里出现的全部类型。seasons / ranking 原来各自硬编码一份（seasons 同一个函数里抄了两遍） */
export const ALL_TYPES   = ['TV', 'MOVIE', 'ONA', 'OVA', 'SPECIAL'];
/**
 * 目录页默认勾的类型。排除 ONA 和 SP ——
 * SP 有 11,212 条（比 TV 还多），平均 1.6 集 / 8 分钟；ONA 6,739 条、13.7 集 / 9 分钟，
 * 大多是碎片。早先默认「全部类型」的理由是「默认排序是人气，冷门 SP 会自动沉底」，
 * 但默认排序已改成「最新」，那个机制不再生效，碎片会直接顶到首屏。
 */
export const DEFAULT_TYPES = ['TV', 'MOVIE', 'OVA'];
export const TYPE_OPTS   = ALL_TYPES.map((v) => [v, TYPE_CN[v]]);

export const WATCH_OPTS  = Object.entries(WATCH_STATUS);
/** 番单的 tab：「全部」只含想看/在看/看完，搁置与弃番单列 */
export const MINE_TABS = [
  ['active', '全部'], ['plan', '想看'], ['watching', '在看'],
  ['completed', '看完'], ['on_hold', '搁置'], ['dropped', '弃番']
];
/** 目录页的完结状态多选项（含「未知」—— 214 条没有任何播出信息的条目） */
export const STATUS_OPTS_ALL = ['ONGOING', 'FINISHED', 'UPCOMING', 'UNKNOWN'].map((v) => [v, STATUS_CN[v]]);
/** [值, 「冬季 1-3月」] —— 带月份的选项，给筛选器用 */
export const SEASON_OPTS_M = Object.entries(SEASON_CN).map(([v, l]) => [v, `${l}季 ${SEASON_MONTHS[v]}`]);
export const WEEKDAY_OPTS = [[1, '周一'], [2, '周二'], [3, '周三'], [4, '周四'],
                             [5, '周五'], [6, '周六'], [7, '周日']];
export const DECADE_OPTS = [[2020, 2029, '2020s'], [2010, 2019, '2010s'], [2000, 2009, '2000s'],
                            [1990, 1999, '1990s'], [1980, 1989, '1980s'], [1950, 1979, '更早']];

/**
 * 排序项。键必须和 server 的 SORTS 对得上。
 * 目录 / 番单 / 季度浏览共用这一份 —— 重构前三页各有一套，
 * 「最新」在番单里叫「年份新」，季度浏览干脆写死在 SQL 里。
 */
export const SORT_OPTS = [
  ['newest', '最新'], ['oldest', '最早'], ['popular', '人气'],
  // 「评分」底层用 Bangumi 的榜位（见 queries/catalog.js: SORTS.score）——
  // 原来「评分」和「Bangumi 排名」是两个选项，实测结果几乎一样，合成一个
  ['score', '评分'], ['eps', '集数'], ['mine', '我的评分']
];
/** 默认排序：年份+季度，新 → 旧 */
export const DEFAULT_SORT = 'newest';
/**
 * 第二排序：只跟按时间排的（最新 / 最早）配 —— 同一季里几十部「并列」，得有下一键分先后。
 * 原来写死成人气、界面上看不出来（主人 2026-10-18 问「第一第二排序能不能体现在选项里」）。
 * URL 参数 s2，缺省 = 人气。
 */
export const TIME_SORTS = ['newest', 'oldest'];
export const SORT2_OPTS = [['popular', '人气'], ['score', '评分'], ['eps', '集数']];
export const DEFAULT_SORT2 = 'popular';
/** 从 URL 取第二排序，认不出的回到缺省 */
export const pickSort2 = (v) => (SORT2_OPTS.some(([k]) => k === v) ? v : DEFAULT_SORT2);
/** 季度浏览的子集：一个季度块里所有番的年份季度都相同，最新/最早在那儿是空操作 */
export const SEASON_SORT_OPTS = SORT_OPTS.filter(([v]) => !['newest', 'oldest'].includes(v));
export const SEASON_DEFAULT_SORT = 'popular';

/** 默认年份下限：1950 年前是默片短片，封面链接大多已失效 */
/** 年份筛选的缺省下限（可被设置页的窗口覆盖） */
export const YEAR_FLOOR = 1950;
/**
 * 抓取与配置的硬边界：库里最多存 1950–2050，设置页的滑块也只能在这个区间里拖。
 * 上游偶尔会有 2050 之后的占位条目（年份写错或极远期公告），越界的没有意义。
 */
export const YEAR_HARD_MIN = 1950;
export const YEAR_HARD_MAX = 2050;

/**
 * 年份选项上限 = 今年 + 1。
 * 实测 2028-2033 只有 8 条远期公告（全是 UPCOMING 的剧场版/ONA），
 * 放进年份选择器纯属噪音；明年（159 条已公布新番）是有意义的。
 */
export const yearCeil = () => new Date().getFullYear() + 1;

/** 侧栏展开状态。存 cookie 而不是 localStorage —— SSR 要读得到，否则首屏会先收起再弹开 */
export const DRAWER_COOKIE = 'j_drawer';

/* ── 详情页（2026-10 UI 大改 · detail）─────────────────────────────────── */

/**
 * 详情页头部唯一保留成胶囊的两种播出状态；其余（未上映 / 未知）写进元信息那行文字里。
 * 淡底 + 同色系深字：两套主题都 ≥4.5:1（accent-ink / live-ink 就是为淡底定的那档）。
 */
export const STATUS_PILL = {
  FINISHED: 'bg-accent/15 text-accent-ink',
  ONGOING:  'bg-live/15 text-live-ink'
};

/**
 * 外部条目：站点域名 → 按钮上的短名。
 * MAIN 是排在前面的三个主站，带一个首字母小方块（品牌色，两套主题同一个值，白字 ≥4.5:1）。
 * 不用各站 /favicon.ico：外链小图会被 ORB 拦、每开一次详情页还向十个站各发一次请求。
 */
export const SITE_SHORT = {
  'myanimelist.net': 'MAL', 'anilist.co': 'AniList', 'anidb.net': 'AniDB', 'kitsu.app': 'Kitsu',
  'anime-planet.com': 'Anime-Planet', 'anisearch.com': 'aniSearch', 'simkl.com': 'Simkl',
  'animecountdown.com': 'AnimeCountdown', 'animenewsnetwork.com': 'ANN', 'livechart.me': 'LiveChart'
};
export const SITE_MAIN = [
  ['bangumi', 'Bangumi', 'B', '#c93a60'],
  ['myanimelist.net', 'MAL', 'M', '#2e51a2'],
  ['anilist.co', 'AniList', 'A', '#0b6fb0']
];
