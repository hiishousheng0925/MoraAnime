<script>
  /**
   * 观看页的选集（集号来自片源站）。
   * 有 Bangumi 分集数据时每集一行：集号 + 中文标题 + 播出日期（主人 2026-10-19：分集信息放这里，不放详情页；
   * 不要「看过打勾」「未播出灰掉」—— 已看的只是文字淡一点）。没有分集数据就是数字格。
   * 2026-10 UI 大改：无边框行；集号只写数字；标题放不下就截断（完整标题在 title 里，当前集折行显示全）；
   * 当前集用 .is-current（左竖条 + 淡底），右侧「播放中」均衡器替代日期；列表底部渐隐。
   * 当前集换了就把它滚进列表可见范围（只在列表自己能滚时 —— 手机上列表跟着页面走，不去动页面滚动）。
   * jump = 这个片源只能跳转原站：点了在新标签打开，并记进度（由父组件处理）
   * roads / road / onroad：线路。桌面是标题行右侧的下拉，手机是一行横滑胶囊；只有 1 条不显示
   * loading = 还在搜索 / 取剧集：画 8 行骨架
   */
  import { epTitle } from '$lib/format.js';
  import Select from '$lib/ui/Select.svelte';
  let { eps = [], info = [], epNo, roads = [], road = 0, onroad, curI = null, progress = 0, jump = false, loading = false, onplay, onjump } = $props();

  /** 第 N 集（片源站的集号）→ Bangumi 那一集（按序号对上） */
  const byN = $derived(new Map(info.map((e) => [e.n, e])));
  const rich = $derived(eps.some((ep, i) => byN.has(epNo(ep, i))));
  const md = (d) => (d ? d.slice(5).replace('-', '/') : '');

  let list = $state(null);
  $effect(() => {
    const i = curI, el = list;
    if (i == null || !el || el.scrollHeight <= el.clientHeight + 1) return;
    const row = el.querySelector(`[data-i="${i}"]`);
    if (!row) return;
    const top = row.offsetTop - el.offsetTop, h = el.clientHeight;
    if (top < el.scrollTop + 8 || top + row.offsetHeight > el.scrollTop + h - 48) el.scrollTo({ top: Math.max(0, top - h / 3), behavior: 'smooth' });
  });
</script>

<div class="flex items-center gap-2 px-0.5 lg:px-1.5 lg:pt-1">
  <h2 class="text-[15px] font-semibold text-ink-100">选集</h2>
  {#if eps.length}<span class="text-[12px] tabular-nums text-ink-400">{eps.length}</span>{/if}
  {#if roads.length > 1}
    <div class="ml-auto max-sm:hidden">
      <Select opts={roads.map((rd, i) => [i, rd.name])} value={road} label="线路" w="8rem" onpick={(v) => onroad(+v)} />
    </div>
  {/if}
</div>
{#if roads.length > 1}
  <div class="no-scrollbar -mx-4 mt-2.5 flex gap-1.5 overflow-x-auto px-4 sm:hidden">
    {#each roads as rd, i (i)}
      <button onclick={() => onroad(i)} aria-pressed={road === i}
              class="tap shrink-0 whitespace-nowrap rounded-full border px-3.5 py-1 text-[12px] transition
                     {road === i ? 'border-accent bg-accent/15 font-medium text-accent-ink' : 'border-ink-600 text-ink-400'}">{rd.name}</button>
    {/each}
  </div>
{/if}
{#if loading && !eps.length}
  <div class="mt-2 flex flex-col gap-1" aria-hidden="true">
    {#each Array(8) as _, k (k)}
      <div class="flex items-center gap-2.5 px-2.5 py-2">
        <span class="h-3 w-5 shrink-0 animate-pulse rounded bg-ink-700"></span>
        <span class="h-3 animate-pulse rounded bg-ink-700" style="width:{[72, 58, 80, 64, 50, 76, 60, 68][k]}%"></span>
      </div>
    {/each}
  </div>
{:else if eps.length}
  <div bind:this={list}
       class="ep-list relative mt-1.5 min-h-0 flex-1 overflow-y-auto {rich ? 'flex flex-col gap-0.5' : 'grid grid-cols-5 content-start gap-1.5 sm:grid-cols-8 lg:grid-cols-5'}">
    {#each eps as ep, i (ep.url)}
      {@const n = epNo(ep, i)}
      {@const b = byN.get(n)}
      {@const on = curI === i}
      {@const t = rich ? epTitle(b) : ''}
      {@const cls = rich
        ? `tap flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition hover:bg-ink-800/80 ${n <= progress && !on ? 'text-ink-400' : 'text-ink-200'}`
        : `tap grid h-9 place-items-center rounded-lg text-[13px] font-medium tabular-nums transition ${on ? 'bg-accent text-on-accent' : `bg-ink-800/70 hover:bg-ink-700 ${n <= progress ? 'text-ink-400' : 'text-ink-200'}`}`}
      {#snippet body()}
        {#if rich}
          <span class="w-6 shrink-0 text-right text-[12px] font-semibold tabular-nums {on ? 'text-accent-ink' : 'text-ink-400'}">{n}</span>
          <span class="min-w-0 flex-1 {on ? 'leading-snug' : 'truncate'}">{t || ep.name}</span>
          {#if on}
            <span class="eq" title="播放中"><i></i><i></i><i></i><span class="sr-only">播放中</span></span>
          {:else if b?.airdate}<span class="shrink-0 text-[11px] tabular-nums text-ink-400">{md(b.airdate)}</span>{/if}
        {:else}{n}{/if}
      {/snippet}
      {#if jump}
        <a href={ep.url} target="_blank" rel="noopener noreferrer" data-i={i} data-ep={n} title={t || ep.name}
           class:is-current={on && rich} aria-current={on ? 'true' : undefined} onclick={() => onjump(i, n, ep)} class={cls}>{@render body()}</a>
      {:else}
        <button onclick={() => onplay(i)} data-i={i} data-ep={n} title={t || ep.name}
                class:is-current={on && rich} aria-current={on ? 'true' : undefined} class={cls}>{@render body()}</button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  /* 底部渐隐：最后几行淡出，暗示还能往下滚（桌面上列表才自己滚；留出底边让最后一集滚到底时能完整露出来） */
  @media (min-width: 1024px) {
    .ep-list {
      padding-bottom: 1.5rem;
      -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 2.5rem), transparent);
      mask-image: linear-gradient(to bottom, #000 calc(100% - 2.5rem), transparent);
    }
  }
  /* 「播放中」均衡器：三根竖条错拍起伏；减少动态效果时静止成高低三根 */
  .eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; flex-shrink: 0; }
  .eq i { width: 3px; border-radius: 1px; background: var(--c-accent); animation: eq 0.9s ease-in-out infinite alternate; }
  .eq i:nth-child(1) { height: 50%; animation-delay: -0.3s; }
  .eq i:nth-child(2) { height: 100%; animation-delay: -0.6s; }
  .eq i:nth-child(3) { height: 70%; }
  @keyframes eq { from { transform: scaleY(0.35); } to { transform: scaleY(1); } }
  .eq i { transform-origin: bottom; }
  @media (prefers-reduced-motion: reduce) { .eq i { animation: none; } }
</style>
