<script>
  /**
   * 双滑块区间条：一根轨道、两个滑块。
   *
   * 原生 <input type="range"> 只有一个滑块，所以叠两条透明的 range 在同一根轨道上：
   * 轨道本身 pointer-events:none，只有滑块（::-webkit-slider-thumb）收事件，
   * 这样两条 input 互不遮挡。选中区间是自己画的那一段。
   *
   * 起点永远不会超过终点：两个回调里各自夹一次，拖过头就顶住不动。
   */
  let { min = 0, max = 100, from = 0, to = 100, disabled = false, onchange } = $props();

  const pct = (v) => ((v - min) / Math.max(1, max - min)) * 100;
  const set = (which, raw) => {
    const v = Math.max(min, Math.min(max, Math.round(+raw) || min));
    onchange?.(which === 'from' ? { from: Math.min(v, to), to } : { from, to: Math.max(v, from) });
  };
</script>

<div class="relative h-5 select-none">
  <!-- 轨道 -->
  <div class="absolute inset-x-0 top-2 h-1.5 rounded-full bg-ink-700"></div>
  <!-- 选中区间 -->
  <div class="absolute top-2 h-1.5 rounded-full bg-accent"
       style="left:{pct(from)}%; right:{100 - pct(to)}%"></div>

  {#each ['from', 'to'] as which}
    <input type="range" {min} {max} step="1" {disabled}
           value={which === 'from' ? from : to}
           aria-label={which === 'from' ? '起始年份' : '结束年份'}
           oninput={(e) => set(which, e.currentTarget.value)}
           class="pointer-events-none absolute inset-x-0 top-0 h-5 w-full appearance-none bg-transparent
                  [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4
                  [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full
                  [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-ink-900
                  [&::-moz-range-thumb]:bg-accent
                  [&::-webkit-slider-runnable-track]:h-5 [&::-webkit-slider-runnable-track]:bg-transparent
                  [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4
                  [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full
                  [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-ink-900
                  [&::-webkit-slider-thumb]:bg-accent
                  {which === 'from' && from >= max ? 'z-20' : which === 'to' ? 'z-10' : ''}" />
  {/each}
</div>
