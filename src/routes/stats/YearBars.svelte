<script>
  /**
   * 作品年份分布（按番剧年份，不是观看年份 —— 我们没有历史观看日期）。
   * 空年份补齐（08 → 10 中间缺 09 时柱距均匀会看着像连续的）；柱子 flex-1 撑满面板。
   * 峰值那根用强调色实心 + 柱顶「2022 · 59 部」，其余是淡一档的竖向渐变；每根悬停有 title。
   * 峰值靠近左右边时标签往里贴，不出面板（手机上原来最右几根被裁掉，根因是外层网格列被热力图撑宽，见 +page）。
   */
  import Panel from './Panel.svelte';
  let { byYear, peakYear, hint } = $props();

  const years = $derived.by(() => {
    if (!byYear.length) return [];
    const m = new Map(byYear.map((r) => [r.year, r.c]));
    const lo = Math.min(...m.keys()), hi = Math.max(...m.keys());
    return Array.from({ length: hi - lo + 1 }, (_, i) => ({ year: lo + i, c: m.get(lo + i) ?? 0 }));
  });
  const max = $derived(Math.max(1, ...years.map((r) => r.c)));
  const step = $derived(years.length > 24 ? 3 : years.length > 12 ? 2 : 1);
  const peakIdx = $derived(years.findIndex((r) => r.year === peakYear?.year));
  const align = $derived(peakIdx < 2 ? 'left-0' : peakIdx > years.length - 3 ? 'right-0' : 'left-1/2 -translate-x-1/2');
</script>

<Panel title="作品年份分布" {hint}>
  <div class="mt-7 flex h-[132px] items-end gap-[3px] sm:gap-1">
    {#each years as r, i (r.year)}
      <div class="relative flex h-full min-w-0 flex-1 items-end" title="{r.year}：{r.c} 部">
        {#if i === peakIdx}
          <div class="absolute -top-5 whitespace-nowrap text-[11px] font-semibold text-accent-ink {align}"
               data-stat="peak-year">{r.year} · {r.c} 部</div>
        {/if}
        <div class="w-full rounded-t-[4px] rounded-b-[1px] transition-[filter] duration-150 hover:brightness-125
                    {i === peakIdx ? 'bg-linear-to-b from-accent to-accent/60 shadow-[0_0_14px_-3px_var(--c-accent)]'
                      : r.c ? 'bg-linear-to-b from-accent/55 to-accent/20' : 'bg-ink-700/60'}"
             style="height:{(r.c / max) * 100}%; min-height:2px"></div>
      </div>
    {/each}
  </div>
  <div class="mt-1.5 flex gap-[3px] text-[10px] leading-none text-ink-400 sm:gap-1">
    {#each years as r, i (r.year)}
      <span class="min-w-0 flex-1 text-center {i === peakIdx ? 'font-semibold text-accent-ink' : ''}">
        {i % step === 0 || i === peakIdx ? String(r.year).slice(2) : ''}
      </span>
    {/each}
  </div>
</Panel>
