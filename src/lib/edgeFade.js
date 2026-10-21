/**
 * 横滑容器的两侧渐隐（Svelte action）：`<div use:edgeFade class="overflow-x-auto …">`。
 * 只在那一侧还有内容时才渐隐 —— 滚到底时最后一项不该被遮罩吃掉一半；
 * 容器没溢出（桌面上 flex-wrap 换行）时不加任何遮罩。
 * 用在：目录 / 季度浏览的手机筛选栏、季度切换条。
 */
export function edgeFade(node) {
  const upd = () => {
    const l = node.scrollLeft > 2;
    const r = node.scrollLeft + node.clientWidth < node.scrollWidth - 2;
    const m = !l && !r ? ''
      : `linear-gradient(to right, ${l ? 'transparent, #000 24px' : '#000'}, ${r ? '#000 calc(100% - 40px), transparent' : '#000'})`;
    node.style.maskImage = m;
    node.style.webkitMaskImage = m;
  };
  upd();
  const ro = new ResizeObserver(upd);
  ro.observe(node);
  node.addEventListener('scroll', upd, { passive: true });
  return { destroy() { ro.disconnect(); node.removeEventListener('scroll', upd); } };
}
