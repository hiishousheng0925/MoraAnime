import { goto } from '$app/navigation';
import { buildHref } from './urlBuild.js';

// 纯拼装函数在 urlBuild.js（可在 Node 里单元测试），这里只加导航
export { makeHref, buildHref, toggleIn } from './urlBuild.js';

/** 把筛选状态写回 URL 并导航。目录页和番单页原本各写了一份一模一样的 set()。 */
export function makeSetter(base, current, opts = {}) {
  return (patch, { resetPage = true } = {}) => {
    goto(buildHref(base, current, patch, { resetPage, ...opts }), { keepFocus: true });
  };
}
