<script>
  /**
   * 系列聚合视图。
   * 数据来自 franchise_member（已算好播出顺序 + 总集篇可跳过标记）。
   * ⚠️ 只有「播出顺序」—— 剧情顺序需要 AniList 的 relationType，等 API 恢复。
   *
   * 序号按「显示出来的」条目连续编（2026-10 UI 大改）：原来直接印 release_order，
   * 藏起可跳过的条目后就成了 1、2、6 跳号。顺序本身还是 release_order / user_order 排的。
   */
  import Cover from '$lib/Cover.svelte';
  import { TYPE_CN, WATCH_STATUS, SEASON_CN } from '$lib/constants.js';
  import { dispTitle, yearText } from '$lib/format.js';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  let { items = [], currentId = null, franchise = null, hasCustomOrder = false } = $props();

  let hideSkippable = $state(true);
  let editOrder = $state(false);
  let busy = $state(false);

  async function order(id, op) {
    busy = true;
    await fetch('/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, op }) });
    busy = false;
    await invalidateAll();
  }
  const skippable = $derived(items.filter((r) => r.is_skippable).length);
  const shown = $derived(hideSkippable ? items.filter((r) => !r.is_skippable || r.id === currentId) : items);
  const done = $derived(items.filter((r) => r.my_status === 'completed').length);
  const main = $derived(items.filter((r) => !r.is_skippable).length);
  const admin = $derived(page.data.user?.role === 'admin');
  /** 摘要行：顺序口径并进来（原来单独占一行） */
  const headline = $derived([hasCustomOrder ? '自定义顺序' : '播出顺序', `共 ${items.length} 部`,
    main !== items.length ? `正片 ${main}` : null].filter(Boolean).join(' · '));
  const line = (r) => [`${yearText(r)}${SEASON_CN[r.season] ? ` ${SEASON_CN[r.season]}` : ''}`, TYPE_CN[r.type] ?? r.type,
    r.episodes ? `${r.episodes} 集` : null].filter(Boolean).join(' · ');
  const LINK = 'text-[13px] text-accent hover:underline';
</script>

<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-400">
  <span>{headline}{' · 已看完 '}<b class="font-semibold text-ink-100">{done}</b></span>
  {#if skippable}
    <button onclick={() => (hideSkippable = !hideSkippable)} class={LINK}>
      {hideSkippable ? `显示可跳过（${skippable}）` : '隐藏可跳过'}
    </button>
  {/if}
  <!-- 系列顺序是全站一份的公共修正，只有管理员能调（多账号，2026-10-19） -->
  {#if items.length > 1 && admin}
    <button onclick={() => (editOrder = !editOrder)} class={LINK}>{editOrder ? '完成调序' : '调整顺序'}</button>
  {/if}
  {#if hasCustomOrder && admin}
    <button onclick={() => order(currentId, 'reset')} disabled={busy} class="text-[13px] text-ink-400 hover:text-ink-200">
      恢复播出顺序
    </button>
  {/if}
</div>

<ol class="mt-3 grid gap-2 lg:grid-cols-2">
  {#each shown as r, i (r.id)}
    {@const cur = r.id === currentId}
    <li class="flex min-w-0 items-center gap-1.5">
      {#if editOrder}
        <div class="flex shrink-0 flex-col gap-0.5">
          <button onclick={() => order(r.id, 'up')} disabled={busy || i === 0} aria-label="上移"
                  class="h-6 w-7 rounded border border-ink-600 bg-ink-900 text-[10px] text-ink-400 disabled:opacity-30">▲</button>
          <button onclick={() => order(r.id, 'down')} disabled={busy || i === shown.length - 1} aria-label="下移"
                  class="h-6 w-7 rounded border border-ink-600 bg-ink-900 text-[10px] text-ink-400 disabled:opacity-30">▼</button>
        </div>
      {/if}
      <a href="/anime/{r.id}" class:is-current={cur} aria-current={cur ? 'page' : undefined}
         class="group flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-ink-700 bg-ink-900 py-2 pl-2.5 pr-3
                transition hover:border-ink-600 {r.is_skippable && !cur ? 'opacity-65' : ''}">
        <span class="w-6 shrink-0 text-center text-[13px] font-semibold tabular-nums {cur ? 'text-accent-ink' : 'text-ink-400'}">{i + 1}</span>
        <Cover a={r} cls="aspect-2/3 w-14 shrink-0 rounded-md" />
        <div class="min-w-0 flex-1">
          <div class="line-clamp-2 text-[14px] leading-snug {cur ? '' : 'font-medium text-ink-100'}">{dispTitle(r)}</div>
          <div class="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12px] font-normal text-ink-400">
            <span>{line(r)}</span>
            {#if r.bgm_score}<span class="font-semibold text-warm">★ {r.bgm_score.toFixed(1)}</span>{/if}
            {#if r.is_skippable}<span title={r.skip_reason}>· 可跳过</span>{/if}
          </div>
        </div>
        {#if r.my_status}
          <span class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent-ink">
            {WATCH_STATUS[r.my_status]}{#if r.my_status === 'watching' && r.current_episode} {r.current_episode}{/if}
          </span>
        {/if}
      </a>
    </li>
  {/each}
</ol>
{#if franchise && franchise.name}
  <p class="mt-3 text-[12px] text-ink-400">系列：{franchise.name}</p>
{/if}
