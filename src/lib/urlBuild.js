/**
 * 纯 URL 拼装 —— 不依赖 SvelteKit runtime，所以可以在 Node 里直接单元测试。
 * 需要导航的 makeSetter 在 urlState.js（它要 import $app/navigation）。
 */

/**
 * 生成 URL，不导航 —— 给 <a href> 用。
 *
 * 为什么筛选项用链接而不是按钮 + goto()：
 * 客户端曾出现「URL 变了、高亮落后一次导航」。用真链接后导航本身就带来
 * 正确的 HTML，不依赖客户端响应式；附带可中键新开标签、可复制分享。
 */
export function buildHref(base, current, patch, { resetPage = true } = {}) {
  const p = new URLSearchParams(current);
  for (const [k, v] of Object.entries(patch)) {
    p.delete(k);
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else if (v !== null && v !== undefined && v !== '') p.set(k, v);
  }
  // 改筛选要回到第 1 页；但 patch 里显式给了 p（翻页）时不能再删掉它 ——
  // 早先无条件 delete('p') 发生在 set 之后，把刚设的页码又抹了，
  // 表现为「点下一页还是第一页」。
  if (resetPage && !('p' in patch)) p.delete('p');
  const q = p.toString();
  return q ? `${base}?${q}` : base;
}

export const makeHref = (base, current, opts) => (patch) => buildHref(base, current, patch, opts);

/** 数组型筛选值的开关 */
export const toggleIn = (arr, v) =>
  (arr ?? []).includes(v) ? arr.filter((x) => x !== v) : [...(arr ?? []), v];

/**
 * 把题材 g 放进 target 槽位（'g' 全部包含 / 'any' 任一 / 'ng' 排除），并从其他槽位移除 ——
 * 同一题材只能在一个槽位。已经在 target 里就是移除。返回 URL patch。
 * f 是 loader 给的筛选状态（genres / genresAny / genresNot）。目录页和番单页原来各抄一份。
 */
export function moveGenre(f, target, g) {
  const cur = { g: f.genres, any: f.genresAny, ng: f.genresNot };
  const has = cur[target].includes(g);
  const out = {};
  for (const k of ['g', 'any', 'ng']) out[k] = cur[k].filter((x) => x !== g);
  if (!has) out[target] = [...out[target], g];
  return { g: out.g, any: out.any, ng: out.ng };
}

/** 题材胶囊上的摘要：`A+B (C|D) −E,F`，超过 18 字截断；没有题材条件时 null */
export function genreSummary(f) {
  const parts = [];
  if (f.genres.length) parts.push(f.genres.join('+'));
  if (f.genresAny.length) parts.push(`(${f.genresAny.join('|')})`);
  if (f.genresNot.length) parts.push(`−${f.genresNot.join(',')}`);
  const t = parts.join(' ');
  return t ? (t.length > 18 ? t.slice(0, 17) + '…' : t) : null;
}
