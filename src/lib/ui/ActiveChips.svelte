<script>
  /**
   * 「已生效筛选」一行胶囊，逐项可删。目录页和番单页共用 ——
   * 原来两页各写一份，番单那份是文字 ✕、没有 aria-label，读屏只念出「恋爱 ✕」。
   *
   * chips: [{ k, text, tone?: 'danger', off }]
   * muted: 搜索时筛选没生效，跟着筛选栏一起置灰；inert 让键盘也 Tab 不进来
   * 手机上单行横滑 + 两侧渐隐（同筛选栏）。
   */
  import X from 'phosphor-svelte/lib/X';
  import { edgeFade } from '$lib/edgeFade.js';
  let { chips = [], muted = false } = $props();
</script>

{#if chips.length}
  <div use:edgeFade inert={muted || undefined}
       class="mt-2 flex flex-wrap items-center gap-1.5
              max-sm:-mx-4 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:overscroll-x-contain max-sm:px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden
              {muted ? 'pointer-events-none opacity-40' : ''}">
    {#each chips as c (c.k)}
      <button onclick={c.off} aria-label="移除 {c.text}"
              class="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border py-1 pl-3 pr-2 text-[12px] transition
                     {c.tone === 'danger' ? 'border-danger/40 bg-danger/10 text-danger hover:border-danger'
                                          : 'border-accent/40 bg-accent/10 text-accent-ink hover:border-accent'}">
        {c.text}<X size={12} weight="bold" aria-hidden="true" />
      </button>
    {/each}
  </div>
{/if}
