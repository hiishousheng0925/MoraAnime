<script>
  /**
   * 统计页的图表面板：.card 底 + 标题行（标题 · 口径附注 · 右侧摘要）。
   * 每个图表一块，形成节奏 —— 原来图表直接铺在页面底色上，一屏里分不出哪块是哪块。
   *
   * props
   *   title     标题
   *   hint      标题后的弱色口径附注（「看过的 336 部」），极短
   *   side      右侧摘要 snippet（「最长连续 9 天」）
   *   cls       附加 class（网格里占几列等）
   *   children  内容
   */
  let { title, hint = null, side = null, cls = '', children } = $props();
</script>

<section class="card min-w-0 rounded-2xl px-4 pb-4 pt-3.5 sm:px-5 sm:pb-5 sm:pt-4 {cls}">
  <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
    <h2 class="text-[15px] font-semibold text-ink-100">{title}</h2>
    {#if hint}<span class="text-[12px] text-ink-400">{hint}</span>{/if}
    {#if side}<div class="ml-auto text-[12px] text-ink-400">{@render side()}</div>{/if}
  </div>
  {@render children()}
</section>
