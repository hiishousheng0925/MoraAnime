/**
 * 全站快速搜索（顶栏 ⌘K 面板，/api/search）。
 *
 * 搜索口径和目录搜索是同一套：FTS5 + CJK 逐字分词（text.js: toFtsQuery），可见性也一样 ——
 * 不显示 is_stub、国创（is_jp=0）、「隐藏 NSFW」开着时的 NSFW 条目，遵守设置页的显示年份窗口
 * （没年份的照常显示，和目录搜索卸掉 requireYear 后一致）。
 *
 * 排序：主人拍板过搜索按「新 → 旧」（#107），这里不改成相关度。但面板只放 10 条，
 * 长系列一搜就被新出的 PV / 小剧场 / 联动短片占满（实测「孤独」前 10 条里《孤独摇滚！》TV 本篇
 * 排在两部总集篇和一堆冷门 SP 后面），所以只多加一层「命中程度」分组，组内仍是新 → 旧：
 *   0 标题 / 中文名 / 日文名【完全等于】搜索词 —— 目录搜索本来就把这一档置顶（catalog.js: listAnime）
 *   1 某个名字以搜索词【开头】（孤独 → 孤独摇滚！、咒术 → 咒术回战 …）
 *   2 其余命中（含别名命中、标题中间命中）
 * 面板底部「在目录中搜索」进 /catalog?q=，那里是完整的新 → 旧列表。
 */
import { getDb } from '../db.js';
import { getSetting, yearWindow } from './prefs.js';
import { currentSeason } from './catalog.js';
import { toFtsQuery } from '../text.js';
import { normTitle, ensureNorm } from '../normTitle.js';
import { orderBy } from './sorts.js';

export const QUICK_Q_MAX = 100;
export const QUICK_LIMIT = 10;

const COLS = `a.id, a.title, a.title_ja, a.title_cn, a.type, a.year, a.season, a.episodes,
  a.thumbnail, a.picture, a.cover_dead, ue.status AS my_status, ue.current_episode`;

/** 访客 / 账号共用的可见性条件（和目录一致） */
function visible() {
  const w = ['a.is_stub = 0', 'a.is_jp = 1'];
  const p = [];
  if (getSetting('hide_nsfw', '0') === '1') w.push('a.is_nsfw = 0');
  const { min, max } = yearWindow();
  w.push('(a.year IS NULL OR (a.year >= ? AND a.year <= ?))');
  p.push(min, max);
  return { where: w.join(' AND '), params: p };
}

/** 搜索词清洗：去首尾空白、截到 100 字；一个字母 / 数字 / 汉字都没有就当没搜（同 loaderUtil.pickQ） */
export function cleanQuickQ(raw) {
  const q = String(raw ?? '').trim().slice(0, QUICK_Q_MAX).trim();
  return /[\p{L}\p{N}]/u.test(q) ? q : '';
}

/**
 * 搜索。返回 { rows, total }；rows 最多 limit 条（上限 10）。
 * 前缀判断用 norm_title()（简繁归一、去标点空白，和 FTS 同一套 segment），所以「咒術」「咒术」都算前缀。
 */
export function quickSearch(raw, { limit = QUICK_LIMIT } = {}) {
  const q = cleanQuickQ(raw);
  const fts = q ? toFtsQuery(q) : null;
  if (!fts) return { q, rows: [], total: 0 };
  const db = getDb();
  ensureNorm(db);
  const nq = normTitle(q);
  const { where, params } = visible();
  const n = Math.max(1, Math.min(QUICK_LIMIT, limit | 0 || QUICK_LIMIT));
  const rows = db.prepare(`
    SELECT ${COLS}
    FROM anime_fts ft
    JOIN anime a ON a.id = ft.rowid
    JOIN (SELECT ? AS nq) k
    LEFT JOIN user_entry ue ON ue.anime_id = a.id
    WHERE ${where} AND ft.seg MATCH ?
    ORDER BY CASE
        WHEN k.nq IN (norm_title(a.title), norm_title(a.title_cn), norm_title(a.title_ja)) THEN 0
        WHEN substr(norm_title(a.title_cn), 1, length(k.nq)) = k.nq
          OR substr(norm_title(a.title), 1, length(k.nq)) = k.nq
          OR substr(norm_title(a.title_ja), 1, length(k.nq)) = k.nq THEN 1
        ELSE 2 END,
      ${orderBy('newest', 'popular')}
    LIMIT ${n}`).all(nq, ...params, fts);
  const total = db.prepare(`
    SELECT count(*) c FROM anime a JOIN anime_fts ft ON ft.rowid = a.id
    WHERE ${where} AND ft.seg MATCH ?`).get(...params, fts).c;
  return { q, rows, total };
}

/**
 * 没输入时的快捷入口。
 *   登录：在看的排前面，其次最近动过的看完 / 想看（按 updated_at）
 *   访客（或番单还是空的）：本季人气前几部
 */
export function quickDefaults(userId, limit = 6) {
  const db = getDb();
  if (userId) {
    const rows = db.prepare(`
      SELECT ${COLS}
      FROM user_entry ue JOIN anime a ON a.id = ue.anime_id
      WHERE a.is_stub = 0 AND ue.status IN ('watching', 'completed', 'plan')
      ORDER BY ue.status = 'watching' DESC, ue.updated_at DESC
      LIMIT ?`).all(limit);
    if (rows.length) return { kind: 'recent', rows };
  }
  const { year, season } = currentSeason();
  const { where, params } = visible();
  return {
    kind: 'hot',
    rows: db.prepare(`
      SELECT ${COLS}
      FROM anime a LEFT JOIN user_entry ue ON ue.anime_id = a.id
      WHERE ${where} AND a.year = ? AND a.season = ?
      ORDER BY a.bgm_collection DESC NULLS LAST, a.source_count DESC
      LIMIT ?`).all(...params, year, season, limit)
  };
}
