/**
 * 统计页「记录活动」热力图的纯函数（#105，拆出来单测）。
 */

/** 本地日期 YYYY-MM-DD —— 和服务端 date(watched_at,'localtime') 对齐；toISOString 是 UTC，本地 0–8 点会错位一天 */
export const localKey = (t) =>
  `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;

/**
 * 近 n 周，一周一列、周一在上；最后一列是今天所在的这一周，今天之后的格子 future = true（不画）
 * @param {Date} now
 * @param {Map<string, number>} counts 日期 → 记录次数
 * @returns {{ key: string, c: number, future: boolean }[][]}
 */
export function heatWeeks(now, counts, n = 26) {
  const today = localKey(now);
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const out = [];
  for (let w = n - 1; w >= 0; w--) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const t = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - w * 7 + d);
      const key = localKey(t);
      col.push({ key, c: counts.get(key) ?? 0, future: key > today });
    }
    out.push(col);
  }
  return out;
}

/** 有记录那些天的 25 / 50 / 75 分位数：深浅按它分档，不被批量导入的单日极值主导 */
export function heatCuts(values) {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return [1, 1, 1];
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return [q(0.25), q(0.5), q(0.75)];
}

/** 0 = 没记录；1–4 档。只有一两个不同数值时也能分出深浅 */
export function heatLevel(c, [a, b, d]) {
  if (!c) return 0;
  return c > d ? 4 : c > b ? 3 : c > a ? 2 : 1;
}

/** 升序 YYYY-MM-DD 列表里逐日相连的最长天数。按 UTC 午夜解析日期串，不受夏令时影响 */
export function longestRun(dates) {
  let best = 0, run = 0, prev = null;
  for (const d of dates) {
    const t = Date.parse(`${d}T00:00:00Z`);
    run = prev != null && t - prev === 86400000 ? run + 1 : 1;
    if (run > best) best = run;
    prev = t;
  }
  return best;
}
