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
