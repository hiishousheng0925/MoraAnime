<script>
  /**
   * 观看页下方的片源面板：去原站搜 · 当前片源 + 原站这一集 · 换片源（搜索框 + 各站结果）。
   * 从观看页拆出来（页面超 400 行）。状态都在观看页，这里只渲染、回调
   *
   * results：搜索结果 [{ site, hits: [{ name, url, score }], embed }]；pick：当前片源；cur：当前这一集
   * quality：各站清晰度（videoHeight）；isJump(r)：这个站只能跳转；sameName(x)：和这部番同名
   * 2026-10 UI 大改：半透明磨砂卡；当前片源 + 清晰度做成一枚胶囊（1080p 加粗）；换片源列表里当前站用 .is-current
   */
  import ArrowSquareOut from 'phosphor-svelte/lib/ArrowSquareOut';
  import { WATCH_AUTO_PICK } from '$lib/constants.js';
  let { watchLinks = [], results = null, pick = null, cur = null, quality = {}, searching = false,
        q = $bindable(''), open = $bindable(false), isJump, sameName, onsearch, onpick } = $props();

  const found = $derived((results ?? []).filter((r) => r.hits.length));
  /** 两组：最好那条对得上这一季的 / 只有别的季、别的作品的（#96：原来混排，灰字番名看不出是哪一季，
   *  连载中的番点进去拿到第一季的 12 集）。没有分数的（不带番剧 id 搜的）算对得上 */
  const matched = $derived(found.filter((r) => (r.hits[0].score ?? WATCH_AUTO_PICK) >= WATCH_AUTO_PICK));
  const others = $derived(found.filter((r) => (r.hits[0].score ?? WATCH_AUTO_PICK) < WATCH_AUTO_PICK));
  /** 搜索出错的站也列出来（折叠），不然一次抖动这个站就从列表里消失，看不出是站出了问题（主人 2026-10-20） */
  const failed = $derived((results ?? []).filter((r) => !r.hits.length && r.error));
  const errText = (e) => (/fetch failed/i.test(e) ? '连不上' : /timeout|aborted/i.test(e) ? '超时' : e);
  const qText = (h) => (h >= 2000 ? '4K' : h ? `${h}p` : '');
  const isCur = (site, h) => pick?.site === site && pick?.name === h.name;

  const PILL = 'tap inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-ink-700 bg-ink-800/60 px-3 py-1 text-[12px] text-ink-200 transition hover:border-accent hover:text-ink-100';
  const LABEL = 'mr-1 shrink-0 sm:mr-0 sm:w-14 text-[12px] text-ink-400';
</script>

<!-- 「去原站搜」在上、片源在下（主人 2026-10-19）：换片源展开后列表很长，原站链接压在最底下要滚很远 -->
<section class="glass rounded-2xl p-3.5 sm:p-4">
  {#if watchLinks.length}
    <div class="mb-3 flex items-center gap-1.5 border-b border-ink-700/70 pb-3">
      <span class={LABEL}>去原站搜</span>
      <div class="no-scrollbar -my-1 flex min-w-0 gap-1.5 overflow-x-auto py-1 sm:flex-wrap">
        {#each watchLinks as w (w.id)}
          <!-- noopener noreferrer 必须有：外站拿到 window.opener 能改写这个标签页 -->
          <a href={w.url} target="_blank" rel="noopener noreferrer" class={PILL}>{w.name}</a>
        {/each}
      </div>
    </div>
  {/if}
  <div class="flex flex-wrap items-center gap-1.5 text-[13px]">
    <span class={LABEL}>片源</span>
    {#if pick}
      <span data-site={pick.site} class="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-ink-700 bg-ink-800/60 px-3 py-1 text-[12px] text-ink-100">
        <span class="font-medium">{pick.site}</span>
        {#if quality[pick.site]}<span class="font-semibold tabular-nums text-accent-ink">{qText(quality[pick.site])}</span>{/if}
        {#if !sameName(pick.name)}<span class="truncate text-ink-400">{pick.name}</span>{/if}
      </span>
    {/if}
    <!-- 原站链接放这里，播放器里只给「重新加载」（主人 2026-10-20） -->
    {#if cur?.page}
      <a href={cur.page} target="_blank" rel="noopener noreferrer" class={PILL}>原站第 {cur.n} 集<ArrowSquareOut size={12} /></a>
    {/if}
    <button onclick={() => (open = !open)} disabled={!results} aria-expanded={open}
            class="{PILL} ml-auto font-medium disabled:opacity-40 {open ? 'border-accent' : ''}">
      {open ? '收起' : '换片源'}
    </button>
  </div>

  {#if open}
    <form onsubmit={(e) => { e.preventDefault(); if (q.trim()) onsearch(); }} class="mt-3.5 flex gap-2">
      <input bind:value={q} placeholder="片名"
             class="min-w-0 flex-1 rounded-lg border border-ink-600 bg-ink-900/80 px-3 py-1.5 text-[13px] outline-none focus:border-accent" />
      <button disabled={searching || !q.trim()}
              class="shrink-0 rounded-lg bg-accent px-4 py-1.5 text-[13px] font-medium text-on-accent disabled:opacity-40">
        {searching ? '搜索中' : '搜索'}
      </button>
    </form>
    <!-- 一站一行：站名 · 站内 / 跳转 · 清晰度。结果名和这部番同名就不再写一遍（原来 9 行都是同一个番名） -->
    {#snippet row(r)}
      {@const best = r.hits[0]}
      {@const rest = r.hits.slice(1, 6).filter((h) => h.score >= WATCH_AUTO_PICK)}
      {@const on = isCur(r.site, best)}
      <div class="flex flex-wrap items-center gap-1.5 py-0.5">
        <button onclick={() => onpick(r.site, best)} class:is-current={on} aria-current={on ? 'true' : undefined}
                class="tap flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-1.5 text-left transition hover:bg-ink-800/80 {on ? '' : 'text-ink-200'}">
          <span class="w-20 shrink-0 text-[13px] font-medium">{r.site}</span>
          {#if isJump(r)}<span class="rounded-full bg-warm/15 px-2 py-0.5 text-[11px] text-warm">跳转</span>
          {:else if r.embed != null}<span class="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] text-accent-ink">站内</span>{/if}
          {#if quality[r.site]}<span class="rounded-full bg-ink-700 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ink-200">{qText(quality[r.site])}</span>{/if}
          {#if best.score < WATCH_AUTO_PICK || !sameName(best.name)}
            <span class="truncate text-[12px] {best.score < WATCH_AUTO_PICK ? 'text-ink-400' : 'text-ink-200'}">{best.name}</span>
          {/if}
          {#if on}<span class="ml-auto shrink-0 text-[11px] text-accent-ink">当前</span>{/if}
        </button>
        {#each rest as h (h.url)}
          <button onclick={() => onpick(r.site, h)}
                  class="{PILL} {isCur(r.site, h) ? 'border-accent bg-accent/15 text-accent-ink' : ''}">{h.name}</button>
        {/each}
      </div>
    {/snippet}
    <div class="mt-3 divide-y divide-ink-700/60">
      {#each matched as r (r.site)}{@render row(r)}{/each}
    </div>
    {#if others.length}
      <h3 class="mt-3 border-t border-ink-700/70 px-3 pt-3 text-[12px] text-ink-400">其他季 / 相近作品</h3>
      <div class="mt-1 divide-y divide-ink-700/60">
        {#each others as r (r.site)}{@render row(r)}{/each}
      </div>
    {/if}
    {#if failed.length}
      <details class="mt-3 border-t border-ink-700/70 pt-2">
        <summary class="tap flex cursor-pointer items-center px-3 text-[12px] text-ink-400">搜索出错 {failed.length}</summary>
        <div class="mt-1 divide-y divide-ink-700/60">
          {#each failed as r (r.site)}
            <div class="flex items-center gap-2 px-3 py-1.5">
              <span class="w-20 shrink-0 text-[13px] font-medium text-ink-400">{r.site}</span>
              <span class="truncate text-[12px] text-ink-400">{errText(r.error)}</span>
            </div>
          {/each}
        </div>
      </details>
    {/if}
  {/if}
</section>

<style>
  /* 磨砂半透明卡（和选集侧栏同一种），叠在氛围光上 */
  .glass {
    background: color-mix(in srgb, var(--c-surface) 62%, transparent);
    border: 1px solid color-mix(in srgb, var(--c-border) 70%, transparent);
    box-shadow: var(--c-shadow);
    -webkit-backdrop-filter: blur(20px) saturate(1.3);
    backdrop-filter: blur(20px) saturate(1.3);
  }
</style>
