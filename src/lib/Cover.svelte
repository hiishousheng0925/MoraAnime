<script>
  /**
   * 封面图。AOD 里所有条目都有 picture 字段，但老番的 MAL CDN 链接大量已失效
   * （1917 年那批全是死链）。所以必须处理加载失败，不能让页面出现破图图标。
   */
  import { dispTitle } from '$lib/format.js';
  let { a, cls = '', eager = false } = $props();
  // 走本地代理：首次请求抓取并落盘，之后读本地。cover_dead 的直接占位不发请求。
  const src = $derived(a.cover_dead ? null : (a.picture || a.thumbnail) ? `/cover/${a.id}` : null);
  // 记「哪个地址坏了」而不是一个布尔 —— 同一路由内换番（详情页点同系列）组件不重建，
  // 布尔会把上一部的坏图状态带给下一部
  let brokenSrc = $state(null);
  const broken = $derived(brokenSrc !== null && brokenSrc === src);
  const first = $derived(dispTitle(a).replace(/^[\s\W]+/, '').slice(0, 2) || '?');
</script>

<div class="cover relative overflow-hidden {cls}">
  {#if src && !broken}
    <img {src} alt={dispTitle(a)} loading={eager ? 'eager' : 'lazy'}
         onerror={() => (brokenSrc = src)}
         class="h-full w-full object-cover transition duration-300 group-hover:scale-105" />
  {:else}
    <!-- 死链兜底：不显示破图，用标题首字占位 -->
    <div class="flex h-full w-full flex-col items-center justify-center gap-1 bg-ink-800 p-1 text-center">
      <span class="text-ink-600 text-[15px] font-medium leading-tight">{first}</span>
      <span class="text-[11px] text-ink-700">无封面</span>
    </div>
  {/if}
</div>
