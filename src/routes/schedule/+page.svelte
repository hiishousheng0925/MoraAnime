<script>
  /**
   * 放送表（2026-10 UI 大改第 2 段）：
   *   · 顶部日历条：七个等宽格子（星期 / 日期 / N 部）+ 虚线「全周」；选中的那天实色 accent；
   *     今天没被选中时描 accent 边；已过的日子字色降一档。手机横滑，打开时把选中格滚到中间
   *   · 「在看」的番做横幅主卡（封面氛围背景、今天更新的呼吸点、双层进度条、▶ 第 N 集 / +1）：
   *     单日视图里当天的在看都上主卡；全周视图只有「今天」那节上主卡，其余天照常进海报网格
   *   · 其余番是海报网格：左下集数角标（今天更新的实色）、右下评分、右上书签 = 追番 / 取消追番
   *     （桌面悬停出现，触屏常显；在看的常显实心）
   *   · 收藏 < COLD 的冷门番收进当天末尾「其余 N 部冷门番」，在看的永远不收
   *   · 取消追番：有进度 / 评分 / 短评时先确认（同详情页「从番单移除」）；刚点的追番直接撤
   * 2026-10-18 那版的规矩都留着：追番一键标在看、「今天 第 3 集 / 已更新至第 3 集 / 3 天后开播」、落后 N 集。
   */
  import Cover from '$lib/Cover.svelte';
  import Chip from '$lib/ui/Chip.svelte';
  import CoverBackdrop from '$lib/ui/CoverBackdrop.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import { centerCurrent } from '$lib/centerCurrent.js';
  import { EXIT } from '$lib/ui/btn.js';
  import { dispTitle } from '$lib/format.js';
  import { SEASON_CN, WEEKDAY_OPTS, WATCH_STATUS, TYPE_CN, MY_STATUS_BADGE, showScore } from '$lib/constants.js';
  import { entry } from '$lib/api.js';
  import { toast } from '$lib/toast.svelte.js';
  import { makeHref } from '$lib/urlState.js';
  import { page as pg } from '$app/state';
  import { invalidateAll } from '$app/navigation';
  import Page from '$lib/ui/Page.svelte';
  import Confirm from '$lib/ui/Confirm.svelte';
  import { airText, airBadge } from './air.js';
  import BookmarkSimple from 'phosphor-svelte/lib/BookmarkSimple';
  import CalendarBlank from 'phosphor-svelte/lib/CalendarBlank';
  import X from 'phosphor-svelte/lib/X';
  import { nextEp as nextOf } from '$lib/nextEp.js';
  let { data } = $props();

  const COLD = 100;
  const to = $derived(makeHref('/schedule', pg.url.searchParams, { resetPage: false }));
  let saving = $state(null);
  /** 展开了冷门番的那几天 */
  let showCold = $state({});

  /** 选中某天就只看那天；wd=all 看全周 */
  const shown = $derived(
    data.wd
      ? [{ wd: data.wd, list: data.days[data.wd - 1] ?? [] }]
      : WEEKDAY_OPTS.map(([v]) => ({ wd: v, list: data.days[v - 1] ?? [] })).filter((d) => d.list.length)
  );
  const counts = $derived(Object.fromEntries(WEEKDAY_OPTS.map(([v]) => [v, (data.days[v - 1] ?? []).length])));
  const WD = $derived(Object.fromEntries(WEEKDAY_OPTS));
  const isCold = (a) => a.my_status !== 'watching' && (a.bgm_collection ?? 0) < COLD;
  /** 主卡：单日视图的那天、或全周视图里的今天 */
  const featured = (wd) => !!data.wd || wd === data.today;

  /** 空的那天：往前往后各找最近一个有番的日子 */
  function neighbours(wd) {
    const out = [];
    for (let v = wd - 1; v >= 1; v--) if (counts[v]) { out.push({ v, dir: -1 }); break; }
    for (let v = wd + 1; v <= 7; v++) if (counts[v]) { out.push({ v, dir: 1 }); break; }
    return out;
  }

  async function act(id, fn, ok) {
    saving = id;
    try { await fn(); await invalidateAll(); if (ok) toast.ok(ok); }
    catch (e) { toast.error(e); }
    finally { saving = null; }
  }
  const follow = (a) => act(a.id, () => entry.patch(a.id, { status: 'watching' }), `已加入在看：${dispTitle(a)}`);
  const bump = (a) => act(a.id, () => entry.bump(a.id, 1));
  /**
   * 取消追番 = 移出番单（原来只能进详情页取消，主人 2026-10-18 报的）。
   * 有进度 / 评分 / 短评时先确认 —— 和详情页「从番单移除」同一条规矩；只是刚点的追番就直接撤掉。
   */
  let asking = $state(null);
  const doUnfollow = (a) => act(a.id, () => entry.clear(a.id), `已取消追番：${dispTitle(a)}`);
  const unfollow = (a) => ((a.current_episode ?? 0) > 0 || a.my_score != null || a.my_note ? (asking = a) : doUnfollow(a));

  // 下一集和详情页 / 首页同一套（$lib/nextEp.js）：追平已播集数时不再写「第 N+1 集」（主人 2026-10-21 #7）
  const next = (a) => nextOf({ status: a.my_status, current: a.current_episode, total: a.episodes, aired: a.aired });
  /** 双层进度条的分母：总集数；没有就用已播 / 已看里大的那个 */
  const denom = (a) => (a.episodes > 0 ? a.episodes : Math.max(a.aired ?? 0, a.current_episode ?? 0, 1));
  const pct = (n, a) => `${Math.min(100, Math.round(((n ?? 0) / denom(a)) * 100))}%`;
</script>

{#snippet bookmark(a, watching, pos = 'right-0 top-0')}
  <!-- 44px 点击区（触屏规范），视觉上是 32px 的圆钮 -->
  {#if watching}
    <button onclick={() => unfollow(a)} disabled={saving === a.id} aria-pressed="true" aria-label="取消追番" title="取消追番"
            class="tap group/b absolute {pos} z-10 grid size-11 place-items-center disabled:opacity-50">
      <span class="grid size-8 place-items-center rounded-full max-sm:size-7 bg-accent text-on-accent shadow-md shadow-black/40 transition
                   group-hover/b:bg-black/75 group-hover/b:text-white">
        <BookmarkSimple size={16} weight="fill" class="group-hover/b:hidden" />
        <X size={15} weight="bold" class="hidden group-hover/b:block" />
      </span>
    </button>
  {:else}
    <button onclick={() => follow(a)} disabled={saving === a.id} aria-pressed="false" aria-label="追番" title="追番"
            class="tap group/b absolute {pos} z-10 grid size-11 place-items-center opacity-0 transition
                   group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 disabled:opacity-50">
      <span class="grid size-8 place-items-center rounded-full max-sm:size-7 bg-black/60 text-white shadow-md shadow-black/40 backdrop-blur-sm transition
                   group-hover/b:bg-accent group-hover/b:text-on-accent">
        <BookmarkSimple size={16} weight="bold" />
      </span>
    </button>
  {/if}
{/snippet}

{#snippet poster(a, today)}
  {@const watching = a.my_status === 'watching'}
  {@const badge = airBadge(a)}
  {@const live = today && a.airsToday}
  <div class="group relative min-w-0 transition-transform duration-200 ease-out hover:-translate-y-0.5">
    <a href="/anime/{a.id}" class="block">
      <div class="relative overflow-hidden rounded-xl bg-ink-800 shadow-md shadow-black/30 ring-1 transition-[box-shadow] duration-200
                  group-hover:shadow-lift {watching ? 'ring-accent/60' : 'ring-white/5 group-hover:ring-accent/40'}">
        <Cover {a} cls="aspect-2/3" />
        <div class="pointer-events-none absolute left-1.5 top-1.5 flex gap-1">
          {#if a.my_status && !watching}
            <span class="rounded-md px-1.5 py-0.5 text-[10.5px] font-medium backdrop-blur-sm {MY_STATUS_BADGE[a.my_status]}">{WATCH_STATUS[a.my_status]}</span>
          {:else if a.type !== 'TV'}
            <span class="rounded-md bg-black/70 px-1.5 py-0.5 text-[10.5px] text-white backdrop-blur-sm">{TYPE_CN[a.type] ?? a.type}</span>
          {/if}
          {#if a.is_short}<span class="rounded-md bg-short-badge/70 px-1.5 py-0.5 text-[10.5px] text-white">泡面</span>{/if}
        </div>
        {#if badge || showScore(a)}
          <div class="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-1 bg-gradient-to-t from-black/75 via-black/30 to-transparent px-1.5 pb-1.5 pt-7">
            {#if badge}
              <span class="rounded-md px-1.5 py-0.5 text-[11px] leading-tight
                           {live ? 'bg-accent font-semibold text-on-accent shadow-[0_0_12px_-2px_var(--c-accent)]' : 'bg-black/70 font-medium text-white'}">{badge}</span>
            {:else}<span></span>{/if}
            {#if showScore(a)}<span class="text-[12px] font-semibold text-white drop-shadow">★ {a.bgm_score.toFixed(1)}</span>{/if}
          </div>
        {/if}
      </div>
      <div class="mt-2 px-0.5">
        <div class="line-clamp-2 text-[13.5px] font-medium leading-snug transition-colors group-hover:text-accent">{dispTitle(a)}</div>
        <div class="mt-0.5 text-[11px] text-ink-400">
          {#if watching}看到 {a.current_episode ?? 0}{a.episodes ? ` / ${a.episodes}` : ''}{:else}{a.episodes ? `共 ${a.episodes} 集` : '集数未定'}{/if}
        </div>
      </div>
    </a>
    {@render bookmark(a, watching)}
  </div>
{/snippet}

{#snippet hero(a, wd)}
  {@const today = wd === data.today}
  {@const air = airText(a)}
  {@const nx = next(a)}
  <article class="relative isolate overflow-hidden rounded-2xl border border-accent/30 bg-ink-900 shadow-hero">
    <CoverBackdrop {a} blur={44} fade="none" intensity={1.25} position="50% 30%" />
    <div class="absolute inset-0 -z-10 bg-gradient-to-r from-ink-950/85 via-ink-950/65 to-ink-950/25 max-sm:bg-gradient-to-b max-sm:from-ink-950/40 max-sm:via-ink-950/75 max-sm:to-ink-950/85"></div>
    <!-- 大卡圆角 16px：钮贴死角落会压到圆角边，往里收一点 -->
    {@render bookmark(a, true, 'right-1 top-1 sm:right-2 sm:top-2')}
    <div class="flex flex-wrap items-center gap-x-5 gap-y-3.5 p-3.5 sm:flex-nowrap sm:p-5">
      <a href="/anime/{a.id}" class="group shrink-0">
        <Cover {a} eager cls="w-20 aspect-2/3 rounded-xl shadow-hero sm:w-[110px]" />
      </a>
      <div class="min-w-0 flex-1 max-sm:pr-8">
        {#if air}
          <span class="inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-1 text-[12px] font-semibold text-accent-ink">
            {#if today && a.airsToday}
              <span class="relative flex size-2" aria-hidden="true">
                <span class="absolute inset-0 animate-ping rounded-full bg-accent motion-reduce:hidden"></span>
                <span class="relative size-2 rounded-full bg-accent"></span>
              </span>
              今天更新 · 第 {a.aired} 集
            {:else}
              {today ? '' : `${WD[wd]} · `}{air}
            {/if}
          </span>
        {/if}
        <a href="/anime/{a.id}" class="mt-2 line-clamp-2 block text-[18px] font-bold leading-snug hover:text-accent sm:text-[22px]">{dispTitle(a)}</a>
        <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-200">
          <span>看到 <b class="tabular-nums text-ink-100">{a.current_episode ?? 0}</b>{#if a.episodes}<span class="text-ink-400">{` / ${a.episodes}`}</span>{/if}</span>
          {#if a.behind}<span class="rounded-md bg-warm/20 px-2 py-0.5 text-[12px] font-semibold text-warm">落后 {a.behind} 集</span>{/if}
          {#if showScore(a)}<span class="font-semibold text-warm">★ {a.bgm_score.toFixed(1)}</span>{/if}
        </div>
        <!-- 双层进度：浅的是已播，实的是我看到的 -->
        <div class="relative mt-3 h-1.5 max-w-sm overflow-hidden rounded-full bg-ink-700"
             role="img" aria-label="已播 {a.aired ?? 0} 集，看到第 {a.current_episode ?? 0} 集">
          <div class="absolute inset-y-0 left-0 rounded-full bg-accent/35" style:width={pct(a.aired, a)}></div>
          <div class="absolute inset-y-0 left-0 rounded-full bg-accent" style:width={pct(a.current_episode, a)}></div>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-2 max-sm:w-full">
        <button onclick={() => bump(a)} disabled={saving === a.id} aria-label="看完一集（+1）" title="看完一集"
                class="tap inline-flex h-11 items-center rounded-xl border border-ink-600 bg-ink-900/70 px-4 text-[14px] font-semibold text-ink-200 backdrop-blur transition hover:border-ink-400 disabled:opacity-50">+1</button>
        {#if nx.kind === 'resume' || nx.kind === 'start'}
          <a href="/anime/{a.id}/watch?ep={nx.ep}"
             class="tap inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-accent px-5 text-[14px] font-semibold text-on-accent shadow-[0_8px_24px_-8px_var(--c-accent)] transition hover:brightness-110 max-sm:flex-1">
            ▶ 第 {nx.ep} 集
          </a>
        {:else if nx.kind === 'caught'}
          <span class="inline-flex h-11 items-center px-1 text-[13px] text-ink-400 max-sm:flex-1">{nx.label}</span>
        {/if}
      </div>
    </div>
  </article>
{/snippet}

<Confirm open={!!asking} danger title="取消追番？" body="会移出番单，进度 / 评分 / 短评一起删除" confirmLabel="取消追番"
         onconfirm={() => { const a = asking; asking = null; doUnfollow(a); }} oncancel={() => (asking = null)} />

<Page>
  <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
    <h1 class="text-xl font-semibold sm:text-2xl">放送表</h1>
    <div class="text-[12px] text-ink-400">
      {data.season.year} 年{SEASON_CN[data.season.season]}季 · 共 {data.total} 部
      {#if data.lastSync}· 同步于 {data.lastSync.finished_at?.slice(5, 16)}{/if}
    </div>
  </div>

  <div class="mt-3 flex flex-wrap items-center gap-1.5">
    <Chip on={data.scope === 'all'} href={to({ scope: null })}>本季全部</Chip>
    <Chip on={data.scope === 'mine'} href={to({ scope: 'mine' })}>我在追的</Chip>
  </div>

  <!-- 日历条 -->
  <!-- 日历条（主人 2026-10-21 第 8 条：原来每格三行 11px 小字、格子 68px 高，像一排大按钮）。
       桌面一行 44px：「周三 10.21」+ 右侧部数；手机两行 52px：星期 / 部数，日期收进 aria-label。
       选中语言和季度浏览的季度条一致：选中 = accent 实色底 + on-accent 字；今天未选中 = accent 描边 -->
  <nav aria-label="星期" use:centerCurrent={data.wd}
       class="no-scrollbar mt-3 flex gap-1.5 overflow-x-auto max-sm:-mx-4 max-sm:px-4 max-sm:pb-3 sm:pb-2.5">
    {#each WEEKDAY_OPTS as [v, l]}
      {@const on = data.wd === v}
      {@const isToday = v === data.today}
      {@const past = v < data.today}
      {@const sub = on ? '' : isToday ? 'text-accent-ink' : 'text-ink-400'}
      <a href={to({ wd: v })} aria-current={on ? 'true' : undefined}
         aria-label="{isToday ? '今天 · ' : ''}{l} {data.dates[v - 1]} · {counts[v] ? `${counts[v]} 部` : '无'}"
         class="tap flex h-[52px] w-[56px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl border transition
                sm:h-11 sm:w-auto sm:min-w-0 sm:flex-1 sm:flex-row sm:justify-between sm:gap-2 sm:px-3.5
                {on ? 'border-accent bg-accent text-on-accent shadow-[0_4px_12px_-6px_var(--c-accent)]'
                    : isToday ? 'border-accent bg-transparent text-accent-ink hover:bg-accent/10'
                    : past ? 'border-ink-700 bg-transparent text-ink-400 hover:border-ink-600 hover:text-ink-200'
                    : 'border-ink-700 bg-ink-900 text-ink-100 hover:border-ink-400'}">
        <span class="flex items-baseline gap-2 leading-none">
          <span class="text-[15px] font-semibold sm:text-[14px]">{isToday ? '今天' : l}</span>
          <span class="text-[12px] tabular-nums max-sm:hidden {sub}">{data.dates[v - 1]}</span>
        </span>
        <span class="text-[12px] leading-none tabular-nums {on ? 'font-medium' : sub}">{counts[v] ? `${counts[v]} 部` : '—'}</span>
      </a>
    {/each}
    <span class="mx-0.5 w-px shrink-0 self-stretch bg-ink-700 my-2" aria-hidden="true"></span>
    <a href={to({ wd: 'all' })} aria-current={!data.wd ? 'true' : undefined}
       class="tap grid h-[52px] shrink-0 place-items-center rounded-xl border px-3.5 text-[14px] font-semibold transition sm:h-11 sm:px-4
              {!data.wd ? 'border-accent bg-accent text-on-accent shadow-[0_4px_12px_-6px_var(--c-accent)]'
                        : 'border-ink-700 bg-ink-900 text-ink-100 hover:border-ink-400'}">全周</a>
  </nav>

  {#if data.total === 0}
    <div class="mt-6">
      {#if data.scope === 'mine'}
        <EmptyState title="在看列表中没有本季在播的番" icon={CalendarBlank}>
          <a href={to({ scope: null })} class={EXIT}>浏览本季全部</a>
          <a href="/catalog?status=ONGOING" class={EXIT}>全部连载中作品</a>
        </EmptyState>
      {:else}
        <EmptyState title="暂无放送表数据" icon={CalendarBlank} />
      {/if}
    </div>
  {:else}
    <div class="mt-5">
      {#each shown as day (day.wd)}
        {@const isToday = day.wd === data.today}
        {@const past = day.wd < data.today}
        {@const feat = featured(day.wd)}
        {@const heroes = feat ? day.list.filter((a) => a.my_status === 'watching') : []}
        {@const rest = feat ? day.list.filter((a) => a.my_status !== 'watching') : day.list}
        {@const hot = rest.filter((a) => !isCold(a))}
        {@const cold = rest.filter(isCold)}
        <section class="{data.wd ? '' : 'mb-8'}">
          {#if !data.wd}
            <!-- 全周：每天一个吸顶小节头（顶栏 --hdr-h 下面） -->
            <h2 class="sticky top-[var(--hdr-h)] z-20 -mx-4 mb-3 flex items-baseline gap-2 px-4 py-2 text-[15px] font-semibold backdrop-blur
                       {isToday ? 'bg-[color-mix(in_srgb,var(--c-accent)_14%,var(--c-bg))] text-accent-ink shadow-[inset_3px_0_0_var(--c-accent)]'
                                : `bg-ink-950/90 ${past ? 'text-ink-400' : 'text-ink-100'}`}">
              {WD[day.wd]}
              <span class="text-[12px] font-normal {isToday ? '' : 'text-ink-400'}">{data.dates[day.wd - 1]}{isToday ? ' · 今天' : ''}</span>
              <span class="ml-auto text-[12px] font-normal {isToday ? '' : 'text-ink-400'}">{day.list.length} 部</span>
            </h2>
          {/if}

          {#if !day.list.length}
            {@const nb = neighbours(day.wd)}
            <EmptyState title="{isToday ? '今天' : WD[day.wd]}没有在播的番" icon={CalendarBlank}>
              {#each nb as n (n.v)}
                <a href={to({ wd: n.v })} class={EXIT}>
                  {n.dir < 0 ? '← ' : ''}{WD[n.v]} · {counts[n.v]} 部{n.dir > 0 ? ' →' : ''}
                </a>
              {/each}
              <!-- 七天都空、番全在「不在本季放送表」里（我在追的都是旧番 / 网络番）：原来是死胡同，只有全周视图才看得到它们 -->
              {#if !nb.length && data.noDay.length}
                <a href={to({ wd: 'all' })} class={EXIT}>
                  不在本季放送表 · {data.noDay.length} 部 →
                </a>
              {/if}
            </EmptyState>
          {/if}

          {#if heroes.length}
            <div class="grid gap-3">
              {#each heroes as a (a.id)}{@render hero(a, day.wd)}{/each}
            </div>
          {/if}

          {#if hot.length || cold.length}
            {#if heroes.length}
              <h3 class="mb-3 mt-7 flex items-baseline gap-2 text-[15px] font-semibold text-ink-100">
                {isToday ? '今天' : WD[day.wd]}还有<span class="text-[12px] font-normal text-ink-400">{rest.length} 部</span>
              </h3>
            {/if}
            <div class="grid grid-cols-3 gap-x-2.5 gap-y-4 sm:grid-cols-4 sm:gap-x-3.5 sm:gap-y-5 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7
                        {past && !data.wd ? '[&_img]:saturate-[.55]' : ''}">
              {#each hot as a (a.id)}{@render poster(a, isToday)}{/each}
              {#if showCold[day.wd]}
                {#each cold as a (a.id)}{@render poster(a, isToday)}{/each}
              {/if}
            </div>
            {#if cold.length}
              <!-- 箭头和详情页「其他标签」的展开箭头一致：没有它看不出这行字能点 -->
              <button onclick={() => (showCold[day.wd] = !showCold[day.wd])} aria-expanded={!!showCold[day.wd]}
                      class="tap mt-3 inline-flex items-center gap-1 text-[12px] text-ink-400 hover:text-accent">
                <span class="inline-block text-[10px] transition-transform {showCold[day.wd] ? 'rotate-90' : ''}">▶</span>
                {showCold[day.wd] ? '收起冷门番' : `其余 ${cold.length} 部冷门番`}
              </button>
            {/if}
          {/if}
        </section>
      {/each}

      {#if data.noDay.length && !data.wd}
        <section>
          <h2 class="sticky top-[var(--hdr-h)] z-20 -mx-4 mb-3 flex items-baseline gap-2 bg-ink-950/90 px-4 py-2 text-[15px] font-semibold text-ink-100 backdrop-blur">
            不在本季放送表<span class="ml-auto text-[12px] font-normal text-ink-400">{data.noDay.length} 部</span>
          </h2>
          <div class="grid grid-cols-3 gap-x-2.5 gap-y-4 sm:grid-cols-4 sm:gap-x-3.5 sm:gap-y-5 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
            {#each data.noDay as a (a.id)}{@render poster(a, false)}{/each}
          </div>
        </section>
      {/if}
    </div>
  {/if}
  <div class="h-6"></div>
</Page>
