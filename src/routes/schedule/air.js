/**
 * 放送表的放送进度文案。输入是 queries/schedule.js 的 airInfo 结果（aired / airsToday / startsIn / finished）。
 * 单独成文件是为了能单测（tests/unit/schedule.test.js）。
 *
 * ⚠️ 「已播完」只认 airInfo 给的 finished，不再自己拿 aired >= episodes 推：
 * 连载长番的 episodes 是快照时的已播集数，航海王因此显示过「已播完 · 共 1168 集」。
 */

/** 卡片 / 主卡上的一行完整文字 */
export function airText(a) {
  if (a.startsIn != null) return a.startsIn === 1 ? '明天开播' : `${a.startsIn} 天后开播`;
  if (!a.aired) return null;
  if (a.finished) return '已播完';
  if (a.airsToday) return `今天 第 ${a.aired} 集`;
  return `已更新至第 ${a.aired} 集`;
}

/** 海报左下角的短角标（窄卡放不下整句） */
export function airBadge(a) {
  if (a.startsIn != null) return a.startsIn === 1 ? '明天开播' : `${a.startsIn} 天后`;
  if (!a.aired) return null;
  if (a.finished) return '已完结';
  return `第 ${a.aired} 集`;
}
