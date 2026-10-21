<script>
  /**
   * 「返回上一页」按钮。原来是 12px 灰字「← 返回」，不像能点（主人 2026-10-19）。
   * 现在是一个带箭头图标的小按钮：有边框、悬停变强调色，一眼看得出是控件。
   * 给 href 就是链接（可中键新标签打开），只给 onclick 就是按钮。
   */
  import ArrowLeft from 'phosphor-svelte/lib/ArrowLeft';
  let { href = null, onclick = null, children } = $props();
  const CLS = 'tap inline-flex items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-900 px-2.5 py-1 text-[13px] font-medium text-ink-200 transition hover:border-accent hover:text-accent';
</script>

{#if href}
  <a {href} {onclick} class={CLS}><ArrowLeft size={14} weight="bold" />{@render children()}</a>
{:else}
  <button type="button" {onclick} class={CLS}><ArrowLeft size={14} weight="bold" />{@render children()}</button>
{/if}
