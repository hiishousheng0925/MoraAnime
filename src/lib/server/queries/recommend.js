/**
 * 首页的推荐与「最近看完」。
 *
 * 从 catalog.js 拆出来 —— 那边已经 429 行，超了 lint 的 400 行上限，
 * 而推荐本来就是独立关注点（catalog.js 管检索/筛选/季度/放送表）。
 */
import { getDb } from '../db.js';
import { GENRE_MAP, TAG_TO_GENRE } from '../../genres.js';
import { listAnime } from './catalog.js';
import { hideNsfw, yearWindow } from './prefs.js';

/**
 * 首页的「推荐」区 —— 必须在任何状态下都有内容，否则首页会变成死胡同。
 * 优先级：① 想看列表里门槛低的 ② 和我标过「看过」的番同标签的 ③ 纯口碑推荐
 */
export function recommend(limit = 12) {
  const db = getDb();
  const out = [];
  const seenIds = new Set();
  /**
   * 三个来源共用同一套站点口径：隐藏 NSFW、显示年份窗口、按推导后的 status_eff 判完结。
   * 原来只有 ① 走 listAnime 套了窗口，②③ 手写 SQL 全漏了，且用的是会过期的原始 status ——
   * 打开「隐藏 NSFW」后兜底推荐里仍可能出现成人内容。
   */
  const nsfw = hideNsfw();
  const { min: yMin, max: yMax } = yearWindow();
  const SITE = `a.is_stub=0 AND a.is_jp=1 AND a.type='TV' AND coalesce(a.status_eff,a.status)='FINISHED'
    AND (a.year IS NULL OR (a.year >= ${yMin} AND a.year <= ${yMax}))${nsfw ? ' AND a.is_nsfw=0' : ''}`;

  /**
   * 三个来源按优先级依次填，去重。
   * 原来每行还带一个 _reason 字段（「口味相近」这类），首页拿它当区块右上角的标签 ——
   * 现在那个位置换成了去目录的入口，没人读这个字段了，就别再往客户端送。
   * 每一段来源看下面的注释就清楚，不需要用数据来自我说明。
   */
  const push = (rows) => {
    for (const r of rows) {
      if (out.length >= limit || seenIds.has(r.id)) continue;
      seenIds.add(r.id); out.push(r);
    }
  };

  // ① 想看列表：已完结 + 集数少 = 最容易开的
  push(listAnime({ watch: 'plan', status: 'FINISHED', epMax: 26, hideNsfw: nsfw },
                 { limit, sort: 'score' }).rows);

  /**
   * ② 口味推荐。
   *
   * 原来的写法是「取看过的番里最高频的 8 个原始 tag，任意命中 1 个就算通过，
   * 然后纯按 bgm 评分排」。实测这等于没筛：
   *   · 最高频的 8 个 tag 里有 japanese production / place / present / tropes ——
   *     那是 AOD 的元数据噪音，不是题材（genres.js 开头就写了这件事）
   *   · 命中率 503/516 = 97%，过滤形同虚设
   *   · 于是排出来的就是「评分最高的老经典」：哆啦A梦 1979、明日之丈 1980、
   *     灌篮高手 1993、机动战士Z高达 1985…，而主人看过的番 327/328 是 2010 年以后的
   *   · 小马宝莉也进来了 —— 它只共享一个「日常治愈」，靠 8.0 分挤上来的
   *
   * 改三处：
   *   a. 只用【真题材】：走 TAG_TO_GENRE 收敛，元数据 tag 天然被排掉
   *   b. 题材重合数当【排序主键】，而不是布尔过滤；至少要重合 2 个才算「口味相近」
   *   c. 限定年代：下限取主人看过的番的年份 10 分位，别再拿 1979 年的番来推荐
   */
  if (out.length < limit) {
    const myGenres = db.prepare(`
      SELECT t.tag FROM user_entry ue JOIN anime_tag t ON t.anime_id = ue.anime_id
      WHERE ue.status = 'completed'`).all()
      .reduce((m, r) => {
        const g = TAG_TO_GENRE[r.tag];
        if (g) m.set(g, (m.get(g) ?? 0) + 1);
        return m;
      }, new Map());
    const top = [...myGenres].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g]) => g);

    // 年代下限：看过的番按年份排序取 10 分位。主人以后补了老番，这个下限会自己降下来
    const yrs = db.prepare(`SELECT a.year FROM user_entry ue JOIN anime a ON a.id = ue.anime_id
      WHERE ue.status = 'completed' AND a.year IS NOT NULL ORDER BY a.year`).all().map((r) => r.year);
    const yearFloor = yrs.length ? yrs[Math.floor(yrs.length * 0.1)] : 0;

    const pairs = top.flatMap((g) => (GENRE_MAP[g] ?? []).map((t) => [t, g]));
    if (pairs.length) {
      const values = pairs.map(() => '(?,?)').join(',');
      push(db.prepare(`
        WITH mine(tag, g) AS (VALUES ${values})
        SELECT a.id,a.title,a.title_ja,a.title_cn,a.type,a.year,a.season,a.episodes,a.status,
               coalesce(a.status_eff,a.status) AS status_eff,a.is_short,a.thumbnail,a.picture,a.cover_dead,
               a.bgm_score,a.bgm_votes,a.bgm_collection,a.source_count,
               NULL AS my_status,NULL AS current_episode,NULL AS my_score,
               count(DISTINCT mine.g) AS hits
        FROM anime a
        JOIN anime_tag t ON t.anime_id = a.id
        JOIN mine ON mine.tag = t.tag
        WHERE ${SITE}
          AND a.bgm_score >= 7.5 AND a.bgm_votes >= 500 AND a.year >= ?
          AND NOT EXISTS (SELECT 1 FROM user_entry u WHERE u.anime_id=a.id)
          AND NOT EXISTS (SELECT 1 FROM triage tr WHERE tr.anime_id=a.id)
        GROUP BY a.id
        HAVING hits >= 2
        ORDER BY hits DESC, a.bgm_score DESC
        LIMIT ?`).all(...pairs.flat(), yearFloor, limit - out.length));
    }
  }

  // ③ 兜底：纯口碑，保证永远不为空
  if (out.length < limit) {
    push(db.prepare(`
      SELECT a.id,a.title,a.title_ja,a.title_cn,a.type,a.year,a.season,a.episodes,a.status,
             coalesce(a.status_eff,a.status) AS status_eff,a.is_short,a.thumbnail,a.picture,a.cover_dead,a.bgm_score,a.bgm_votes,a.bgm_collection,
             a.source_count,NULL AS my_status,NULL AS current_episode,NULL AS my_score
      FROM anime a
      WHERE ${SITE}
        AND a.bgm_votes >= 1000
        AND NOT EXISTS (SELECT 1 FROM user_entry u WHERE u.anime_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM triage tr WHERE tr.anime_id=a.id)
      ORDER BY a.bgm_score DESC
      LIMIT ?`).all(limit - out.length));
  }
  return out;
}
/** 我标为「看过」的（首页给点成就感，也方便回头补集数/评分） */
export function recentlySeen(limit = 12) {
  return getDb().prepare(`
    SELECT a.id,a.title,a.title_ja,a.title_cn,a.type,a.year,a.episodes,a.status,a.is_short,
           a.thumbnail,a.picture,a.cover_dead,a.bgm_score,a.bgm_votes,coalesce(a.status_eff,a.status) AS status_eff,ue.status AS my_status,ue.current_episode,
           ue.my_score,ue.is_vague
    FROM user_entry ue JOIN anime a ON a.id=ue.anime_id
    WHERE ue.status='completed'
    ORDER BY ue.updated_at DESC LIMIT ?`).all(limit);
}
