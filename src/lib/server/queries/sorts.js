/**
 * 排序的 SQL 片段（目录 / 番单 / 季度浏览共用）。从 catalog.js 拆出来：加了第二排序后那个文件超过 400 行。
 */
/** 季度 → 月份序号。WINTER=1-3 月，业界口径一年从冬番开始 */
export const SEASON_ORD = `CASE a.season WHEN 'WINTER' THEN 1 WHEN 'SPRING' THEN 2
                                 WHEN 'SUMMER' THEN 3 WHEN 'FALL' THEN 4 END`;

export const SORTS = {
  /**
   * 「评分」：按 Bangumi 的【榜位】排，不是按裸平均分。
   *
   * 原来这里有三个键：score（裸分）、scoreSafe（票数≥300 才参与，界面上叫「评分」）、
   * rank（榜位，界面上叫「Bangumi 排名」）。实测后两个几乎是同一个东西 ——
   * 同一批 2023 年 TV 番前 6 名完全相同；按 rank 排时相邻的分数逆序只有 4%，
   * 且没有一次差超过 0.3 分。让用户在界面上理解两个概念是多余的，合成一个。
   *
   * 为什么用 rank 而不是用分数（这点反直觉，是查数据才定的）：
   * 已进榜条目的票数最低只有 51 票（10 分位 97 票）。若只拿 rank>0 当门槛、
   * 按分数排，51 票的高分会挤掉 36,000 票的 —— 正是当初设「≥300 票」要防的
   * 小样本污染。而 Bangumi 的 rank 本身就是加权过的，票少的自然排后面，
   * 不需要我们再拍一个魔法常数。
   *
   * ⚠️ rank=0 表示「票数不够未进榜」，必须当作未排名（NULLS LAST），
   * 否则 0 会当成第一名顶到榜首。
   * 同榜位时（分季/合集共用一个 bgm 条目会同名同榜）用分数细排。
   *
   * 覆盖面：原来的 scoreSafe 能排 6,531 部，换成 rank 后 9,307 部。
   */
  score: 'CASE WHEN a.bgm_rank > 0 THEN a.bgm_rank END ASC NULLS LAST, a.bgm_score DESC',
  popular: 'a.bgm_collection DESC NULLS LAST, a.source_count DESC',
  // ⚠️ season 是文本，直接 DESC 是按字母排：实测得到
  //    WINTER → UNDEFINED → SUMMER → SPRING → FALL，完全不是时间顺序。
  //    必须映射成月份序号。
  // 同一季内按人气：原来到季度就没有下一键，同季 74 部 TV 的先后取决于入库顺序 ——
  // Bangumi 新建的儿童向条目（个位数收藏）编号最新，整排挤在目录第一行（2026-10-18 主人截图）
  newest:  `a.year DESC NULLS LAST, ${SEASON_ORD} DESC NULLS LAST, a.bgm_collection DESC NULLS LAST, a.source_count DESC`,
  oldest:  `a.year ASC NULLS LAST, ${SEASON_ORD} ASC NULLS LAST, a.bgm_collection DESC NULLS LAST, a.source_count DESC`,
  eps:     'a.episodes DESC NULLS LAST',
  // 一部没评分时全是 NULL，没有兜底排序结果就是随机序
  mine:    'ue.my_score DESC NULLS LAST, ue.updated_at DESC'
};
/**
 * 按时间排（最新 / 最早）时的第二排序（见 constants.js: SORT2_OPTS）。
 * 每一项最后都垫上人气 + 收录站数，保证同分 / 同集数时顺序也稳定。
 */
const TIME_KEY = {
  newest: `a.year DESC NULLS LAST, ${SEASON_ORD} DESC NULLS LAST`,
  oldest: `a.year ASC NULLS LAST, ${SEASON_ORD} ASC NULLS LAST`
};
const SORT2 = {
  popular: 'a.bgm_collection DESC NULLS LAST, a.source_count DESC',
  score: `${SORTS.score}, a.bgm_collection DESC NULLS LAST, a.source_count DESC`,
  eps: 'a.episodes DESC NULLS LAST, a.bgm_collection DESC NULLS LAST, a.source_count DESC'
};
export const orderBy = (sort, sort2) => (TIME_KEY[sort] ? `${TIME_KEY[sort]}, ${SORT2[sort2] ?? SORT2.popular}` : (SORTS[sort] || SORTS.popular));
