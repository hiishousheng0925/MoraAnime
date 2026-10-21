/**
 * 每日同步要不要顺手跑月度那三步（mark-nsfw / build-franchise / reindex-fts）。
 * 从 sync-all.js 顶层抽出来，单测才测得到（2026-10-21 审核：这段逻辑原来一 import 就会跑整轮同步）。
 *
 * meta.last_monthly_at 缺失、或者是坏值（Date.parse 得 NaN）都当作该跑了 ——
 * 原来坏值算出 NaN >= 30 为假，月度会永远不再跑，而且没有任何提示。
 */
export const MONTHLY_DAYS = 30;

export function monthlyDue(lastIso, now = Date.now(), days = MONTHLY_DAYS) {
  if (!lastIso) return true;
  const t = Date.parse(lastIso);
  return Number.isNaN(t) || (now - t) / 86400000 >= days;
}

/** --monthly 强制跑，--no-monthly 强制不跑（排查用），否则看是否到期 */
export function planMonthly(lastIso, argv = [], now = Date.now()) {
  const forced = argv.includes('--monthly');
  if (argv.includes('--no-monthly')) return { monthly: false, forced };
  return { monthly: forced || monthlyDue(lastIso, now), forced };
}
