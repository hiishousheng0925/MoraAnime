<script>
  /**
   * 进度控件。长番（几百集）逐次点 +1 不可行，所以主控件是拖动条；
   * ±1 保留给微调。拖动时只更新显示，松手才提交。
   * aired：连载中已播到第几集（#98）—— 拖动条上限按它，总集数另外标出；±1 不拦（先行版、数据晚一天时还能记）
   */
  let { current = 0, total = null, aired = null, disabled = false, onset, onbump } = $props();
  /** 拖动条的上限：连载中 = 已播集数，完结 = 总集数 */
  const max = $derived(aired != null && (!total || aired < total) ? Math.max(aired, current ?? 0) : total);

  let dragging = $state(false);
  let temp = $state(0);
  const shown = $derived(dragging ? temp : (current ?? 0));
  const pct = $derived(max ? Math.min(100, (shown / max) * 100) : 0);

  function commit(v) {
    dragging = false;
    const n = Math.max(0, Math.min(max ?? v, Math.round(v)));
    if (n !== (current ?? 0)) onset(n);
  }
</script>

<div class="flex items-center gap-3">
  <div class="min-w-0 flex-1">
    <div class="flex flex-wrap items-baseline gap-2 text-sm">
      <span class="text-ink-400">进度</span>
      {#if current == null && !dragging}
        <span class="text-ink-400">未填{#if total} / 共 {total} 集{/if}</span>
      {:else}
        <b class="tabular-nums">{shown}</b><span class="text-ink-400">/ {max ?? '?'}</span>
        {#if max !== total && total}<span class="text-[12px] text-ink-400">已播 · 共 {total} 集</span>{/if}
      {/if}
    </div>

    {#if max}
      <div class="relative mt-2 h-5">
        <div class="absolute inset-x-0 top-2 h-1.5 overflow-hidden rounded bg-ink-700">
          <div class="h-full bg-accent" style="width:{pct}%"></div>
        </div>
        <input type="range" min="0" max={max} step="1" value={shown} {disabled}
               oninput={(e) => { dragging = true; temp = +e.currentTarget.value; }}
               onchange={(e) => commit(+e.currentTarget.value)}
               aria-label="观看进度"
               class="absolute inset-0 w-full cursor-pointer appearance-none bg-transparent
                      [&::-webkit-slider-runnable-track]:h-5 [&::-webkit-slider-runnable-track]:bg-transparent
                      [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4
                      [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full
                      [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-accent
                      [&::-webkit-slider-thumb]:bg-ink-900
                      [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4
                      [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2
                      [&::-moz-range-thumb]:border-accent [&::-moz-range-thumb]:bg-ink-900" />
      </div>
    {/if}
  </div>

  <div class="flex shrink-0 items-center gap-1.5">
    <button onclick={() => onbump(-1)} {disabled} aria-label="减一集"
            class="h-9 w-9 rounded-lg border bg-ink-900 border-ink-600 text-ink-400 active:scale-95 disabled:opacity-50">−</button>
    <button onclick={() => onbump(1)} {disabled} aria-label="加一集"
            class="h-10 w-12 rounded-lg bg-accent font-semibold text-on-accent active:scale-95 disabled:opacity-50">+1</button>
  </div>
</div>
