<script>
  import CardGrid from '$lib/ui/CardGrid.svelte';
  import Chip from '$lib/ui/Chip.svelte';
  import FilterPill from '$lib/ui/FilterPill.svelte';
  import MultiChip from '$lib/ui/MultiChip.svelte';
  import SortPill from '$lib/ui/SortPill.svelte';
  import YearPill from '$lib/ui/YearPill.svelte';
  import CoverBackdrop from '$lib/ui/CoverBackdrop.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import { EXIT } from '$lib/ui/btn.js';
  import { SEASON_CN, SEASON_MONTHS, TYPE_OPTS, TYPE_CN, SEASON_SORT_OPTS, SEASON_DEFAULT_SORT, MY_OPTS } from '$lib/constants.js';
  import { watchSummary } from '$lib/urlBuild.js';
  import { dispTitle } from '$lib/format.js';
  import { makeHref } from '$lib/urlState.js';
  import { edgeFade } from '$lib/edgeFade.js';
  import { centerCurrent } from '$lib/centerCurrent.js';
  import { media } from '$lib/media.svelte.js';
  import { page as pg } from '$app/state';
  import Page from '$lib/ui/Page.svelte';
  import ResetButton from '$lib/ui/ResetButton.svelte';
  import Pager from '$lib/ui/Pager.svelte';
  import CaretLeft from 'phosphor-svelte/lib/CaretLeft';
  import CaretRight from 'phosphor-svelte/lib/CaretRight';
  import ArrowRight from 'phosphor-svelte/lib/ArrowRight';
  let { data } = $props();

  const to = $derived(makeHref('/seasons', pg.url.searchParams));
  const ORDER = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
  // 选了季度就只显示那一季，否则四季全列
  const shownSeasons = $derived(data.season ? ORDER.filter((s) => s === data.season) : ORDER);
  const isCur = (y, s) => y === data.cur.year && s === data.cur.season;
  // 「全部」必须是 1 而不是 2：非重复条目的 source_count 最小就是 1，
  // 写 2 的时候「全部」实际藏掉了只被一家站收录的那批（2026 夏季 125 部里藏了 39 部）。
  const MIN_OPTS = [[1, '全部'], [4, '一般'], [8, '仅主流']];
  // 与目录页同一套：胶囊上直接显示当前值
  const sum = $derived({
    type: data.typesAreDefault ? null : data.types.map((t) => TYPE_CN[t] ?? t).join('·'),
    min: MIN_OPTS.find(([v]) => v === data.min)?.[1],
    mine: watchSummary(data.watches)
  });

  /**
   * 季节色：Tailwind 只认写全的类名，所以四季各写一份。
   * 文字色 ≥5:1（两套主题），作底色用 /15 淡底。
   */
  const TONE = {
    WINTER: { text: 'text-season-winter', soft: 'bg-season-winter/15', bar: 'border-season-winter' },
    SPRING: { text: 'text-season-spring', soft: 'bg-season-spring/15', bar: 'border-season-spring' },
    SUMMER: { text: 'text-season-summer', soft: 'bg-season-summer/15', bar: 'border-season-summer' },
    FALL:   { text: 'text-season-fall',   soft: 'bg-season-fall/15',   bar: 'border-season-fall' }
  };
  const tone = $derived(data.season ? TONE[data.season] : null);
  /** 「10-12月」→「10–12 月」：区间用 en dash，数字和单位之间留空 */
  const fmtMonths = (s) => SEASON_MONTHS[s].replace('-', '–').replace('月', ' 月');
  const months = $derived(data.season ? fmtMonths(data.season) : '1–12 月');
  const selIsCur = $derived(data.season ? isCur(data.year, data.season) : data.year === data.cur.year);
  const covers = $derived(data.hero.covers);
  const stepHref = (x) => (x ? to({ year: x.year, season: x.season ?? 'all' }) : null);
</script>

<Page fill>
  <!-- hero：季度就是这一页的主轴，标题、部数、切换都在这里；类型 / 门槛 / 排序退到下面 -->
  <section class="relative isolate overflow-hidden rounded-[20px] border border-ink-700 bg-ink-900 shadow-hero max-sm:rounded-2xl">
    {#if covers[0]}
      <CoverBackdrop id={covers[0].id} fade="none" blur={56} intensity={1.15} scrim scrimWidth={media.mobile ? '45%' : '70%'} position="50% 30%" />
    {/if}
    <!-- 底部压一层面板色，切换条落在稳定的底色上 -->
    <div aria-hidden="true" class="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-2/3 bg-gradient-to-t from-ink-900/90 to-transparent"></div>

    <div class="flex items-end justify-between gap-4 px-5 pt-5 pb-4 sm:gap-6 sm:px-8 sm:pt-7 sm:pb-5">
      <div class="min-w-0">
        <div class="flex items-center gap-2 text-[12px] text-ink-200">
          {#if selIsCur}
            <span class="rounded-full px-2 py-0.5 font-semibold {tone ? `${tone.soft} ${tone.text}` : 'bg-accent/15 text-accent-ink'}">
              {data.season ? '本季' : '今年'}
            </span>
          {/if}
          <span class="tracking-wide">{months}</span>
        </div>
        <!-- 手机上「2026 全年」比「2026 秋」宽两个字，40px 会钻到右边的扇形封面底下 → 全年时缩到 34px -->
        <h1 class="mt-2.5 whitespace-nowrap {data.season ? 'text-[40px]' : 'text-[34px]'} font-extrabold leading-none tracking-tight tabular-nums sm:text-[56px]">
          {data.year}<span class="ml-2.5 {tone ? tone.text : 'text-ink-400'}">{data.season ? SEASON_CN[data.season] : '全年'}</span>
        </h1>
        <div class="mt-3 text-[13px] text-ink-400"><b class="text-[15px] font-semibold text-ink-100">{data.total}</b> 部</div>
      </div>

      {#if covers.length}
        <!-- 本季高分番的封面，扇形错落；点了进详情 -->
        <div class="fan relative mr-1 flex shrink-0 sm:mr-2">
          {#each covers as c, i (c.id)}
            <a data-fan href="/anime/{c.id}" title={dispTitle(c)} aria-label={dispTitle(c)}
               class="fan-card fan-{covers.length === 1 ? 1 : i} block overflow-hidden rounded-lg bg-ink-800 shadow-hero transition-transform duration-200 sm:rounded-xl">
              <img src="/cover/{c.id}" alt="" loading="eager" decoding="async"
                   class="aspect-2/3 h-full w-full object-cover" />
            </a>
          {/each}
        </div>
      {/if}
    </div>

    <!-- 季度切换条：一点就切；数字和点进去看到的部数一致（同一套类型 / 门槛）。
         选中语言和放送表日历条同一套（主人 2026-10-21 第 3 条）：
           当前选中     accent 实色底 + on-accent 字（原来是季节色细边 + 15% 淡底，秋季那格几乎看不出选中）
           本季但没选中  accent 描边 + 淡底 + accent-ink 字，年份后写「本季」
         「本季」和「选中」是两回事：往回翻到 2025 冬时，本季那格仍要认得出来，好一眼找回去。
         季节色只留给 hero 大标题和四季分节的竖条，切换条不再混用第三种颜色。 -->
    <nav aria-label="切换季度" class="flex items-stretch gap-1.5 px-5 pb-5 sm:px-8 sm:pb-6">
      <a href={stepHref(data.hero.prev)} aria-label={data.season ? '上一季' : '上一年'}
         class="step {data.hero.prev ? '' : 'pointer-events-none opacity-30'}" aria-disabled={!data.hero.prev || undefined}>
        <CaretLeft size={16} weight="bold" />
      </a>
      <!-- 手机上横滑：往回翻了几季之后，选中格在最右边会被挡住，滚到中间 -->
      <div use:edgeFade use:centerCurrent={pg.url.search}
           class="flex min-w-0 flex-1 gap-1.5 overflow-x-auto sm:flex-initial overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {#each data.hero.strip as x}
          {@const on = x.year === data.year && x.season === data.season}
          {@const now = isCur(x.year, x.season)}
          <a href={to({ year: x.year, season: x.season })} aria-current={on ? 'page' : undefined}
             title={now ? '本季' : undefined}
             class="chip shrink-0 {on ? 'is-on' : now ? 'is-now' : ''}">
            <span class="block whitespace-nowrap text-[11px] leading-tight tabular-nums {on ? '' : now ? 'text-accent-ink' : 'text-ink-400'}">
              {x.year}{#if now}<span class="ml-1 font-medium">· 本季</span>{/if}
            </span>
            <span class="block text-[15px] font-semibold leading-snug {on ? '' : now ? 'text-accent-ink' : 'text-ink-200'}">
              {SEASON_CN[x.season]}{#if x.c}<span class="ml-1 text-[11px] font-normal tabular-nums {on ? '' : 'text-ink-400'}">{x.c}</span>{/if}
            </span>
          </a>
        {/each}
        <!-- 「全年」和单季不是同一类：竖线隔开 -->
        <span class="mx-0.5 w-px shrink-0 self-stretch bg-ink-700" aria-hidden="true"></span>
        <a href={to({ year: data.year, season: 'all' })} aria-current={!data.season ? 'page' : undefined}
           class="chip shrink-0 {!data.season ? 'is-on' : ''}">
          <span class="block text-[11px] leading-tight tabular-nums {!data.season ? '' : 'text-ink-400'}">{data.year}</span>
          <span class="block text-[15px] font-semibold leading-snug {!data.season ? '' : 'text-ink-200'}">全年</span>
        </a>
      </div>
      <a href={stepHref(data.hero.next)} aria-label={data.season ? '下一季' : '下一年'}
         class="step {data.hero.next ? '' : 'pointer-events-none opacity-30'}" aria-disabled={!data.hero.next || undefined}>
        <CaretRight size={16} weight="bold" />
      </a>
    </nav>
  </section>

  <!-- 次要筛选：与目录页统一的胶囊（手机单行横滑） -->
  <div use:edgeFade class="mt-5 flex flex-wrap items-center gap-1.5
              max-sm:-mx-4 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:overscroll-x-contain max-sm:px-4
              [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
    <FilterPill label="类型" summary={sum.type} count={data.typesAreDefault ? 0 : data.types.length} w="21rem">
      <MultiChip param="type" opts={TYPE_OPTS} selected={data.types}
                 isDefault={data.typesAreDefault} href={to} />
    </FilterPill>

    <!-- 门槛默认「一般」确实在缩小结果（藏掉只被 1–3 家收录的），所以写出来但不高亮 -->
    <FilterPill label="门槛" summary={sum.min} dflt={data.min === 4} count={data.min === 4 ? 0 : 1} w="18rem">
      <div class="flex flex-wrap gap-1.5">
        {#each MIN_OPTS as [v, l]}
          <Chip on={data.min === v} href={to({ min: v })}>{l}</Chip>
        {/each}
      </div>
      <p class="mt-2 text-[11px] text-ink-400">按收录站点数过滤冷门条目</p>
    </FilterPill>

    <!-- 和目录页同一套「我的」多选；访客没有番单，不显示 -->
    {#if data.user}
      <FilterPill label="我的" summary={sum.mine} count={(data.watches ?? []).length} w="20rem">
        <MultiChip param="watch" opts={MY_OPTS} selected={data.watches} isDefault={!data.watches} href={to} />
      </FilterPill>
    {/if}

    <!-- 和目录/番单同一个组件。少了「最新/最早」：一个季度块里年份季度都一样，那两项是空操作 -->
    <SortPill opts={SEASON_SORT_OPTS} sort={data.sort} {to} defaultSort={SEASON_DEFAULT_SORT} align="left" />

    <!-- 跳到很远的年份用这个；isDefault 恒 false：季度浏览永远有年份（那是这个页面的主轴） -->
    <YearPill years={data.years} year={data.year} season={data.season} {to}
              showDecade={false} showYearAll={false} label="年份" isDefault={false}
              dflt={data.year === data.cur.year && !data.seasonIsAll && data.season === data.cur.season}
              seasonAllValue="all" seasonAllOn={data.seasonIsAll} />

    {#if data.year !== data.cur.year || data.season !== data.cur.season || data.min !== 4 || !data.typesAreDefault || data.watches}
      <ResetButton href="/seasons" />
    {/if}
  </div>

  {#if data.season}
    <!-- 单季：hero 已经是标题，直接出网格 -->
    {#if data.grid[data.season].length}
      <div class="mt-4" data-season={data.season}><CardGrid items={data.grid[data.season]} showProgress eager /></div>
    {:else}
      <div class="mt-5">
        <EmptyState title="{data.year} 年{SEASON_CN[data.season]}季没有符合条件的番剧">
          {#if data.min > 1}<a href={to({ min: 1 })} class={EXIT}>门槛改为全部</a>{/if}
          {#if !data.typesAreDefault}<a href={to({ type: null })} class={EXIT}>全部类型</a>{/if}
          {#if data.watches}<a href={to({ watch: null })} class={EXIT}>「我的」改为全部</a>{/if}
        </EmptyState>
      </div>
    {/if}
  {:else}
    <!-- 四季总览：分节标题吸顶（顶栏下），季节色竖条；手机上每季一行横滑 -->
    <div class="mt-4 space-y-12">
      {#each shownSeasons as s (s)}
        <section aria-labelledby="sec-{s}" data-season={s}>
          <div class="sticky top-[var(--hdr-h)] z-20 -mx-4 flex items-center gap-2.5 bg-ink-950/80 px-4 py-2.5 backdrop-blur-md">
            <h2 id="sec-{s}" class="border-l-[3px] pl-3 text-[20px] font-semibold leading-tight sm:text-[22px] {TONE[s].bar}">
              {SEASON_CN[s]}季<span class="ml-2 text-[13px] font-normal text-ink-400">{fmtMonths(s)}</span>
            </h2>
            {#if isCur(data.year, s)}
              <span class="rounded-full px-2 py-0.5 text-[11px] font-semibold {TONE[s].soft} {TONE[s].text}">本季</span>
            {/if}
            <span class="text-[13px] tabular-nums text-ink-400">{data.counts[s]} 部</span>
            <!-- 吸顶条里不能把按钮撑到 44px（条会变厚），用 ::before 把命中区上下各扩 8px -->
            {#if data.counts[s] > data.grid[s].length}
              <a href={to({ season: s, p: null })}
                 class="relative ml-auto flex shrink-0 items-center gap-1 rounded-full border border-ink-600 bg-ink-900 px-3 py-1 text-[12px]
                        before:absolute before:-inset-y-2 before:inset-x-0
                        text-ink-200 transition hover:border-accent hover:text-accent-ink">
                查看全部<ArrowRight size={12} weight="bold" aria-hidden="true" />
              </a>
            {/if}
          </div>
          {#if data.grid[s].length}
            <div class="mt-3"><CardGrid items={data.grid[s]} variant="row" showProgress /></div>
          {:else}
            <p class="mt-3 py-6 text-center text-[13px] text-ink-400">没有符合条件的番剧</p>
          {/if}
        </section>
      {/each}
    </div>
  {/if}

  <Pager page={data.page} pages={data.pages} {to} sticky
         per={data.per} perIsDefault={data.perIsDefault} />
</Page>

<style>
  .chip {
    min-width: 4.5rem;
    border-radius: 12px;
    border: 1px solid var(--c-border);
    padding: 6px 12px;
    background: color-mix(in srgb, var(--c-surface) 72%, transparent);
    backdrop-filter: blur(8px);
    transition: border-color 150ms, background-color 150ms;
  }
  @media (min-width: 640px) {
    .chip { min-width: 5.25rem; padding: 7px 14px; }
    .step { width: 40px; }
  }
  .chip:not([aria-current]):not(.is-now):hover { border-color: var(--c-border-strong); }
  /* 选中 / 本季：和放送表日历条同一套（见上面切换条的注释） */
  .chip.is-on {
    border-color: var(--c-accent);
    background: var(--c-accent);
    color: var(--c-on-accent);
    box-shadow: 0 8px 22px -8px var(--c-accent);
  }
  .chip.is-now {
    border-color: color-mix(in srgb, var(--c-accent) 70%, transparent);
    background: color-mix(in srgb, var(--c-accent) 12%, var(--c-surface));
  }
  .chip.is-now:hover { background: color-mix(in srgb, var(--c-accent) 20%, var(--c-surface)); }
  .step {
    display: grid;
    place-items: center;
    width: 36px;
    flex: none;
    border-radius: 12px;
    border: 1px solid var(--c-border);
    background: color-mix(in srgb, var(--c-surface) 72%, transparent);
    color: var(--c-text-soft);
    transition: border-color 150ms;
  }
  .step:hover { border-color: var(--c-border-strong); }

  /* 扇形：中间一张最大、略抬高；两侧各转 7° 压在它下面 */
  .fan { align-items: flex-end; padding-bottom: 6px; }
  .fan-card { width: 50px; }
  .fan-0 { transform: rotate(-7deg) translate(14px, 6px); }
  .fan-1 { width: 60px; z-index: 2; transform: translateY(-4px); }
  .fan-2 { transform: rotate(7deg) translate(-14px, 6px); }
  @media (min-width: 640px) {
    .fan-card { width: 104px; }
    .fan-0 { transform: rotate(-7deg) translate(24px, 10px); }
    .fan-1 { width: 124px; transform: translateY(-8px); }
    .fan-2 { transform: rotate(7deg) translate(-24px, 10px); }
  }
  @media (hover: hover) {
    .fan-card:hover { z-index: 3; }
    .fan-0:hover { transform: rotate(-4deg) translate(10px, 0); }
    .fan-1:hover { transform: translateY(-12px); }
    .fan-2:hover { transform: rotate(4deg) translate(-10px, 0); }
  }
  @media (prefers-reduced-motion: reduce) { .fan-card { transition: none; } }
</style>
