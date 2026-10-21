<script>
  /**
   * 筛选胶囊：常驻一行，点开只弹出这一类的选项面板。
   *
   * 为什么这么做：整块筛选面板展开约 700px 高，把结果推到屏幕外；
   * 收进「筛选」按钮里又变得找不到。胶囊 + 弹层两者兼顾 ——
   * 空闲只占一行，且每一类的当前值直接写在胶囊上。
   *
   * 手机（<640px）上面板改走底部抽屉 Sheet：
   * 筛选栏在手机上是单行横滑（overflow-x:auto），绝对定位的弹层会被它裁掉；
   * 而且挂在第 N 枚胶囊下的弹层在 390px 宽里必然右侧出屏、把整页撑出横向滚动（改前实测）。
   *
   * 三档外观（「默认在缩小结果」要看得出，但不能像「已经筛过」）：
   *   空闲          中性边框，只有标签
   *   默认在缩小结果 中性边框 + 弱色摘要 + 6px accent 小点（dflt=true，如目录默认的 TV·剧场版·OVA）
   *   用户改过      accent 边框 + accent/10 底 + 摘要
   */
  import Sheet from './Sheet.svelte';
  import { BAR_BOX } from './bar.js';
  import { media } from '$lib/media.svelte.js';

  /**
   * @param scroll 面板内是否滚动（只影响桌面弹层；Sheet 自己会滚）。
   * ⚠️ 面板里若嵌了 Select 之类的弹层，必须传 false ——
   * overflow-y:auto 会建立裁剪上下文，把嵌套弹层裁掉（表现为点了没反应）。
   */
  let { label, summary = null, count = 0, w = '22rem', align = 'left',
        scroll = false, children,
        /** 置灰并禁用。搜索时筛选默认不生效，灰掉才不会让人以为它还在起作用 */
        muted = false,
        /** 是否高亮成「改过」。缺省 = 有摘要或计数就高亮；排序胶囊在缺省状态也要写出「最新·人气」，但不该亮 */
        hot = null,
        /** 当前值是页面默认、但它确实在缩小结果 —— 显示弱色摘要 + 小点，而不是满蓝框 */
        dflt = false } = $props();

  let open = $state(false);
  let root = $state(null);
  let panel = $state(null);
  /** 桌面弹层越出视口右边时往左挪的距离 */
  let shift = $state(0);
  const has = $derived(hot ?? (count > 0 || summary != null));
  const active = $derived(!muted && has && !dflt);
  const quiet = $derived(!muted && has && dflt);

  function onDoc(e) { if (open && !media.mobile && !root?.contains(e.target)) open = false; }

  // 弹层贴着胶囊左边展开；胶囊靠右时会越出视口 → 量一次往回挪
  $effect(() => {
    if (!open || !panel || media.mobile) { shift = 0; return; }
    shift = 0;
    const r = panel.getBoundingClientRect();
    const over = r.right - (window.innerWidth - 12);
    if (over > 0) shift = Math.min(over, r.left - 12);
    else if (r.left < 12) shift = r.left - 12;
  });
</script>

<svelte:document onclick={onDoc} />
<svelte:window onkeydown={(e) => e.key === 'Escape' && !media.mobile && (open = false)} />

{#snippet body()}{@render children()}{/snippet}

<div bind:this={root} class="relative shrink-0 {muted ? 'pointer-events-none opacity-40' : ''}"
     aria-disabled={muted || undefined}>
  <!-- 底色和搜索框一致（bg-ink-900），否则透明胶囊看不出是可点的控件 -->
  <button type="button" onclick={() => (open = !open)} aria-expanded={open} aria-haspopup="dialog"
          class="flex items-center gap-1.5 whitespace-nowrap px-3 {BAR_BOX}
                 {open ? 'border-accent bg-ink-900 text-accent-ink'
                  : active ? 'border-accent bg-accent/10 text-accent-ink'
                  : 'border-ink-600 bg-ink-900 text-ink-200 hover:border-ink-400'}">
    <span>{label}</span>
    {#if summary}<span class="max-w-[9rem] truncate {quiet && !open ? 'text-ink-400' : ''}">{summary}</span>{/if}
    {#if quiet}<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true"></span>{/if}
    {#if count > 1 && active}<span class="rounded-full bg-accent px-1.5 text-[11px] leading-[18px] text-on-accent">{count}</span>{/if}
    <svg viewBox="0 0 12 12" class="h-2.5 w-2.5 shrink-0 transition-transform {open ? 'rotate-180' : ''}"
         fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <path d="M2.5 4.5 6 8l3.5-3.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  {#if media.mobile}
    <Sheet bind:open title={label} done="完成">{@render body()}</Sheet>
  {:else if open}
    <div bind:this={panel}
         class="absolute z-50 mt-1.5 w-max rounded-xl border border-ink-600 bg-ink-800 p-3 shadow-2xl
                {align === 'right' ? 'right-0' : 'left-0'}"
         style="min-width:min({w}, calc(100vw - 1.5rem)); max-width:min(34rem, calc(100vw - 1.5rem));
                transform:translateX({-shift}px)">
      {#if scroll}
        <div class="max-h-[60vh] overflow-y-auto">{@render body()}</div>
      {:else}
        {@render body()}
      {/if}
    </div>
  {/if}
</div>
