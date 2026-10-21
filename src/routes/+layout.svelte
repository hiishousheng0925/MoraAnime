<script>
  import SignOut from 'phosphor-svelte/lib/SignOut';
  import SignIn from 'phosphor-svelte/lib/SignIn';
  import Lightning from 'phosphor-svelte/lib/Lightning';
  import SidebarSimple from 'phosphor-svelte/lib/SidebarSimple';
  import '../app.css';
  import { page, navigating, updated } from '$app/state';
  import { beforeNavigate } from '$app/navigation';
  import { browser } from '$app/environment';
  import ThemeToggle from '$lib/ui/ThemeToggle.svelte';
  import Toaster from '$lib/ui/Toaster.svelte';
  import AuthDialog from '$lib/ui/AuthDialog.svelte';
  import BrandMark from '$lib/ui/BrandMark.svelte';
  import TabBar from '$lib/ui/TabBar.svelte';
  import QuickSearch from '$lib/ui/QuickSearch.svelte';
  import UpdateChip from '$lib/ui/UpdateChip.svelte';
  import { requireLogin, logout } from '$lib/auth.svelte.js';
  import { replaceState } from '$app/navigation';
  import { toast } from '$lib/toast.svelte.js';
  import { DRAWER_COOKIE } from '$lib/constants.js';
  import { media } from '$lib/media.svelte.js';
  import { NAV, NAV_GROUPS, isActive } from '$lib/nav.js';
  let { children, data } = $props();

  // 导航项、分组、顺序都在 $lib/nav.js（侧栏和手机底部标签栏共用）
  const active = (h) => isActive(h, page.url.pathname);

  /**
   * 发布后检测到新版本，就把下一次跳转降级成整页加载。
   *
   * 不主动 location.reload()：那会在主人正看着页面时突然刷掉。
   * 等他自己点下一个链接时整页加载，既拿到新代码又不打断当前操作。
   *
   * 不这么做的后果（实测）：发布前开着的标签页点侧栏「设置」，URL 和高亮都对，
   * 渲染出来的是首页 —— 旧 app.js 的路由 node 索引和新服务端返回的对不上。
   * 版本比对靠 svelte.config.js 里的 version.pollInterval。
   */
  beforeNavigate(({ willUnload, to }) => {
    if (updated.current && !willUnload && to?.url) location.href = to.url.href;
  });

  // 初值来自服务端读的 cookie，首屏就是正确状态 —— 不再有「收起 → 弹出」那一下。
  // 用 $state 而不是 $derived：这之后由用户点击控制，不该被导航时的 data 覆盖。
  let open = $state(data.drawerOpen);

  function setOpen(v) {
    open = v;
    // 写回 cookie 供下次 SSR 用。一年过期，跟着站点根路径。
    if (browser) document.cookie = `${DRAWER_COOKIE}=${v ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`;
  }

  /**
   * 观看页（/anime/[id]/watch）桌面侧栏默认收成 64px 的图标窄条，把宽度让给播放器。
   * 这是「观看页的临时状态」，单独一个 watchOpen，不写 cookie：离开观看页就回到用户原来的偏好（open）。
   * 在观看页里手动展开照常（只在这一页有效）。路由在服务端就知道，首屏直接是窄条，没有跳变。
   */
  const isWatch = $derived(/^\/anime\/\d+\/watch\/?$/.test(page.url.pathname));
  let watchOpen = $state(false);
  const deskOpen = $derived(isWatch ? watchOpen : open);
  const rail = $derived(isWatch && !watchOpen);

  /**
   * 手机（< lg）上侧栏是盖在内容上的抽屉，另用一个只活在这一页的状态，缺省收起、不写 cookie。
   * 原来两种宽度共用 open（cookie 缺省 = 展开）：手机上第一次进站、或开过一次菜单后刷新，
   * 每一页都被抽屉盖住大半屏（2026-10-18 Playwright 巡检时看到的）。
   * SSR 不知道屏幕宽度，所以显隐交给 CSS 断点（max-lg: / lg:），两个状态各管一边。
   * < md 时由底部标签栏的「更多」打开；md–lg 之间由顶栏汉堡打开。
   */
  let mob = $state(false);
  const wide = $derived(media.wide);
  // 拉宽到桌面时收掉手机抽屉的状态，再缩回来不会自己弹出
  $effect(() => { if (wide) mob = false; });
  const shown = $derived(wide ? deskOpen : mob);
  const toggle = () => {
    if (!wide) mob = !mob;
    else if (isWatch) watchOpen = !watchOpen;
    else setOpen(!open);
  };
  const pending = $derived(data.triage.remaining ?? 0);
  const cur = $derived(NAV.find((n) => active(n.href))?.label ?? '');

  // 环境标识。URL 上 prod/test 只有 Mac 配了 hosts 才看得出（Tailscale 不支持
  // 自定义 DNS 记录），手机上一律是 IP:端口 —— 所以让站点自己说清楚自己是谁。
  const isTest = $derived(data.env === 'test');
  const brand = $derived(data.brand ?? 'j-anime');

  const user = $derived(data.user);
  /** 旧书签 /login、或别处带 ?login=1 跳来的：弹登录框，并把参数从地址栏去掉 */
  $effect(() => {
    if (!page.url.searchParams.has('login')) return;
    const u = new URL(page.url); u.searchParams.delete('login');
    replaceState(u, page.state);
    if (!data.user) requireLogin();
  });
  async function signOut() {
    await logout();
    toast.ok('已登出');
  }
  const MINI = $derived([['看完', data.stats.completed], ['在看', data.stats.watching], ['集', data.stats.episodes]]);
</script>

<svelte:head>
  <title>{isTest ? 'TEST · ' : ''}{cur ? cur + ' · ' : ''}{brand}</title>
  {#if isTest}<link rel="icon" href="/icon-test.svg" type="image/svg+xml" />{/if}
</svelte:head>

<!-- Esc 只关手机上的抽屉（浮层）。桌面侧栏是常驻面板不是浮层：原来 Esc 一律收起，
     在筛选下拉 / 弹窗里按 Esc 关下拉，侧栏也跟着收了，而且记进 cookie（#102） -->
<svelte:window onkeydown={(e) => e.key === 'Escape' && !e.defaultPrevented && mob && (mob = false)} />

<!--
  顶部加载条。搜索 / 重置 / 换筛选 / 翻页都是导航，之前点下去没有任何反馈，
  慢的时候不知道到底有没有在动（断网那次尤其明显）。
  只在客户端导航时出现；整页刷新由浏览器自己的转圈负责。
-->
{#if navigating.to}
  <div class="pointer-events-none fixed inset-x-0 top-0 z-[110] h-[3px] overflow-hidden bg-accent/20"
       role="status" aria-label="加载中">
    <div class="loadbar h-full w-1/4 bg-accent"></div>
  </div>
{/if}

<Toaster />
<AuthDialog />

{#if data.bare}
  <!-- 分享页：不套主壳，也不暴露侧栏里的个人统计 -->
  {@render children()}
{:else}
<!-- 顶栏和侧栏同属外壳层，用抬升的表面色 —— 原来用的是背景色本身，和内容区分不开 -->
<!-- 跳到正文：平时藏着，Tab 第一下出现 —— 否则每页都要先 Tab 穿过整排侧栏 -->
<a href="#main" class="sr-only rounded-lg bg-accent px-3 py-2 text-sm font-medium text-on-accent
                       focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[120]">跳到正文</a>
<!--
  顶栏（2026-10-21 第二轮打磨，主人问「顶栏会不会有点丑」）：
  · 左边的开关是「侧栏」图标的无框按钮。原来是带框的汉堡、展开时变成 ✕ —— 侧栏在桌面是常驻面板，
    ✕ 读起来像「关闭页面」；而且带框按钮是整条顶栏里最重的东西，偏偏是最不重要的操作。
    md–lg 之间侧栏是盖在内容上的抽屉，那里仍是汉堡 / ✕（浮层用 ✕ 关是对的）。
    按钮中心对齐侧栏图标列（x≈32px，观看页窄条的图标也在这条线上）
  · 去掉了「| 当前页名」：侧栏高亮、页面自己的大标题已经说了一遍，手机上标题紧挨着它又说一遍
  · 右边两枚统一成同一种无底小按钮（图标 + 字 + 数字）。原来一个灰字一个暖色胶囊，两种语言；
    测试站里暖色胶囊和 TEST 徽标、暖色顶栏撞色，环境标识反而不显眼了。访客在这里有「登录」
  · 测试站的暖色叠在正常的表面色上（原来只有 6% 暖色、底下是透明的：亮色主题下发灰发脏）
-->
<!-- 观看页手机上顶栏不吸顶：播放器自己吸顶（watch 段），两个都吸顶会叠在一起 -->
<header class="hdr top-0 z-40 flex h-[var(--hdr-h)] items-center gap-2 border-b bg-ink-900/90 pl-3.5 pr-3 backdrop-blur-xl
               {isWatch ? 'md:sticky' : 'sticky'}
               {isTest ? 'test border-warm/40' : 'border-ink-700'}">
  <button onclick={toggle} aria-label={wide ? (shown ? '收起侧栏' : '展开侧栏') : '菜单'} aria-expanded={shown}
          aria-controls="sidebar" title={wide ? (shown ? '收起侧栏' : '展开侧栏') : undefined}
          class="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink-400 transition
                 hover:bg-ink-800 hover:text-ink-100 active:scale-95 max-md:hidden">
    <SidebarSimple size={20} class="max-lg:hidden" />
    <span class="relative block h-3.5 w-4 lg:hidden">
      {#each [0, 6, 12] as top, i}
        <span class="absolute inset-x-0 h-[1.5px] rounded bg-current transition-all duration-200"
              style="top:{top}px"
              class:translate-y-[6px]={mob && i === 0}
              class:rotate-45={mob && i === 0}
              class:opacity-0={mob && i === 1}
              class:-translate-y-[6px]={mob && i === 2}
              class:-rotate-45={mob && i === 2}></span>
      {/each}
    </span>
  </button>
  <a href="/" class="flex items-center gap-2 rounded-lg py-1 pr-1 text-[15px] font-semibold tracking-tight md:pl-1">
    <BrandMark test={isTest} />{brand}
  </a>
  {#if isTest}
    <span class="rounded-md border border-warm/50 bg-warm/15 px-1.5 py-px
                 text-[10.5px] font-semibold tracking-wider text-warm">TEST</span>
  {/if}
  <div class="ml-auto flex shrink-0 items-center gap-1">
    <!-- 全站搜索（⌘K / Ctrl K / 「/」）：桌面是「放大镜 + 搜索 + 键帽」，手机只剩放大镜；面板见 QuickSearch.svelte -->
    <QuickSearch />
    {#if data.desktop}<UpdateChip />{/if}
    {#if user && data.stats.watching}
      <a href="/mine?status=watching" class="chip flex max-sm:hidden">
        <i class="live h-1.5 w-1.5 rounded-full bg-live" aria-hidden="true"></i>在看<b>{data.stats.watching}</b>
      </a>
    {/if}
    {#if user && pending}
      <a href="/triage" class="chip flex" aria-label="待标记 {pending.toLocaleString()}">
        <Lightning size={14} weight="fill" class="text-warm" /><span class="max-sm:hidden">待标记</span><b>{pending.toLocaleString()}</b>
      </a>
    {/if}
    {#if !user}
      <!-- 侧栏底部已有「登录」时（桌面展开 / 窄条）这里不再重复；手机、平板、桌面收起侧栏时它是唯一常驻的入口 -->
      <button type="button" onclick={() => requireLogin()} class="chip flex {deskOpen || rail ? 'lg:hidden' : ''}">
        <SignIn size={15} />登录
      </button>
    {/if}
  </div>
</header>

<div class="flex">
  {#if mob}
    <button aria-label="关闭菜单" onclick={() => (mob = false)}
            class="scrim fixed inset-0 z-[41] bg-black/50 backdrop-blur-[2px] md:top-[var(--hdr-h)] lg:hidden"></button>
  {/if}

  <!-- 抽拉侧栏：始终 fixed；桌面用下面的占位块留出宽度（之前两者并存导致了双倍空白）。
       手机（<md）上是「更多」抽屉：盖住顶栏、停在底部标签栏上面，自带品牌行 -->
  <aside id="sidebar" inert={wide ? !(deskOpen || rail) : !mob} class:rail
         class="fixed top-[var(--hdr-h)] bottom-0 left-0 z-30 flex w-64 flex-col overflow-y-auto overflow-x-hidden
                border-r border-ink-700 bg-ink-900 px-3 pb-3 pt-2 transition-[transform,width] duration-200 ease-out
                max-md:top-0 max-lg:z-[42] max-md:bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))]
                max-md:w-[17.5rem] max-md:rounded-r-2xl {mob ? 'max-lg:shadow-[16px_0_40px_-12px_rgb(0_0_0/0.5)]' : ''}
                {rail ? 'lg:w-16' : 'lg:w-60'}
                {mob ? 'max-lg:translate-x-0' : 'max-lg:-translate-x-full'} {deskOpen || rail ? 'lg:translate-x-0' : 'lg:-translate-x-full'}">
    <div class="flex h-12 shrink-0 items-center gap-2 px-2 text-[15px] font-semibold tracking-tight md:hidden">
      <BrandMark test={isTest} size={26} />{brand}
      {#if isTest}
        <span class="rounded-md border border-warm/50 bg-warm/15 px-1.5 py-px text-[10.5px] font-semibold tracking-wider text-warm">TEST</span>
      {/if}
    </div>
    <nav class="flex flex-col gap-0.5" aria-label="导航">
      <!--
        侧栏主导航走【整页跳转】而不是客户端路由（data-sveltekit-reload）。

        起因：主人两次报同一个故障 —— 点侧栏「设置」，地址栏变成 /settings、
        侧栏高亮也切过去了，可内容还是跳转前那一页（一次是首页、一次是排行榜），
        刷新才正常。查过一轮：服务端直连 /settings 完全正确（title 就是「设置」），
        产物端到端健康（客户端路由表 "/settings":[-12] 对应服务端 leaf 11，
        设置页 leaf chunk 连同它依赖的 16 个 chunk 全部 200），
        所以坏的是那个标签页里跑着的旧客户端代码 —— 没法进浏览器确证根因。

        与其继续猜，让顶层导航不依赖客户端路由：
          · 这类「装错页面」的故障从此不可能发生
          · 旧标签页第一次点侧栏就整页加载，自动拿到新代码（自愈）
        代价是每次切页多几十毫秒：实测整页 SSR 52-122 ms、客户端跳转 19-59 ms，
        在 tailnet 内感知不到。而页内的筛选/翻页/搜索/下一批仍然是客户端路由 ——
        那些才是高频操作，SPA 的好处留在那儿。
      -->
      {#each NAV_GROUPS as g (g.title)}
        <div class="grp">{g.title}</div>
        {#each g.items as n (n.href)}
          {@const on = active(n.href)}
          <!-- 手机上首页 / 目录 / 放送表 / 番单在底部标签栏里，「更多」抽屉不重复 -->
          <a href={n.href} data-sveltekit-reload onclick={() => (mob = false)} title={rail ? n.label : undefined}
             class:is-current={on} aria-current={on ? 'page' : undefined}
             class="item relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition
                    {n.tab ? 'max-md:hidden' : ''} {on ? '' : 'text-ink-400 hover:bg-ink-800 hover:text-ink-200'}">
            <n.icon size={18} weight={on ? 'fill' : 'regular'} class="shrink-0 {on ? 'text-accent' : ''}" />
            <span class="lbl truncate">{n.label}</span>
            {#if n.href === '/triage' && pending}
              <span class="lbl ml-auto rounded-full bg-warm/15 px-1.5 py-0.5 text-[11px] font-normal text-warm">
                {pending.toLocaleString()}
              </span>
              <i class="dot absolute right-2.5 top-2 hidden h-1.5 w-1.5 rounded-full bg-warm-fill" aria-hidden="true"></i>
            {/if}
          </a>
        {/each}
      {/each}
    </nav>

    <!-- 底部：账号区（三栏小数字 + 头像 / 用户名 + 登出 + 亮暗切换）。「中文名已补」移到设置页「数据」区（访客不该看到运维数字） -->
    <div class="acct mt-auto border-t border-ink-700 pt-3">
      {#if user}
        <div class="mini mb-2.5 grid grid-cols-3 rounded-xl bg-ink-800 py-2 text-center">
          {#each MINI as [k, v] (k)}
            <div class="min-w-0">
              <div class="text-[15px] font-semibold leading-tight text-ink-100">{(v ?? 0).toLocaleString()}</div>
              <div class="mt-0.5 text-[11px] text-ink-400">{k}</div>
            </div>
          {/each}
        </div>
      {/if}
      <div class="row flex items-center gap-2">
        {#if data.desktop}
          <!-- 桌面客户端单机免登录：内置账号（me）只是个技术细节，不显示头像 / 用户名（主人 2026-10-21） -->
          <span class="flex-1"></span>
        {:else if user}
          <a href="/settings#account" data-sveltekit-reload title="账号设置"
             class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 hover:bg-ink-800">
            <span class="ava grid h-8 w-8 shrink-0 place-items-center rounded-full text-[12.5px] font-bold uppercase text-white">
              {user.username.slice(0, 1)}
            </span>
            <span class="lbl truncate text-[13px] text-ink-200">{user.username}</span>
          </a>
          <button type="button" onclick={signOut} title="登出" aria-label="登出"
                  class="lbl grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-ink-700 bg-ink-900 text-ink-200
                         transition hover:border-ink-400 active:scale-95">
            <SignOut size={16} />
          </button>
        {:else}
          <button type="button" onclick={() => requireLogin()} title="登录"
                  class="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent text-[13px] font-medium
                         text-on-accent transition active:scale-[0.98]">
            <SignIn size={16} weight="bold" /><span class="lbl">登录</span>
          </button>
        {/if}
        <ThemeToggle compact />
      </div>
    </div>
  </aside>

  <div class="hidden shrink-0 overflow-hidden transition-[width] duration-200 ease-out
              lg:block {rail ? 'w-16' : deskOpen ? 'w-60' : 'w-0'}"></div>

  <main id="main" tabindex="-1" class="min-w-0 flex-1 outline-none max-md:pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))]">
    {@render children()}
  </main>
</div>

<div class="tabwrap" class:watch={isWatch}>
  <TabBar {user} more={mob} onmore={() => (mob = !mob)} onnav={() => (mob = false)} />
</div>
{/if}

<style>
  /* 底部标签栏的高度：Toaster、Sheet 和页面底部留白都读它（app.css 默认 0） */
  @media (max-width: 767px) {
    :global(:root) { --tabbar-h: 56px; }
  }
  /* 观看页手机横屏：播放器占满，标签栏让开（全屏时全屏元素本来就盖住一切，不用另管） */
  @media (max-width: 767px) and (orientation: landscape) and (max-height: 500px) {
    :global(:root:has(.tabwrap.watch)) { --tabbar-h: 0px; }
    .tabwrap.watch { display: none; }
  }

  .grp { padding: 14px 12px 6px; font-size: 11px; font-weight: 500; letter-spacing: .08em; color: var(--c-muted); }
  .grp:first-child { padding-top: 6px; }
  .ava { background: linear-gradient(135deg, var(--c-accent), var(--c-brand-2)); }
  .live { box-shadow: 0 0 0 3px color-mix(in srgb, var(--c-live) 22%, transparent); }
  /* 测试站：暖色叠在表面色上（不是替换它），亮暗两套都是干净的暖调 */
  .hdr.test { background-image: linear-gradient(color-mix(in srgb, var(--c-warm-fill) 8%, transparent),
                                                color-mix(in srgb, var(--c-warm-fill) 8%, transparent)); }
  /* 顶栏右侧的小按钮：无底，悬停才出底色；数字用正文色压一档。display 留给 class（flex / max-sm:hidden），写在这里会盖过断点 */
  .chip { align-items: center; gap: 6px; height: 32px; padding: 0 10px; border-radius: 8px;
          font-size: 12.5px; color: var(--c-muted); white-space: nowrap; transition: background-color .15s, color .15s; }
  .chip:hover { background: var(--c-surface-2); color: var(--c-text); }
  .chip:active { transform: scale(.97); }
  .chip b { font-weight: 600; color: var(--c-text-soft); font-variant-numeric: tabular-nums; }

  /* 观看页的窄条（只在桌面 lg 以上；手机抽屉不受影响）：只剩图标，组标题变成一道短分隔线 */
  @media (min-width: 1024px) {
    aside.rail { padding-inline: 10px; }
    aside.rail .lbl { display: none; }
    aside.rail .grp { font-size: 0; padding: 10px 0; margin: 0 10px; }
    aside.rail .grp:not(:first-child) { border-top: 1px solid var(--c-border); margin-top: 8px; }
    aside.rail .item { justify-content: center; padding-inline: 0; }
    aside.rail .dot { display: block; }
    aside.rail .mini { display: none; }
    aside.rail .row { flex-direction: column; }
    aside.rail .row > a { flex: none; }
  }
</style>
