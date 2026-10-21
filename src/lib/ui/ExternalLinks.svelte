<script>
  /**
   * 详情页「外部条目」：Bangumi / MAL / AniList 三个主站是带首字母方块的大按钮（SITE_MAIN），其余收进「更多 N」。
   * 按站分组：两条 AOD 记录折成一部番时，同一个站会带进两个不同条目（ANN 37931 / 37932），
   * 原来并排两个一模一样的「animenewsnetwork.com」。每站一个按钮，其余条目跟小序号。
   *
   * props
   *   links       [{ site, url }]（anime_source）
   *   bangumiUrl  Bangumi 条目地址；没有就不显示
   */
  import CaretDown from 'phosphor-svelte/lib/CaretDown';
  import { SITE_SHORT, SITE_MAIN } from '$lib/constants.js';
  let { links = [], bangumiUrl = null } = $props();

  const groups = $derived.by(() => {
    const m = new Map();
    for (const l of links) (m.get(l.site) ?? m.set(l.site, []).get(l.site)).push(l.url);
    return m;
  });
  const main = $derived(SITE_MAIN.map(([site, name, ch, color]) => ({
    site, name, ch, color, urls: site === 'bangumi' ? (bangumiUrl ? [bangumiUrl] : []) : (groups.get(site) ?? [])
  })).filter((x) => x.urls.length));
  const more = $derived([...groups].filter(([site]) => !SITE_MAIN.some(([s]) => s === site)));
  let open = $state(false);
  // 同系列里点进另一部时收起（组件不重建）；按内容判断，改状态后 invalidateAll 换了数组不算换番
  const key = $derived(bangumiUrl ?? links[0]?.url);
  $effect(() => { key; open = false; });
</script>

<div class="flex flex-wrap items-center gap-2">
  {#each main as x (x.site)}
    <span class="inline-flex h-10 items-stretch overflow-hidden rounded-xl border border-ink-700 bg-ink-900 text-[14px]
                 transition hover:border-ink-600">
      <a href={x.urls[0]} target="_blank" rel="noreferrer"
         class="inline-flex items-center gap-2 pl-1.5 pr-3.5 font-medium text-ink-100 hover:text-accent">
        <span class="grid size-7 place-items-center rounded-lg text-[13px] font-bold text-white"
              style:background={x.color} aria-hidden="true">{x.ch}</span>{x.name}
      </a>
      {#each x.urls.slice(1) as u, i (u)}
        <a href={u} target="_blank" rel="noreferrer" aria-label="{x.name} 第 {i + 2} 个条目"
           class="inline-flex items-center border-l border-ink-700 px-2.5 tabular-nums text-ink-400 hover:text-ink-100">{i + 2}</a>
      {/each}
    </span>
  {/each}
  {#if more.length}
    <button onclick={() => (open = !open)} aria-expanded={open}
            class="inline-flex h-10 items-center gap-1 rounded-xl px-3 text-[13px] text-ink-400 transition hover:bg-ink-800 hover:text-ink-100">
      {open ? '收起' : `更多 ${more.length}`}<CaretDown size={12} class="transition {open ? 'rotate-180' : ''}" aria-hidden="true" />
    </button>
  {/if}
</div>
{#if open}
  <div class="mt-2.5 flex flex-wrap gap-1.5">
    {#each more as [site, urls] (site)}
      <span class="inline-flex overflow-hidden rounded-lg bg-ink-800 text-[13px]">
        <a href={urls[0]} target="_blank" rel="noreferrer" title={site}
           class="px-3 py-1.5 text-ink-200 hover:bg-ink-700 hover:text-ink-100">{SITE_SHORT[site] ?? site}</a>
        {#each urls.slice(1) as u, i (u)}
          <a href={u} target="_blank" rel="noreferrer" aria-label="{SITE_SHORT[site] ?? site} 第 {i + 2} 个条目"
             class="border-l border-ink-700 px-2 py-1.5 tabular-nums text-ink-400 hover:bg-ink-700 hover:text-ink-100">{i + 2}</a>
        {/each}
      </span>
    {/each}
  </div>
{/if}
