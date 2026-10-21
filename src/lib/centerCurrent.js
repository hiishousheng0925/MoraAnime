/**
 * 横滑条里把选中项滚到中间（Svelte action）：`<nav use:centerCurrent={key} class="overflow-x-auto …">`。
 * 选中项认 aria-current（页签写 "page"、日历条写 "true"）；key 变了（导航后）重新对一次。
 * 只在容器真溢出时动 —— 桌面上整条放得下，不该被滚。
 * 用在：番单页签（「弃番」在最右边看不到）、季度浏览的季度切换条、放送表日历条。原来三页各写一份。
 */
export function centerCurrent(node, _key) {
  const go = () => {
    const on = node.querySelector('[aria-current]:not([aria-current="false"])');
    if (on && node.scrollWidth > node.clientWidth)
      node.scrollLeft = on.offsetLeft - (node.clientWidth - on.offsetWidth) / 2;
  };
  go();
  return { update: go };
}
