<script>
  import PosterCard from '$lib/PosterCard.svelte';
  import Cover from '$lib/Cover.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import Section from '$lib/ui/Section.svelte';
  import MineHero from './MineHero.svelte';
  import ContinueShelf from './ContinueShelf.svelte';
  import { CARD_GRID } from '$lib/ui/grid.js';
  import MagnifyingGlass from 'phosphor-svelte/lib/MagnifyingGlass';
  import FunnelSimple from 'phosphor-svelte/lib/FunnelSimple';
  import Books from 'phosphor-svelte/lib/Books';
  import Chip from '$lib/ui/Chip.svelte';
  import FilterPill from '$lib/ui/FilterPill.svelte';
  import MultiChip from '$lib/ui/MultiChip.svelte';
  import YearPill from '$lib/ui/YearPill.svelte';
  import SortPill from '$lib/ui/SortPill.svelte';
  import { GENRE_NAMES } from '$lib/genres.js';
  import { TYPE_CN, MINE_TABS, SORT_OPTS, DEFAULT_SORT, SEASON_CN, YEAR_FLOOR } from '$lib/constants.js';
  import { makeSetter, makeHref } from '$lib/urlState.js';
  import { moveGenre as moveIn, genreSummary } from '$lib/urlBuild.js';
  import ActiveChips from '$lib/ui/ActiveChips.svelte';
  import { CTA } from '$lib/ui/btn.js';
  import { centerCurrent } from '$lib/centerCurrent.js';
  import { page as pg } from '$app/state';
  import Page from '$lib/ui/Page.svelte';
  import ResetButton from '$lib/ui/ResetButton.svelte';
  import Pager from '$lib/ui/Pager.svelte';
  import SearchBox from '$lib/ui/SearchBox.svelte';
  import Toggle from '$lib/ui/Toggle.svelte';
  import GenrePicker from '$lib/ui/GenrePicker.svelte';
  import LoginGate from '$lib/ui/LoginGate.svelte';
  let { data } = $props();

  const f = $derived(data.f);
  const set = $derived(makeSetter('/mine', pg.url.searchParams));
  const to = $derived(makeHref('/mine', pg.url.searchParams));

  const moveGenre = (target, g) => moveIn(f, target, g);

  // 题材计数由 loader 按番剧去重算好（前端原来用「各标签取 max」，
  // 跨标签的番会被漏掉 —— 和统计页那个偏低 32% 的 bug 同一个成因）。
  // 番单为空时 loader 回退到全量题材，此时不显示数量。
  const myGenres = $derived(data.facets.genreCounts);
  /** 题材 → 我有多少部。null 表示这个题材我没有（番单为空时 loader 给的计数是 null） */
  const myCount = $derived(Object.fromEntries(myGenres.filter(([, c]) => c)));
  const typeOpts = $derived(data.facets.types.map((t) => [t.type, TYPE_CN[t.type] ?? t.type, t.c]));

  const sum = $derived({
    type: f.typesAreDefault ? null : (f.types ?? []).map((t) => TYPE_CN[t] ?? t).join('·'),
    genre: genreSummary(f),
    time: f.season ? `${f.yearMin ?? ''}${SEASON_CN[f.season]}`
        : f.yearMin && f.yearMin === f.yearMax ? String(f.yearMin)
        : f.yearMin ? `${f.yearMin}–${f.yearMax ?? '今'}` : null,
    num: [f.scoreMin ? `≥${f.scoreMin}分` : null, f.epMax ? `≤${f.epMax}集` : null,
          f.isShort === 1 ? '泡面番' : null,
      f.myScore === 'none' ? '未评分' : f.myScore === 'has' ? '已评分' : null].filter(Boolean).join('·') || null
  });
  const activeCount = $derived(
    f.genres.length + f.genresAny.length + f.genresNot.length +
    (f.typesAreDefault ? 0 : 1) + (f.yearMin ? 1 : 0) + (f.season ? 1 : 0) +
    (f.scoreMin ? 1 : 0) + (f.epMax ? 1 : 0) + (f.isShort !== null ? 1 : 0) + (f.q ? 1 : 0) +
    // ⚠️ myScore 也要算。漏了它的后果：只开「未评分」时 activeCount 是 0，
    // 空状态就走「此分类暂无内容 + 去快速标记」那一支 —— 番单明明有几百部，
    // 只是这个筛选下没有了。筛选栏能设的每一项都必须算进来。
    (f.myScore ? 1 : 0)
  );
  const chips = $derived([
    ...(f.typesAreDefault ? [] : (f.types ?? []).map((t) => ({
      k: `t${t}`, text: TYPE_CN[t] ?? t, off: () => set({ type: (f.types ?? []).filter((x) => x !== t) }) }))),
    ...f.genres.map((g) => ({ k: `g${g}`, text: g, off: () => set(moveGenre('g', g)) })),
    ...f.genresAny.map((g) => ({ k: `a${g}`, text: `${g}（任一）`, off: () => set(moveGenre('any', g)) })),
    ...f.genresNot.map((g) => ({ k: `n${g}`, text: `排除 ${g}`, tone: 'danger', off: () => set(moveGenre('ng', g)) })),
    ...(sum.time ? [{ k: 'y', text: sum.time, off: () => set({ from: null, to: null, season: null }) }] : []),
    ...(f.scoreMin ? [{ k: 's', text: `评分≥${f.scoreMin}`, off: () => set({ smin: null }) }] : []),
    ...(f.epMax ? [{ k: 'e', text: `≤${f.epMax}集`, off: () => set({ epmax: null }) }] : []),
    ...(f.isShort === 1 ? [{ k: 'sh', text: '泡面番', off: () => set({ short: null }) }] : [])
  ]);
  const base = $derived(`/mine?status=${data.status}`);

  /** 单一状态的页签里，卡片上的状态徽标全是同一个字，去掉 */
  const single = $derived(data.status !== 'active');
  const tabName = $derived(Object.fromEntries(MINE_TABS)[data.status] ?? '全部');
  /** 「继续看」只在「全部」的第一页、没有筛选 / 搜索时出现 —— 筛选后还挂着它像是筛选没生效 */
  const showShelf = $derived(data.shelf.length > 0 && data.page === 1 && !activeCount);
  const EMPTY_TITLE = { active: '番单还是空的', plan: '还没有想看的番', watching: '还没有在看的番',
                        completed: '还没有看完的番', on_hold: '没有搁置的番', dropped: '没有弃番' };
  const EMPTY_EXIT = { active: ['/triage', '去快速标记'], completed: ['/triage', '去快速标记'], plan: ['/catalog', '去目录'] };

  /**
   * 手机上搜索收成一个放大镜，点开才出输入框（有搜索词时默认展开）。
   * ⚠️ 跟随导航：清掉搜索词（重置）后要收回去，所以用 $effect 而不是只在初始化时取一次
   */
  let searchOpen = $state(false);
  $effect(() => { searchOpen = !!data.f.q; });
</script>

<Page fill>
{#if !data.user}
  <LoginGate title="我的番单" line="登录后查看你的番单" />
{:else}
  <MineHero hero={data.hero} stats={data.stats} name={data.user.username} />

  <!-- 下划线页签：一行横滑，计数是小胶囊，0 的整格弱化 -->
  <!-- 手机上一行横滑：当前页签（比如「弃番」）不在可视范围时滚到中间 -->
  <nav use:centerCurrent={data.status} class="no-scrollbar -mx-4 mt-3 flex overflow-x-auto border-b border-ink-700 px-2 sm:mx-0 sm:mt-4 sm:px-0"
       aria-label="番单分类">
    {#each MINE_TABS as [v, l]}
      {@const n = data.stats[v] ?? 0}
      {@const on = data.status === v}
      <a href="/mine?status={v}" aria-current={on ? 'page' : undefined}
         class="relative flex shrink-0 items-center gap-1.5 px-2.5 py-2.5 text-[14px] transition-colors sm:px-3.5
                {on ? 'font-semibold text-ink-100' : n ? 'text-ink-200 hover:text-ink-100' : 'text-ink-400 hover:text-ink-200'}">
        {l}
        <span class="min-w-[1.375rem] rounded-full px-1.5 text-center text-[11px] font-medium leading-[18px] tabular-nums
                     {on ? 'bg-accent text-on-accent' : n ? 'bg-ink-800 text-ink-200' : 'text-ink-400'}">{n}</span>
        {#if on}<span class="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent sm:inset-x-3"></span>{/if}
      </a>
    {/each}
  </nav>

  <!-- 与目录页同一套胶囊筛选栏。番单空的时候也要在（选项回退到全量）。
       搜索时筛选不生效 —— 开关放在最左边（和目录页一致），右边整排置灰当信号，
       不写「搜索结果不受下面的筛选影响」那种反着说的说明 -->
  <div class="mt-3 flex flex-wrap items-center gap-1.5">
      <!-- 手机：搜索收成放大镜（页面层处理，不改 SearchBox） -->
      <button type="button" onclick={() => (searchOpen = !searchOpen)} aria-expanded={searchOpen}
              aria-label="搜索" title="搜索"
              class="grid size-11 shrink-0 place-items-center rounded-xl border bg-ink-900 transition sm:hidden
                     {searchOpen || f.q ? 'border-accent text-accent' : 'border-ink-600 text-ink-200'}">
        <MagnifyingGlass size={17} weight="bold" />
      </button>

      <FilterPill label="类型" summary={sum.type}
                  count={f.typesAreDefault ? 0 : (f.types ?? []).length} w="21rem" muted={data.filtersMuted}>
        <MultiChip param="type" opts={typeOpts} selected={f.types}
                   isDefault={f.typesAreDefault} href={to} />
      </FilterPill>

      <FilterPill label="题材" summary={sum.genre}
                    count={f.genres.length + f.genresAny.length + f.genresNot.length} w="30rem" scroll muted={data.filtersMuted}>
          <!--
            顺序必须和目录页一致（都按 GENRE_NAMES 的固定顺序）——
            原来这里按「我有多少部」降序排，两个面板看起来像两套列表，
            而且条数一变位置就跟着动。番单只是把「自己有的」排在前半段、
            带上条数，展开才出剩下的。
          -->
          <GenrePicker genres={f.genres} any={f.genresAny} not={f.genresNot}
                       gm={pg.url.searchParams.get('gm')}
                       names={[...GENRE_NAMES.filter((g) => myCount[g]),
                               ...GENRE_NAMES.filter((g) => !myCount[g])]}
                       limit={GENRE_NAMES.filter((g) => myCount[g]).length}
                       counts={myCount} {to} />
        </FilterPill>

      <YearPill years={data.facets.years} year={f.yearMin} yearMax={f.yearMax}
                season={f.season} {to} showRange yearFloor={YEAR_FLOOR} muted={data.filtersMuted} />

      <FilterPill label="评分" summary={sum.num}
                  count={[f.scoreMin, f.epMax, f.isShort === 1 ? 1 : null, f.myScore].filter(Boolean).length} w="16rem" muted={data.filtersMuted}>
        <div class="mb-1.5 flex flex-wrap gap-1.5">
          <Chip on={!f.scoreMin && !f.epMax && f.isShort === null && !f.myScore}
                href={to({ smin: null, epmax: null, short: null, ms: null })}>全部</Chip>
          <Chip on={f.isShort === 1} href={to({ short: f.isShort === 1 ? null : '1' })}>泡面番</Chip>
        </div>
        <div class="mb-1.5 text-[12px] text-ink-400">我的评分</div>
        <div class="flex flex-wrap gap-1.5">
          <Chip on={!f.myScore} href={to({ ms: null })}>全部</Chip>
          <Chip on={f.myScore === 'none'} href={to({ ms: f.myScore === 'none' ? null : 'none' })}>未评分</Chip>
          <Chip on={f.myScore === 'has'} href={to({ ms: f.myScore === 'has' ? null : 'has' })}>已评分</Chip>
        </div>
        {#each [['smin', 'Bangumi 评分 ≥', f.scoreMin, '0.1'], ['epmax', '集数 ≤', f.epMax, '1']] as [k, l, v, step]}
          <label class="mt-1.5 block text-[12px] text-ink-400">{l}
            <input type="number" {step} value={v ?? ''} placeholder="不限"
                   onchange={(e) => set({ [k]: e.currentTarget.value })}
                   class="mt-1 w-full rounded-md border border-ink-600 bg-ink-900 px-2 py-1.5 text-[13px]" /></label>
        {/each}
      </FilterPill>

      {#if activeCount}
        <ResetButton href={base} />
      {/if}

      <div class="hidden min-w-[15rem] flex-1 sm:block [&>form]:mt-0">
        <SearchBox value={data.f.q ?? ''} placeholder="在此分类中搜索"
                   onsubmit={(v) => set({ q: v || null })} />
      </div>

      <!-- 「应用筛选」排在最后，和目录页一致 -->
      {#if f.q}
        <Toggle on={f.applyFilters} href={to({ qf: f.applyFilters ? null : '1' })} label="应用筛选" />
      {/if}
    </div>

    {#if searchOpen}
      <div class="sm:hidden [&>form]:mt-2">
        <SearchBox value={data.f.q ?? ''} placeholder="在此分类中搜索"
                   onsubmit={(v) => set({ q: v || null })} />
      </div>
    {/if}

    <ActiveChips {chips} muted={data.filtersMuted} />

  {#if showShelf}
    <Section title="继续看" count={data.shelf.length}>
      <ContinueShelf items={data.shelf} />
    </Section>
  {/if}

  {#if !data.rows.length}
    <!-- 空状态：几张淡化的封面叠在背后当装饰 -->
    <!-- 有装饰封面时它就是图标：藏掉 EmptyState 自带的图标，标题挪到封面下面 -->
    <div class="relative isolate mt-6 overflow-hidden rounded-2xl border border-ink-700 bg-ink-900
                {data.deco.length ? '[&>[role=status]>svg:first-child]:hidden [&>[role=status]]:pt-[160px] sm:[&>[role=status]]:pt-[184px]' : ''}">
      {#if data.deco.length}
        <div class="pointer-events-none absolute inset-x-0 top-8 -z-10 flex justify-center opacity-50
                    [mask-image:linear-gradient(to_bottom,#000_35%,transparent_95%)]" aria-hidden="true">
          {#each data.deco as a, i (a.id)}
            <div class="w-20 overflow-hidden rounded-lg shadow-lift sm:w-24
                        {i === 0 ? '-rotate-10 translate-x-6 translate-y-3' : i === 1 ? 'z-10' : 'rotate-10 -translate-x-6 translate-y-3'}">
              <Cover {a} cls="aspect-2/3" />
            </div>
          {/each}
        </div>
      {/if}
      {#if activeCount}
        <EmptyState bare icon={FunnelSimple} title={f.q ? `没有找到「${f.q}」` : '没有符合条件的番'}>
          <ResetButton href={base} label="清除筛选" />
        </EmptyState>
      {:else}
        <!-- 出口按页签给：快速标记只会标「看过」，所以只对「全部 / 看完」有用；
             「想看」是去目录挑；在看 / 搁置 / 弃番空着是正常状态，不硬塞一个按钮 -->
        <EmptyState bare icon={Books} title={EMPTY_TITLE[data.status] ?? '此分类暂无内容'}>
          {#if EMPTY_EXIT[data.status]}
            <a href={EMPTY_EXIT[data.status][0]} class={CTA}>
              {EMPTY_EXIT[data.status][1]}
            </a>
          {/if}
        </EmptyState>
      {/if}
    </div>
  {:else}
    <Section title={data.status === 'active' ? '全部收藏' : tabName} count="{data.total} 部" >
      <!-- 排序跟着网格走（手机上筛选栏因此一行放得下） -->
      {#snippet actions()}
        <SortPill opts={SORT_OPTS} sort={data.sort} sort2={data.sort2} {to} defaultSort={DEFAULT_SORT} />
      {/snippet}
      <div class="grid gap-x-3.5 gap-y-5 {CARD_GRID}">
        {#each data.rows as a, i (a.id)}
          <!-- 在看的封面底边一条 3px 进度（只在番单页）；跟着卡片的悬停抬起一起动 -->
          {@const prog = a.my_status === 'watching' && a.episodes && a.current_episode != null
                         ? Math.min(100, (a.current_episode / a.episodes) * 100) : null}
          <div class="group/p relative min-w-0">
            <PosterCard {a} score="mine" hideStatus={single}
                        showProgress={a.my_status !== 'completed'} eager={i < 8} />
            {#if prog != null}
              <div class="pointer-events-none absolute inset-x-0 top-0 aspect-2/3 overflow-hidden rounded-xl
                          transition-transform duration-200 ease-out group-hover/p:-translate-y-0.5" aria-hidden="true">
                <div class="absolute inset-x-0 bottom-0 h-[3px] bg-black/55">
                  <div class="h-full bg-accent shadow-[0_0_6px_var(--c-accent)]" style="width:{prog}%"></div>
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </Section>
    <Pager page={data.page} pages={Math.max(1, Math.ceil(data.total / data.per))} {to} sticky
           per={data.per} perIsDefault={data.perIsDefault} />
  {/if}
{/if}
</Page>
