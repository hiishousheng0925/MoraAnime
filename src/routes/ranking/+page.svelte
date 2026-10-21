<script>
  /**
   * 排行榜（2026-10 UI 大改第 2 段）：
   *   · 第 1 页前 3 名是领奖台：各自封面做模糊氛围背景 + 主题底色渐变，2:3 大封面带深投影，
   *     描边大名次（金 / 银 / 铜 token，亮色主题自动用压暗版），大号分数 +「N 人评分」。手机一列横卡
   *   · 其余名次是细分隔线列表行（不再一行一张卡）：悬停整行淡底 + 封面微放大；名次大号粗体、低调色
   *   · 手机：封面 44×62、名次贴着封面、行高约 78px，一屏约 11 名
   *   · 我的状态（在看 / 看过 …）在年份那行前面一个小标签。原来行尾 1.5px 小圆点基本看不见
   */
  import Cover from '$lib/Cover.svelte';
  import Chip from '$lib/ui/Chip.svelte';
  import FilterPill from '$lib/ui/FilterPill.svelte';
  import YearPill from '$lib/ui/YearPill.svelte';
  import CoverBackdrop from '$lib/ui/CoverBackdrop.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import { dispTitle, yearText } from '$lib/format.js';
  import { TYPE_CN, TYPE_OPTS, WATCH_STATUS, showScore } from '$lib/constants.js';
  import { makeHref } from '$lib/urlState.js';
  import { page as pg } from '$app/state';
  import Page from '$lib/ui/Page.svelte';
  import ResetButton from '$lib/ui/ResetButton.svelte';
  import Pager from '$lib/ui/Pager.svelte';
  import Trophy from 'phosphor-svelte/lib/Trophy';
  let { data } = $props();

  const to = $derived(makeHref('/ranking', pg.url.searchParams));
  /** 换筛选时回到第 1 页 */
  const nav = (patch) => to({ p: null, ...patch });

  const timeCount = $derived([data.year, data.decade, data.season].filter(Boolean).length);

  /** 领奖台：只在第 1 页、且至少 3 条时 */
  const podium = $derived(data.page === 1 && data.rows.length >= 3 ? data.rows.slice(0, 3) : []);
  const rest = $derived(data.rows.slice(podium.length));
  const restStart = $derived(data.startRank + podium.length);
  // 三列均分（按实际条数算 —— 每页 50 / 100 时不能写死每列 10）；列内从上往下数名次
  const perCol = $derived(Math.ceil(rest.length / 3));
  const cols = $derived([0, 1, 2].map((i) => rest.slice(i * perCol, (i + 1) * perCol)));

  const MEDAL = [
    { ink: 'text-gold', stroke: 'var(--c-gold)', ring: 'border-gold/40' },
    { ink: 'text-silver', stroke: 'var(--c-silver)', ring: 'border-silver/35' },
    { ink: 'text-bronze', stroke: 'var(--c-bronze)', ring: 'border-bronze/35' }
  ];
  /** 我的状态小标签（页面底色 / 卡片上用，不是压在封面上的那套） */
  const MARK = {
    watching: 'bg-accent/15 text-accent-ink',
    completed: 'bg-live/15 text-live-ink',
    plan: 'bg-ink-700 text-ink-200',
    on_hold: 'bg-ink-700 text-ink-200',
    dropped: 'bg-ink-700 text-ink-200'
  };
  // 分隔符显式拼：模板里 `{year}{#if} · …` 的前导空格会被 Svelte 吃掉（「2008· 24集」）
  const meta = (a) => [yearText(a), a.episodes ? `${a.episodes} 集` : null].filter(Boolean).join(' · ');
  const score = (a) => (showScore(a) ? a.bgm_score.toFixed(1) : '—');
</script>

{#snippet mark(a)}
  {#if a.my_status}
    <span class="shrink-0 rounded px-1.5 py-px text-[11px] font-medium {MARK[a.my_status]}">{WATCH_STATUS[a.my_status]}</span>
  {/if}
{/snippet}

<Page fill>
  <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
    <div class="flex items-baseline gap-3">
      <h1 class="text-xl font-semibold sm:text-2xl">排行榜</h1>
      <span class="text-[12px] text-ink-400">Bangumi 全站排名</span>
    </div>
    <div class="text-[12px] text-ink-400">
      {#if data.total}前 {data.total} 名 · 第 {data.page}/{data.pages} 页{/if}
    </div>
  </div>

  <div class="mt-3 flex flex-wrap items-center gap-1.5">
    <FilterPill label="类型" summary={data.type ? TYPE_CN[data.type] : null}
                count={data.type ? 1 : 0} w="21rem">
      <div class="flex flex-wrap gap-1.5">
        <Chip on={!data.type} href={nav({ type: null })}>全部</Chip>
        {#each TYPE_OPTS as [v, l]}
          <Chip on={data.type === v} href={nav({ type: v })}>{l}</Chip>
        {/each}
      </div>
    </FilterPill>

    <YearPill years={data.years} year={data.year} season={data.season} decade={data.decade}
              to={nav} label="时间" />

    {#if data.type || timeCount}
      <ResetButton href="/ranking" />
    {/if}
  </div>

  {#if !data.rows.length}
    <div class="mt-6">
      <EmptyState title="此范围暂无 Bangumi 评分数据" icon={Trophy}>
        {#if data.type || timeCount}
          <a href="/ranking" class="tap inline-flex items-center rounded-lg border border-ink-600 bg-ink-900 px-3 py-1.5 text-[13px] text-ink-200 hover:border-ink-400">看全部排名</a>
        {/if}
      </EmptyState>
    </div>
  {:else}
    {#if podium.length}
      <ol class="mt-5 grid gap-3 sm:gap-4 lg:grid-cols-[1.15fr_1fr_1fr]">
        {#each podium as a, i (a.id)}
          {@const m = MEDAL[i]}
          <li class="min-w-0">
            <a href="/anime/{a.id}"
               class="group relative isolate flex h-full overflow-hidden rounded-2xl border bg-ink-900 shadow-hero transition duration-200
                      hover:-translate-y-0.5 {m.ring}
                      items-center gap-4 p-3.5 pl-4 sm:gap-5 sm:p-5
                      lg:min-h-[300px] lg:items-end lg:pt-10">
              <CoverBackdrop {a} blur={36} fade="none" intensity={1.3} position="50% 30%" />
              <div class="absolute inset-0 -z-10 bg-gradient-to-r from-ink-950/80 via-ink-950/65 to-ink-950/40
                          lg:bg-gradient-to-b lg:from-ink-950/25 lg:via-ink-950/60 lg:to-ink-950/92"></div>
              <!-- 描边大名次：装饰，读屏读下面的 sr-only -->
              <span aria-hidden="true"
                    class="pointer-events-none absolute select-none font-black leading-none tracking-[-0.06em] text-transparent
                           bottom-1 left-1.5 text-[64px] lg:bottom-auto lg:left-3 lg:top-1 {i === 0 ? 'lg:text-[120px]' : 'lg:text-[96px]'}"
                    style:-webkit-text-stroke="2px {m.stroke}">{i + 1}</span>
              <span class="sr-only">第 {i + 1} 名</span>
              <div class="relative ml-7 shrink-0 lg:ml-12">
                <Cover {a} eager cls="aspect-2/3 rounded-xl shadow-hero w-[76px] sm:w-[84px] lg:w-[132px] {i === 0 ? 'xl:w-[156px]' : ''}" />
              </div>
              <div class="relative min-w-0 flex-1 lg:pb-1">
                <div class="line-clamp-3 font-semibold leading-snug transition-colors group-hover:text-accent
                            text-[16px] {i === 0 ? 'lg:text-[20px]' : 'lg:text-[17px]'}">{dispTitle(a)}</div>
                <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-400">
                  {@render mark(a)}<span>{meta(a)}</span>
                </div>
                <div class="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <b class="font-bold leading-none tabular-nums {m.ink} text-[28px] {i === 0 ? 'lg:text-[36px]' : 'lg:text-[30px]'}">{score(a)}</b>
                  <span class="whitespace-nowrap text-[12px] tabular-nums text-ink-400">{(a.bgm_votes ?? 0).toLocaleString()} 人评分</span>
                </div>
              </div>
            </a>
          </li>
        {/each}
      </ol>
    {/if}

    <div class="mt-5 grid gap-x-6 lg:grid-cols-3 {podium.length ? 'sm:mt-6' : ''}">
      {#each cols as col, ci}
        <ol>
          {#each col as a, ri (a.id)}
            {@const rank = restStart + ci * perCol + ri}
            <li>
              <a href="/anime/{a.id}"
                 class="group flex items-center gap-2.5 border-b border-ink-700/60 px-1 py-2 transition-colors
                        hover:bg-ink-900 sm:gap-3 sm:rounded-lg sm:px-2">
                <span class="w-8 shrink-0 text-right text-[19px] font-bold leading-none tracking-tight tabular-nums text-ink-400
                             sm:w-9 sm:text-center sm:text-[24px]">{rank}</span>
                <div class="shrink-0 overflow-hidden rounded-md">
                  <Cover {a} cls="h-[62px] w-[44px] sm:h-[68px] sm:w-12" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="line-clamp-2 text-[14px] leading-snug transition-colors group-hover:text-accent">{dispTitle(a)}</div>
                  <div class="mt-1 flex items-center gap-1.5 text-[12px] text-ink-400">
                    {@render mark(a)}<span class="truncate">{meta(a)}</span>
                  </div>
                </div>
                <div class="shrink-0 pl-1 text-right">
                  <div class="text-[16px] font-semibold tabular-nums text-warm">{score(a)}</div>
                  <div class="text-[11px] tabular-nums text-ink-400">{(a.bgm_votes ?? 0).toLocaleString()}</div>
                </div>
              </a>
            </li>
          {/each}
        </ol>
      {/each}
    </div>

    <Pager page={data.page} pages={data.pages} {to} sticky
           per={data.per} perIsDefault={data.perIsDefault} />
  {/if}
</Page>
