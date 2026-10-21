<script>
  /**
   * 全站快速搜索（2026-10-21，主人拍板「顶栏加搜索 + ⌘K 面板」）。根布局把它放在顶栏右侧。
   *
   * - 入口：顶栏按钮（桌面：放大镜 +「搜索」+ 键帽；< sm 只剩放大镜）、Ctrl/⌘ + K、`/`（正在输入时不抢）
   * - 面板：≥ sm 居中命令面板；< sm 全屏（底部抽屉会被软键盘顶走一半，搜索页通行做法是全屏 + 「取消」）
   * - 输入即搜（防抖 150ms，输入法组字中不搜、不响应回车），↑↓ 选、Enter 打开、Esc 关
   * - 结果最多 10 条，口径同目录搜索；排序见 queries/quicksearch.js（完全匹配 → 前缀 → 其余，组内新 → 旧）
   * - 列表最后一项「在目录中搜索」→ /catalog?q=，那里是完整的新 → 旧列表
   * - 没输入：登录 = 在看 / 最近动过的，访客 = 本季热门
   * - 可达性：dialog + aria-modal；输入框是 combobox，结果是 listbox（aria-activedescendant 指当前项）；
   *   Tab 圈在面板里；关掉后焦点回到顶栏按钮
   * - 节点挂到 <body>：顶栏有 backdrop-filter，fixed 子元素会被它困住
   */
  import MagnifyingGlass from 'phosphor-svelte/lib/MagnifyingGlass';
  import ArrowRight from 'phosphor-svelte/lib/ArrowRight';
  import CircleNotch from 'phosphor-svelte/lib/CircleNotch';
  import XCircle from 'phosphor-svelte/lib/XCircle';
  import { goto, afterNavigate } from '$app/navigation';
  import { fade, scale } from 'svelte/transition';
  import { media } from '$lib/media.svelte.js';
  import { TYPE_CN, WATCH_STATUS, SEASON_CN, MY_STATUS_TAG } from '$lib/constants.js';

  let open = $state(false);
  let q = $state('');
  let items = $state([]);
  let total = $state(0);
  let kind = $state(null);          // 'recent' | 'hot' | null（有搜索词时）
  let shownQ = $state('');          // 当前 items 对应的搜索词（结果没回来前保留上一批，不闪空）
  let loading = $state(false);
  let failed = $state(false);
  let active = $state(0);
  let mac = $state(false);
  /** 用过 ↑↓ 吗。手机上没有方向键：不预先高亮第一条，键盘上的「搜索」键去目录（像普通搜索框）*/
  let kbd = $state(false);
  const showActive = $derived(!media.mobile || kbd);
  let composing = false;

  let trigger = $state(null);
  let panel = $state(null);
  let input = $state(null);
  let listEl = $state(null);

  const dur = $derived(media.reducedMotion ? 0 : 140);
  const catalogHref = $derived(`/catalog?q=${encodeURIComponent(shownQ)}`);
  /** 选项 = 结果 + （有搜索词且有结果时）末尾的「在目录中搜索」 */
  const hasMore = $derived(!!shownQ && total > 0);
  const count = $derived(items.length + (hasMore ? 1 : 0));
  const hrefAt = (i) => (i < items.length ? `/anime/${items[i].id}` : catalogHref);
  const optId = (i) => `qs-opt-${i}`;

  $effect(() => { mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent); });

  // ── 取数 ──
  let timer = null;
  let ctl = null;
  async function load(term) {
    ctl?.abort();
    ctl = new AbortController();
    loading = true;
    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: ctl.signal });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      items = j.items ?? [];
      total = j.total ?? items.length;
      kind = j.kind ?? null;
      shownQ = j.q ?? '';
      active = 0;
      kbd = false;
      failed = false;
      loading = false;
    } catch (e) {
      if (e?.name === 'AbortError') return;
      failed = true;
      loading = false;
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (composing) return;
    timer = setTimeout(() => load(q.trim()), q.trim() ? 150 : 0);
  }

  // ── 开关 ──
  let returnFocus = true;
  function show() {
    if (open) { input?.select(); return; }
    returnFocus = true;
    open = true;
    if (!items.length || q) load(q.trim());
  }
  function close(refocus = true) {
    if (!open) return;
    returnFocus = refocus;
    open = false;
    clearTimeout(timer);
    ctl?.abort();
    loading = false;
  }

  // 锁背景滚动、焦点进出
  $effect(() => {
    if (!open) return;
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    queueMicrotask(() => { input?.focus({ preventScroll: true }); input?.select(); });
    return () => {
      html.style.overflow = prev;
      if (returnFocus && trigger && document.contains(trigger)) trigger.focus({ preventScroll: true });
    };
  });

  // 跳走了就收起（点结果 / 回车 / 浏览器后退）
  afterNavigate(() => close(false));

  function go(i) {
    if (i < 0 || i >= count) return;
    const href = hrefAt(i);
    close(false);
    goto(href);
  }

  // ── 键盘 ──
  function hover(i) { active = i; }
  function move(d) {
    if (!count) return;
    kbd = true;
    active = (active + d + count) % count;
    queueMicrotask(() => listEl?.querySelector(`#${optId(active)}`)?.scrollIntoView({ block: 'nearest' }));
  }
  function onInputKey(e) {
    if (e.isComposing || e.keyCode === 229) return;     // 输入法组字中：回车是上屏，不是打开
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      // 结果还没跟上输入（防抖中）：直接按当前输入去目录，免得打开上一批结果里的条目
      const t = q.trim();
      if (t && (t !== shownQ || !showActive)) { close(false); goto(`/catalog?q=${encodeURIComponent(t)}`); return; }
      go(active);
    }
  }
  function onPanelKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab' || !panel) return;
    const f = [...panel.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.tabIndex >= 0 && el.offsetParent !== null);
    if (!f.length) { e.preventDefault(); return; }
    const [a, z] = [f[0], f[f.length - 1]];
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  }
  /** 全局快捷键：Ctrl/⌘+K 开关；`/` 打开（焦点在输入框 / 可编辑区时不抢）。别的模态框开着时不响应 */
  function onWindowKey(e) {
    if (e.defaultPrevented || e.isComposing) return;
    const k = e.key?.toLowerCase();
    const isK = k === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
    const isSlash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (!isK && !isSlash) return;
    if (open) { if (isK) { e.preventDefault(); close(); } return; }
    if (document.querySelector('[aria-modal="true"]')) return;
    const t = /** @type {HTMLElement} */ (e.target);
    if (isSlash && (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? ''))) return;
    e.preventDefault();
    show();
  }

  function portal(node) {
    document.body.appendChild(node);
    return { destroy() { node.remove(); } };
  }

  // ── 显示 ──
  const meta = (a) => [a.sub, a.year ? `${a.year}${SEASON_CN[a.season] ? ' ' + SEASON_CN[a.season] : ''}` : null, TYPE_CN[a.type] ?? a.type]
    .filter(Boolean).join(' · ');
  const mineText = (a) => (a.my_status === 'watching'
    ? `在看 ${a.current_episode ?? 0}/${a.episodes ?? '?'}` : WATCH_STATUS[a.my_status]);
  /** 搜索词原样出现在标题里时标出来（简繁 / 逐字命中的不标，宁可不标也不标错） */
  function parts(title) {
    const n = shownQ.trim();
    const i = n ? title.toLowerCase().indexOf(n.toLowerCase()) : -1;
    return i < 0 ? [title] : [title.slice(0, i), title.slice(i, i + n.length), title.slice(i + n.length)];
  }
  let broken = $state({});
  const groupLabel = $derived(shownQ ? null : kind === 'recent' ? '最近' : kind === 'hot' ? '本季热门' : null);
  const empty = $derived(!!shownQ && !loading && !items.length && !failed);
</script>

<svelte:window onkeydown={onWindowKey} />

<button bind:this={trigger} type="button" onclick={show} aria-haspopup="dialog" aria-expanded={open}
        aria-keyshortcuts={mac ? 'Meta+K /' : 'Control+K /'} aria-label="搜索"
        class="trig flex shrink-0 items-center rounded-lg text-ink-400 transition hover:bg-ink-800 hover:text-ink-100 active:scale-[.97]
               max-sm:h-9 max-sm:w-9 max-sm:justify-center sm:h-8 sm:gap-1.5 sm:pl-2.5 sm:pr-1.5">
  <MagnifyingGlass size={16} weight="bold" class="max-sm:hidden" />
  <MagnifyingGlass size={20} class="sm:hidden" />
  <span class="text-[12.5px] max-sm:hidden">搜索</span>
  <kbd class="kbd inline-flex max-sm:hidden">{mac ? '⌘K' : 'Ctrl K'}</kbd>
</button>

{#if open}
  <div use:portal class="fixed inset-0 z-[97]" onkeydown={onPanelKey} role="presentation">
    {#if !media.mobile}
      <button type="button" tabindex="-1" aria-label="关闭搜索" onclick={() => close()}
              class="absolute inset-0 cursor-default bg-black/50 backdrop-blur-[2px]" transition:fade={{ duration: dur }}></button>
    {/if}
    <div bind:this={panel} role="dialog" aria-modal="true" aria-label="搜索番剧"
         transition:scale={{ duration: dur, start: media.mobile ? 1 : 0.97, opacity: 0 }}
         class="panel relative flex flex-col overflow-hidden bg-ink-900
                max-sm:h-full max-sm:pt-[env(safe-area-inset-top)]
                sm:mx-auto sm:mt-[12vh] sm:max-h-[min(640px,76vh)] sm:w-[calc(100%-2rem)] sm:max-w-[640px]
                sm:rounded-2xl sm:border sm:border-ink-700 sm:shadow-hero">
      <!-- 输入行 -->
      <div class="flex shrink-0 items-center gap-2 max-sm:px-3 max-sm:py-2.5 sm:h-14 sm:gap-3 sm:border-b sm:border-ink-700 sm:px-4">
        <label class="field flex min-w-0 flex-1 items-center gap-2.5 max-sm:h-10 max-sm:rounded-xl max-sm:bg-ink-800 max-sm:px-3">
          {#if loading}
            <CircleNotch size={18} class="shrink-0 animate-spin text-ink-400" />
          {:else}
            <MagnifyingGlass size={18} class="shrink-0 text-ink-400" />
          {/if}
          <input bind:this={input} bind:value={q} type="search" maxlength="100" autocomplete="off" spellcheck="false"
                 enterkeyhint="search" placeholder="搜索番剧" aria-label="搜索番剧"
                 role="combobox" aria-expanded={count > 0} aria-controls="qs-list" aria-autocomplete="list"
                 aria-activedescendant={count && showActive ? optId(active) : undefined}
                 oninput={schedule} onkeydown={onInputKey}
                 oncompositionstart={() => (composing = true)}
                 oncompositionend={() => { composing = false; schedule(); }}
                 class="qs-input min-w-0 flex-1 bg-transparent text-[15px] text-ink-100 outline-none placeholder:text-ink-400 sm:text-base" />
          {#if q}
            <button type="button" aria-label="清空" onclick={() => { q = ''; schedule(); input?.focus(); }}
                    class="grid h-7 w-7 shrink-0 place-items-center rounded-full text-ink-400 hover:text-ink-100">
              <XCircle size={18} weight="fill" />
            </button>
          {/if}
        </label>
        {#if media.mobile}
          <button type="button" onclick={() => close()} class="shrink-0 px-1.5 text-[15px] text-accent">取消</button>
        {:else}
          <button type="button" onclick={() => close()} aria-label="关闭" class="kbd inline-flex hover:text-ink-100">Esc</button>
        {/if}
      </div>

      <!-- 结果。列表在中间滚动；「在目录中搜索」钉在面板底部，结果再多也看得见 -->
      {#if empty}
        <div class="flex items-center justify-center gap-2 px-4 py-10 text-sm text-ink-400">
          <MagnifyingGlass size={18} />没有找到「{shownQ}」
        </div>
      {:else if failed && !items.length}
        <div class="px-4 py-10 text-center text-sm text-ink-400">搜索暂时不可用</div>
      {/if}
      <!-- 选项只靠 ↑↓ 选（aria-activedescendant），不进 Tab 序列 -->
      <div id="qs-list" role="listbox" bind:this={listEl} aria-label={groupLabel ?? '搜索结果'}
           class="flex min-h-0 flex-1 flex-col {count ? '' : 'hidden'}">
        <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 {hasMore ? 'pb-1' : 'pb-2 max-sm:pb-[calc(0.5rem+env(safe-area-inset-bottom))]'}">
          {#if groupLabel}
            <div class="px-3 pb-1 pt-3 text-[11.5px] font-medium tracking-wider text-ink-400" aria-hidden="true">{groupLabel}</div>
          {:else}
            <div class="h-2" aria-hidden="true"></div>
          {/if}
          <div class="flex flex-col gap-0.5">
            {#each items as a, i (a.id)}
              {@const on = i === active && showActive}
              <a href={hrefAt(i)} id={optId(i)} role="option" aria-selected={on} tabindex="-1"
                 onclick={() => close(false)} onmousemove={() => hover(i)}
                 class="opt flex items-center gap-3 rounded-xl px-2.5 py-2 {on ? 'bg-ink-800' : ''}">
                <span class="relative h-[54px] w-[38px] shrink-0 overflow-hidden rounded-md bg-ink-800">
                  {#if a.cover && !broken[a.id]}
                    <img src="/cover/{a.id}" alt="" loading="lazy" class="h-full w-full object-cover"
                         onerror={() => (broken = { ...broken, [a.id]: true })} />
                  {:else}
                    <span class="grid h-full w-full place-items-center text-[12px] font-medium text-ink-400">
                      {a.title.replace(/^[\s\W]+/, '').slice(0, 1) || '?'}
                    </span>
                  {/if}
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[14px] font-medium leading-snug text-ink-100">
                    {#each parts(a.title) as p, k (k)}{#if k === 1}<mark class="hl">{p}</mark>{:else}{p}{/if}{/each}
                  </span>
                  <span class="mt-0.5 block truncate text-[12px] text-ink-400">{meta(a)}</span>
                </span>
                {#if a.my_status}
                  <span class="shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium {MY_STATUS_TAG[a.my_status] ?? ''}">
                    {mineText(a)}
                  </span>
                {/if}
              </a>
            {/each}
          </div>
        </div>
        {#if hasMore}
          {@const i = items.length}
          {@const on = i === active && showActive}
          <div class="shrink-0 border-t border-ink-700 p-2 max-sm:pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
            <a href={catalogHref} id={optId(i)} role="option" aria-selected={on} tabindex="-1"
               onclick={() => close(false)} onmousemove={() => hover(i)}
               class="opt flex items-center gap-3 rounded-xl px-2.5 py-2.5 text-[13.5px] {on ? 'bg-ink-800 text-ink-100' : 'text-ink-200'}">
              <span class="grid w-[38px] shrink-0 place-items-center text-ink-400"><MagnifyingGlass size={18} /></span>
              <span class="min-w-0 flex-1 truncate">在目录中搜索「{shownQ}」</span>
              <span class="shrink-0 text-[12px] tabular-nums text-ink-400">{total.toLocaleString()}</span>
              <ArrowRight size={15} class="shrink-0 {on ? 'text-accent' : 'text-ink-400'}" />
            </a>
          </div>
        {/if}
      </div>
      <div class="sr-only" role="status" aria-live="polite">
        {shownQ && !loading ? (items.length ? `${total} 部` : `没有找到「${shownQ}」`) : ''}
      </div>
    </div>
  </div>
{/if}

<style>
  /* display 交给 class（inline-flex / max-sm:hidden）：写在这里会盖过 Tailwind 的断点类 */
  .kbd { align-items: center; height: 20px; padding: 0 6px; border-radius: 5px;
         border: 1px solid var(--c-border); background: var(--c-bg); color: var(--c-muted);
         font: 500 10.5px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .02em; white-space: nowrap; }
  .trig:hover .kbd { color: var(--c-text-soft); }
  .hl { background: none; color: var(--c-accent-ink); font-weight: 600; }
  input[type='search']::-webkit-search-cancel-button { display: none; }
  /* 面板一打开焦点就在输入框里，全站的 focus-visible 外圈在这里只是噪音（:where 零特异性，这里压得住） */
  .qs-input:focus-visible { outline: none; }
</style>
