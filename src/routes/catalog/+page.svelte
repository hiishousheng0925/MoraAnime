<script>
  import CardGrid from '$lib/ui/CardGrid.svelte';
  import Chip from '$lib/ui/Chip.svelte';
  import FilterPill from '$lib/ui/FilterPill.svelte';
  import MultiChip from '$lib/ui/MultiChip.svelte';
  import SortPill from '$lib/ui/SortPill.svelte';
  import Pager from '$lib/ui/Pager.svelte';
  import Toggle from '$lib/ui/Toggle.svelte';
  import YearPill from '$lib/ui/YearPill.svelte';
  import SaveFilter from '$lib/ui/SaveFilter.svelte';
  import { GENRE_NAMES } from '$lib/genres.js';
  import { TYPE_OPTS, TYPE_CN, STATUS_OPTS, STATUS_CN, SEASON_OPTS, SEASON_OPTS_M, SEASON_CN, WEEKDAY_OPTS, WATCH_OPTS, WATCH_STATUS, SORT_OPTS, DECADE_OPTS, DEFAULT_SORT, DEFAULT_SORT2, STATUS_OPTS_ALL } from '$lib/constants.js';
  import { makeSetter, makeHref, toggleIn } from '$lib/urlState.js';
  import { page as pg } from '$app/state';
  import Page from '$lib/ui/Page.svelte';
  import ResetButton from '$lib/ui/ResetButton.svelte';
  import SearchBox from '$lib/ui/SearchBox.svelte';
  import GenrePicker from '$lib/ui/GenrePicker.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import X from 'phosphor-svelte/lib/X';
  import { edgeFade } from '$lib/edgeFade.js';
  let { data } = $props();

  let studioKw = $state('');
  /** 空结果里的出口胶囊 */
  const EXIT = 'tap rounded-full border border-ink-600 bg-ink-900 px-3.5 py-1.5 text-[13px] text-ink-200 transition hover:border-accent hover:text-accent-ink';

  const f = $derived(data.f);
  const set = $derived(makeSetter('/catalog', pg.url.searchParams));
  const to = $derived(makeHref('/catalog', pg.url.searchParams));
  const years = $derived(data.facets.years);
  /** 把某个题材放进指定槽位，并从其他槽位移除（同一题材只能在一个槽位） */
  function moveGenre(target, g) {
    const cur = { g: f.genres, any: f.genresAny, ng: f.genresNot };
    const has = cur[target].includes(g);
    const out = {};
    for (const k of ['g', 'any', 'ng']) out[k] = cur[k].filter((x) => x !== g);
    if (!has) out[target] = [...out[target], g];
    return { g: out.g, any: out.any, ng: out.ng, gm: null };
  }

  let studioSort = $state('count');   // count | name
  const shownStudios = $derived.by(() => {
    const kw = studioKw.trim().toLowerCase();
    let list = kw
      ? data.facets.studios.filter((s) => (s.label ?? s.studio).toLowerCase().includes(kw))
      : data.facets.studios;
    return studioSort === 'name'
      ? [...list].sort((a, b) => (a.label ?? a.studio).localeCompare(b.label ?? b.studio))
      : list;   // facet 已按作品数降序
  });
  const totalPages = $derived(Math.ceil(data.total / data.per));
  const activeCount = $derived(
    f.genres.length + f.genresAny.length + f.genresNot.length + (f.typesAreDefault ? 0 : 1) +
    (f.yearIsDefault ? 0 : 1) + (f.yearMax ? 1 : 0) + (f.season ? 1 : 0) +
    (f.status ? 1 : 0) + (f.weekday ? 1 : 0) + (f.isShort !== null ? 1 : 0) +
    (f.epMax ? 1 : 0) + (f.scoreMin ? 1 : 0) + (f.votesMin ? 1 : 0) +
    (f.watch ? 1 : 0) + (f.studio ? 1 : 0)
  );
  const WD = $derived(Object.fromEntries(WEEKDAY_OPTS));

  /** 每枚胶囊上直接显示当前值 —— 不用展开就知道筛了什么 */
  const sum = $derived({
    // 高亮口径：只要该筛选正在缩小结果就显示（默认的 TV·剧场版·OVA 确实排除了 ONA/SP，
    // 默认的完结状态确实排除了未上映）—— 否则用户看不出东西是被默认藏掉的。
    // 题材「全部」不缩小结果，所以不高亮。
    type: f.types ? f.types.map((t) => TYPE_CN[t] ?? t).join('·') : null,
    genre: (() => {
      const parts = [];
      if (f.genres.length) parts.push(f.genres.join('+'));
      if (f.genresAny.length) parts.push(`(${f.genresAny.join('|')})`);
      if (f.genresNot.length) parts.push(`−${f.genresNot.join(',')}`);
      const t = parts.join(' ');
      return t ? (t.length > 18 ? t.slice(0, 17) + '…' : t) : null;
    })(),
    time: f.season ? `${f.yearMin}${SEASON_CN[f.season]}`
        : f.yearMax && f.yearMin !== f.yearMax ? `${f.yearMin}–${f.yearMax}`
        : !f.yearIsDefault ? `${f.yearMin}` : null,
    air: [(f.statuses ?? []).map((x) => STATUS_CN[x]).join('·') || null, f.weekday ? WD[f.weekday] : null,
          f.isShort === 1 ? '泡面番' : null].filter(Boolean).join('·') || null,
    num: [f.scoreMin ? `≥${f.scoreMin}分` : null, f.votesMin ? `≥${f.votesMin}评` : null,
          f.epMax ? `≤${f.epMax}集` : null,
          f.myScore === 'none' ? '未评分' : f.myScore === 'has' ? '已评分' : null]
      .filter(Boolean).join('·') || null,
    studio: f.studio ? (data.facets.studios.find((x) => x.studio === f.studio)?.label ?? f.studio) : null,
    mine: f.watch ? (f.watch === 'none' ? '未标记' : WATCH_STATUS[f.watch]) : null
  });

  /** 已生效筛选，逐项可删 */
  const chips = $derived([
    ...(f.typesAreDefault || !f.types ? [] : f.types.map((t) => ({
      k: `t${t}`, text: TYPE_CN[t] ?? t, off: () => set({ type: toggleIn(f.types ?? [], t) }) }))),
    ...f.genres.map((g) => ({ k: `g${g}`, text: g, off: () => set(moveGenre('g', g)) })),
    ...f.genresAny.map((g) => ({ k: `a${g}`, text: `${g}（任一）`, off: () => set(moveGenre('any', g)) })),
    ...f.genresNot.map((g) => ({ k: `n${g}`, text: `排除 ${g}`, tone: 'danger',
      off: () => set(moveGenre('ng', g)) })),
    ...(sum.time ? [{ k: 'time', text: sum.time, off: () => set({ from: null, to: null, season: null }) }] : []),
    ...(f.statusIsDefault ? [] : !f.statuses
      ? [{ k: 'stall', text: '全部状态', off: () => set({ status: null }) }]
      : f.statuses.map((v) => ({ k: 'st' + v, text: STATUS_CN[v],
          off: () => set({ status: toggleIn(f.statuses, v) }) }))),
    ...(f.weekday ? [{ k: 'wd', text: WD[f.weekday] + '更新', off: () => set({ wd: null }) }] : []),
    ...(f.isShort === 1 ? [{ k: 'sh', text: '泡面番', off: () => set({ short: null }) }] : []),
    ...(f.scoreMin ? [{ k: 'sm', text: `评分≥${f.scoreMin}`, off: () => set({ smin: null }) }] : []),
    ...(f.votesMin ? [{ k: 'vm', text: `评价≥${f.votesMin}`, off: () => set({ vmin: null }) }] : []),
    ...(f.epMax ? [{ k: 'em', text: `≤${f.epMax}集`, off: () => set({ epmax: null }) }] : []),
    // 胶囊上写展示名，不写内部的归一名（原来是「madhouse ✕」，按钮上却是 Madhouse，#109）
    ...(f.studio ? [{ k: 'sd', text: sum.studio ?? f.studio, off: () => set({ studio: null }) }] : []),
    ...(f.watch ? [{ k: 'w', text: sum.mine, off: () => set({ watch: null }) }] : [])
  ]);

</script>

<Page fill>
  <div class="flex items-baseline gap-2.5">
    <h1 class="text-2xl font-semibold tracking-tight">目录</h1>
    <span class="text-[13px] tabular-nums text-ink-400">{data.total.toLocaleString()} 部</span>
  </div>

  <!-- 搜索保留其他参数，但默认不生效（筛选栏会置灰）——
       想把筛选叠到搜索结果上，用筛选栏最左边那个开关。 -->
  <SearchBox value={data.f.q ?? ''} placeholder="搜中文 / 日文 / 罗马字 / 英文名…"
             onsubmit={(v) => set({ q: v || null })} />

  <!-- 常驻筛选栏：每类一枚胶囊，点开只弹这一类。
       桌面：flex-wrap 换行。⚠️ 桌面不能用 overflow-x-auto —— 它会同时在垂直方向建立裁剪上下文，
       把绝对定位的弹层裁掉（表现为点了没反应）。
       手机：单行横滑 + 右侧渐隐（换行时 4 行吃掉首屏 45%）。这时弹层全部走底部抽屉 Sheet（挂在 body 下），
       不受这里的裁剪影响。-mx-4 px-4 让横滑贴到屏幕边。 -->
  <div use:edgeFade class="mt-3 flex flex-wrap items-center gap-1.5
              max-sm:-mx-4 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:overscroll-x-contain max-sm:px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-sm:pb-1">
    <FilterPill label="类型" summary={sum.type} dflt={f.typesAreDefault}
                count={(f.types ?? []).length} w="21rem" muted={data.filtersMuted}>
      <MultiChip param="type" opts={TYPE_OPTS} selected={f.types}
                 isDefault={f.typesAreAll} href={to} allValue="all" />
    </FilterPill>

    <FilterPill label="题材"
                summary={sum.genre}
                count={f.genres.length + f.genresAny.length + f.genresNot.length}
                w="30rem" scroll muted={data.filtersMuted}>

      <GenrePicker genres={f.genres} any={f.genresAny} not={f.genresNot}
                   gm={pg.url.searchParams.get('gm')}
                   names={GENRE_NAMES} {to} />
    </FilterPill>

    <YearPill years={years} year={f.yearIsDefault ? null : f.yearMin} yearMax={f.yearMax}
               season={f.season} {to} showRange yearFloor={data.yearFloor}  muted={data.filtersMuted}/>

    <FilterPill label="放送" summary={sum.air} dflt={f.statusIsDefault && !f.weekday && f.isShort === null}
                count={[f.statuses ? 1 : null, f.weekday, f.isShort !== null ? 1 : null].filter(Boolean).length} w="22rem" muted={data.filtersMuted}>
      <div class="mb-1 text-[12px] text-ink-400">完结状态</div>
      <MultiChip param="status" opts={STATUS_OPTS_ALL} selected={f.statuses}
                 isDefault={!f.statuses} href={to} allValue="all" />

      <div class="mt-3 mb-1 text-[12px] text-ink-400">形态</div>
      <div class="flex flex-wrap gap-1.5">
        <Chip on={f.isShort === null} href={to({ short: null })}>全部</Chip>
        <Chip on={f.isShort === 1} href={to({ short: '1' })}>泡面番</Chip>
        <Chip on={f.isShort === 0} href={to({ short: '0' })}>非泡面番</Chip>
      </div>
      <div class="mt-3 mb-1 text-[12px] text-ink-400">更新日 <span>· 仅当季在播</span></div>
      <div class="flex flex-wrap gap-1.5">
        <Chip on={!f.weekday} href={to({ wd: null })}>全部</Chip>
        {#each WEEKDAY_OPTS as [v, l]}
          <Chip on={f.weekday === v} href={to({ wd: f.weekday === v ? null : v })}>{l}</Chip>
        {/each}
      </div>
    </FilterPill>

    <FilterPill label="评分" summary={sum.num} count={[f.scoreMin, f.votesMin, f.epMax, f.myScore].filter(Boolean).length} w="15rem" muted={data.filtersMuted}>
      <div class="mb-1.5 flex flex-wrap gap-1.5">
        <Chip on={!f.scoreMin && !f.votesMin && !f.epMax && !f.myScore}
              href={to({ smin: null, vmin: null, epmax: null, ms: null })}>全部</Chip>
      </div>
      <div class="mb-1.5 text-[12px] text-ink-400">我的评分</div>
      <div class="flex flex-wrap gap-1.5">
        <Chip on={!f.myScore} href={to({ ms: null })}>全部</Chip>
        <Chip on={f.myScore === 'none'} href={to({ ms: f.myScore === 'none' ? null : 'none' })}>未评分</Chip>
        <Chip on={f.myScore === 'has'} href={to({ ms: f.myScore === 'has' ? null : 'has' })}>已评分</Chip>
      </div>
      {#each [['smin', 'Bangumi 评分 ≥', f.scoreMin, '不限', '0.1'],
              ['vmin', '评价人数 ≥', f.votesMin, '过滤冷门', '1'],
              ['epmax', '集数 ≤', f.epMax, '不限', '1']] as [k, l, v, ph, step]}
        <label class="mt-1.5 block text-[12px] text-ink-400">{l}
          <input type="number" {step} value={v ?? ''} placeholder={ph}
                 onchange={(e) => set({ [k]: e.currentTarget.value })}
                 class="mt-1 w-full rounded-md border border-ink-600 bg-ink-900 px-2 py-1.5 text-[13px]" /></label>
      {/each}
    </FilterPill>

    <FilterPill label="制作公司" summary={sum.studio} count={f.studio ? 1 : 0} w="22rem" scroll muted={data.filtersMuted}>
      <div class="flex items-center gap-2">
        <input bind:value={studioKw} placeholder="搜索制作公司"
               class="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 text-[13px]
                      outline-none placeholder:text-ink-400 focus:border-accent" />
        <button onclick={() => (studioSort = studioSort === 'count' ? 'name' : 'count')}
                class="shrink-0 rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 text-[12px] text-ink-200">
          {studioSort === 'count' ? '按作品数' : '按名称'}
        </button>
      </div>
      <div class="mt-2 space-y-0.5">
        <!-- ⚠️ 必须是 <a>：<button> 不认 href，点了什么都不会发生（实测点制作公司无反应） -->
        <a href={to({ studio: null })}
           class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px]
                  {!f.studio ? 'bg-accent/15 text-accent-ink' : 'text-ink-200 hover:bg-ink-700'}">
          <span class="w-3 text-[11px]">{!f.studio ? '✓' : ''}</span>全部
        </a>
        {#each shownStudios as s2 (s2.studio)}
          <a href={to({ studio: s2.studio })}
             class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px]
                    {f.studio === s2.studio ? 'bg-accent/15 text-accent-ink' : 'text-ink-200 hover:bg-ink-700'}">
            <span class="w-3 shrink-0 text-[11px]">{f.studio === s2.studio ? '✓' : ''}</span>
            <span class="min-w-0 flex-1 truncate">{s2.label ?? s2.studio}</span>
            <span class="shrink-0 text-[11px] {f.studio === s2.studio ? '' : 'text-ink-400'}">{s2.c}</span>
          </a>
        {/each}
        {#if !shownStudios.length}
          <div class="px-2 py-2 text-[12px] text-ink-400">无匹配</div>
        {/if}
      </div>
    </FilterPill>

    <FilterPill label="我的" summary={sum.mine} count={f.watch ? 1 : 0} w="20rem" align="right" muted={data.filtersMuted}>
      <div class="flex flex-wrap gap-1.5">
        <Chip on={!f.watch} href={to({ watch: null })}>全部</Chip>
        <Chip on={f.watch === 'none'} href={to({ watch: f.watch === 'none' ? null : 'none' })}>未标记</Chip>
        {#each WATCH_OPTS as [v, l]}
          <Chip on={f.watch === v} href={to({ watch: f.watch === v ? null : v })}>{l}</Chip>
        {/each}
      </div>
    </FilterPill>

    <!-- 排序 / 我的筛选 / 重置是「动作」不是「条件」：打成一组靠右（ml-auto），一行放不下时整组一起换行，
         不会只剩「重置」一个孤零零掉到第二行（选了题材 + 年份后，1440 宽下原来就是这样）。
         手机上整条横滑：这一组拆成 contents，成员直接排进横滑栏（「应用筛选」才能 order-first 排到最前），用竖线隔开。 -->
    <div class="flex shrink-0 items-center gap-1.5 max-sm:contents sm:ml-auto">
      <span class="mx-0.5 w-px shrink-0 self-stretch bg-ink-700 sm:hidden"></span>

      <SortPill opts={SORT_OPTS} sort={data.sort} sort2={data.sort2} {to} defaultSort={DEFAULT_SORT} />

      <!-- 「设为默认」并进了「我的筛选」：默认是某套保存组合的属性，不再是独立入口 -->
      <SaveFilter query={pg.url.searchParams.toString()} saved={data.savedFilters}
                  canSave={activeCount > 0 || !!f.q}
                  systemIsDefault={!data.savedFilters.some((x) => x.is_default)} />

      <!-- 一键重置全部筛选（含搜索词与排序）-->
      <!-- 原来写的是 sort !== 'popular'，可目录的默认排序是「最新」—— 于是什么都没改时「重置」也一直挂着 -->
      {#if activeCount || f.q || data.sort !== DEFAULT_SORT || data.sort2 !== DEFAULT_SORT2}
        <ResetButton href="/catalog" />
      {/if}

      <!-- 「应用筛选」开关排在最后（重置之后），在右侧那组里。
           它在筛选栏【里面】而不是单独占一行浮在上面，也不塞进搜索框
           （框内控件按惯例属于「输入内容本身」：清空、提交；这个开关管的是筛选栏，
           塞进去心智模型是错的，还会吃掉可输入区、让 ✕ 的位置跟着跳）。
           标签只写「应用筛选」不写「搜索时应用筛选」：它只在有搜索词时出现，
           「搜索时」三个字是废话，还会多占 40px。
           也不写「搜索结果不受下面的筛选影响」那句说明：
           ① 和开关本身的状态是同一件事、还反着说，得做一次双重否定
           ② 和置灰重复 —— 关掉时整排胶囊都 opacity-40，那本身就是信号 -->
      {#if f.q}
        <!-- 手机上排到最前：搜索时这两个开关才是主角，放在横滑栏末尾就看不到了 -->
        <div class="flex shrink-0 items-center gap-1.5 max-sm:order-first">
          <Toggle on={f.applyFilters} href={to({ qf: f.applyFilters ? null : '1' })} label="应用筛选" />
          {#if data.beforeWindow}
            <Toggle on={f.skipYearWindow} href={to({ yw: f.skipYearWindow ? null : '0' })}
                    label="含 {data.yearFloor} 年前 {data.beforeWindow.toLocaleString()} 部" />
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <!-- 已生效筛选：看得见、可逐项删（手机上同样单行横滑） -->
  {#if chips.length}
    <!-- 搜索时这些筛选没生效，跟着置灰 -->
    <div use:edgeFade class="mt-2 flex flex-wrap items-center gap-1.5
                max-sm:-mx-4 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:overscroll-x-contain max-sm:px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden
                {data.filtersMuted ? 'pointer-events-none opacity-40' : ''}">
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

  {#if !data.rows.length}
    <!-- 空结果：标题就是状态；下面给 1–3 个真能救回结果的出口（按实际情况出现） -->
    <div class="mt-6">
      <EmptyState title={f.q ? `没有找到「${f.q}」` : '没有符合条件的番剧'}>
        {#if f.q}
          <a href={to({ q: null, qf: null, yw: null })} class={EXIT}>清空搜索</a>
        {/if}
        {#if data.beforeWindow && !f.skipYearWindow}
          <a href={to({ yw: '0' })} class={EXIT}>含 {data.yearFloor} 年前 {data.beforeWindow.toLocaleString()} 部</a>
        {/if}
        {#if data.relaxStatus && (!f.q || f.applyFilters)}
          <a href={to({ status: 'all' })} class={EXIT}>含未上映 {data.relaxStatus.toLocaleString()} 部</a>
        {/if}
        {#if activeCount && (!f.q || f.applyFilters)}
          <a href="/catalog" class={EXIT}>恢复默认筛选</a>
        {/if}
        {#if data.defaultActive}
          <a href="/catalog?raw=1" class={EXIT}>回到系统默认</a>
        {/if}
      </EmptyState>
    </div>
  {:else}
    <div class="mt-4"><CardGrid items={data.rows} showProgress /></div>
    <Pager page={data.page} pages={totalPages} {to} sticky
           per={data.per} perIsDefault={data.perIsDefault} />
  {/if}
</Page>

