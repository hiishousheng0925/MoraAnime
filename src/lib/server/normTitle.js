/**
 * 标题规范化：简繁归一、小写、去标点空白 —— 和 FTS 索引同一套 segment，再把空格去掉。
 * 搜索时「标题完全匹配置顶」用它比较（见 catalog.js: listAnime）。
 */
import { segment } from './text.js';

export const normTitle = (s) => (s == null ? null : segment(s).replace(/ /g, ''));

/** 给连接注册 SQL 函数 norm_title()（每个连接注册一次） */
const withNorm = new WeakSet();
export function ensureNorm(db) {
  if (withNorm.has(db)) return;
  db.function('norm_title', { deterministic: true }, normTitle);
  withNorm.add(db);
}
