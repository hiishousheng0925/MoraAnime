<script>
  import CardGrid from '$lib/ui/CardGrid.svelte';
  import Chip from '$lib/ui/Chip.svelte';
  import { WATCH_OPTS } from '$lib/constants.js';
  import { page } from '$app/state';
  import Page from '$lib/ui/Page.svelte';
  import Pager from '$lib/ui/Pager.svelte';
  import { makeHref } from '$lib/urlState.js';
  let { data } = $props();
  const base = $derived(`/share/${page.params.token}`);
  const to = $derived(makeHref(base, page.url.searchParams));
</script>

<Page>
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <h1 class="text-xl font-semibold">番单分享</h1>
    <span class="text-[12px] text-ink-400">只读 · 共 {data.stats.total ?? 0} 部 · 累计 {data.stats.episodes ?? 0} 集</span>
  </div>

  <div class="no-scrollbar mt-3 flex gap-1.5 overflow-x-auto pb-1">
    {#each WATCH_OPTS as [v, l]}
      <Chip on={data.status === v} href="{base}?status={v}">{l} <span class="text-[11px]">{data.stats[v] ?? 0}</span></Chip>
    {/each}
  </div>

  {#if !data.rows.length}
    <p class="mt-10 text-center text-sm text-ink-400">这个分类是空的</p>
  {:else}
    <div class="mt-4"><CardGrid items={data.rows} showProgress /></div>
    <Pager page={data.page} pages={data.pages} {to} per={data.per} perIsDefault={data.perIsDefault} />
  {/if}
  <p class="mt-8 text-center text-[11px] text-ink-400">由 j-anime 生成 · 此页面只读</p>
</Page>
