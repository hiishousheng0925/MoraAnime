<script>
  /**
   * 「重置」按钮 —— 样式只在这里定义一份。
   *
   * 两种形态：目录页是链接（回到没有参数的 URL），快速标记页是动作（要先弹确认框）。
   * 分开各写一份的结果是快速标记那个写成了 rounded-full 的椭圆，和目录页的方角对不上。
   */
  import { BAR_BOX } from './bar.js';
  let { href = null, onclick = null, disabled = false, label = '重置' } = $props();

  // 尺寸和筛选胶囊同一份（BAR_BOX），同排放着时上下边要齐
  const CLS = `flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 ${BAR_BOX} border-ink-600 bg-ink-900`
    + ' text-ink-200 hover:border-danger/60 hover:text-danger'
    + ' disabled:opacity-40 disabled:hover:border-ink-600 disabled:hover:text-ink-200';
</script>

{#snippet icon()}
  <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" stroke="currentColor"
       stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
    <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2v3h-3" />
  </svg>
{/snippet}

{#if href}
  <a {href} {onclick} class={CLS}>{@render icon()}{label}</a>
{:else}
  <button type="button" {onclick} {disabled} class={CLS}>{@render icon()}{label}</button>
{/if}
