/**
 * 个人记录的取值规则（issue #11）：这是全库唯一不可再生的数据，写进来的值必须先校验。
 * 非法 status 会让记录同时从番单筛选和统计口径里静默消失；字符串 delta 曾被拼成 "0abc" 存进 current_episode。
 *
 * /api/entry、/api/triage 和备份导入共用这一份 —— 导入原来一样都不查，手改过的 JSON 能把坏值直接写进库（2026-10-21 审核）。
 */
// 相对路径：scripts/backup.js 等脚本用裸 node 也会 import 到这里，认不得 $lib
import { WATCH_STATUS } from '../constants.js';

export const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
export const isId = (v) => isInt(v, 1, Number.MAX_SAFE_INTEGER);
/** 评分 1.0–10.0，最多一位小数（8.4 可以，8.45 不行） */
const isScore = (v) => typeof v === 'number' && v >= 1 && v <= 10 && Math.abs(v * 10 - Math.round(v * 10)) < 1e-9;

export const ENTRY_CHECK = {
  status: (v) => Object.hasOwn(WATCH_STATUS, v),
  current_episode: (v) => v === null || isInt(v, 0, 100000),
  my_score: (v) => v === null || isScore(v),
  my_note: (v) => v === null || (typeof v === 'string' && v.length <= 2000)
};

/** 8.4 进来可能是 8.399999…，存之前规整到一位小数 */
export const normScore = (v) => (v === null ? null : Math.round(v * 10) / 10);

export const TRIAGE_VERDICTS = ['seen', 'not_seen', 'never_heard', 'skipped'];
