<script>
  import CardGrid from '$lib/ui/CardGrid.svelte';
  import Section from '$lib/ui/Section.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import Page from '$lib/ui/Page.svelte';
  import LoginGate from '$lib/ui/LoginGate.svelte';
  import Television from 'phosphor-svelte/lib/Television';
  import { TYPE_CN } from '$lib/constants.js';
  import { page as pg } from '$app/state';
  import { makeHref } from '$lib/urlState.js';
  import Hero from './Hero.svelte';
  import Heatmap from './Heatmap.svelte';
  import YearBars from './YearBars.svelte';
  import Panel from './Panel.svelte';
  import Timeline from './Timeline.svelte';
  let { data } = $props();

  // 时间线分页要改 URL 上的 tl 参数。resetPage:false —— 这页没有别的分页要重置
  const to = $derived(makeHref('/stats', pg.url.searchParams, { resetPage: false }));

  const maxScore = $derived(Math.max(1, ...data.scoreDist.map((r) => r.c)));
  const maxGenre = $derived(Math.max(1, ...data.genres.map(([, n]) => n)));
  const scored = $derived(data.scoreDist.reduce((n, r) => n + r.c, 0));
  // 分布类图表的统一口径，标在面板标题上，免得又被当成「番单全部」
  const COHORT = $derived(`看过的 ${data.watchedCount} 部`);

  /** 类型构成：一根堆叠条 + 图例。颜色只用 token —— 四季色在这里只当一组好分辨的分类色 */
  const TYPE_FILL = { TV: 'bg-accent', MOVIE: 'bg-warm-fill', OVA: 'bg-season-spring', ONA: 'bg-season-summer',
                      SPECIAL: 'bg-season-fall' };
  const typeTotal = $derived(data.byType.reduce((n, t) => n + t.c, 0) || 1);
  /** 制作公司前 3 名的名次色 */
  const RANK = ['text-gold', 'text-silver', 'text-bronze'];
</script>

<Page>
{#if !data.user}
  <LoginGate title="我的统计" line="登录后查看你的观看统计" />
{:else}
  <h1 class="sr-only">我的统计</h1>

  {#if data.total === 0}
    <EmptyState title="暂无观看记录" icon={Television}>
      <a href="/triage" class="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent">去快速标记 →</a>
    </EmptyState>
  {:else}
    <Hero {data} />

    <!-- 网格单元都带 min-w-0（Panel 自带）：原来热力图的固定宽度把单列网格撑宽，手机上年份柱右侧被裁掉 -->
    <div class="mt-4 grid gap-4 lg:grid-cols-2">
      <Heatmap activity={data.activity} longestStreak={data.longestStreak} />
      {#if data.byYear.length}
        <YearBars byYear={data.byYear} peakYear={data.peakYear} hint={COHORT} />
      {/if}

      {#if data.genres.length}
        <Panel title="题材分布" hint={COHORT}>
          <div class="mt-3 space-y-[7px]">
            {#each data.genres as [g, n], i (g)}
              <a href="/mine?status=completed&g={encodeURIComponent(g)}" class="group flex items-center gap-2.5 text-[13px]">
                <span class="w-[4.5em] shrink-0 truncate {i < 3 ? 'font-semibold text-ink-100' : 'text-ink-200'} group-hover:text-accent">{g}</span>
                <span class="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-ink-700/40">
                  <span class="block h-full rounded-full {i < 3 ? 'bg-linear-to-r from-accent/70 to-accent' : 'bg-ink-600'}"
                        style="width:{(n / maxGenre) * 100}%; min-width:6px"></span>
                </span>
                <span class="w-8 shrink-0 text-right text-[12px] tabular-nums {i < 3 ? 'font-semibold text-ink-100' : 'text-ink-400'}">{n}</span>
              </a>
            {/each}
          </div>
        </Panel>
      {/if}

      <!-- 右列：评分分布把左边题材分布多出来的高度吃掉（原来 17 行题材把左列撑高，右列底下空一大块） -->
      <div class="grid min-w-0 gap-4 lg:grid-rows-[1fr_auto]">
        <Panel title="评分分布" hint={scored ? `打过分的 ${scored} 部` : null} cls="flex flex-col">
          {#if !scored}
            <div class="py-6 text-center text-[13px] text-ink-400">还没有打分</div>
          {:else}
            <!-- 评分有一位小数（2026-10-21 起），按整数向下归档：「7」这根是 7.0–7.9，「10」只有满分。
                 部数直接写在柱顶：原来只在 title 里，手机上没有悬停就看不到 -->
            <div class="mt-4 flex h-[120px] items-end gap-1.5 lg:h-auto lg:min-h-[120px] lg:flex-1">
              {#each Array.from({ length: 10 }, (_, i) => i + 1) as n (n)}
                {@const c = data.scoreDist.find((r) => r.s === n)?.c ?? 0}
                <div class="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
                     title="{n === 10 ? '10.0' : `${n}.0–${n}.9`} 分：{c} 部">
                  {#if c}<div class="text-[10.5px] tabular-nums text-ink-200">{c}</div>{/if}
                  <div class="w-full rounded-t-[4px] rounded-b-[1px] {c ? 'bg-linear-to-b from-warm-fill to-warm-fill/35' : 'bg-ink-700/60'}"
                       style="height:{(c / maxScore) * 78}%; min-height:2px"></div>
                </div>
              {/each}
            </div>
            <div class="mt-1.5 flex gap-1.5 text-[10.5px] leading-none text-ink-400">
              {#each Array.from({ length: 10 }, (_, i) => i + 1) as n (n)}<span class="flex-1 text-center">{n}</span>{/each}
            </div>
          {/if}
        </Panel>

        {#if data.byType.length}
          <Panel title="类型构成">
            <div class="mt-3 flex h-3 gap-[2px] overflow-hidden rounded-full">
              {#each data.byType as t (t.type)}
                <span class="h-full {TYPE_FILL[t.type] ?? 'bg-ink-600'}" style="width:{(t.c / typeTotal) * 100}%"
                      title="{TYPE_CN[t.type] ?? t.type}：{t.c} 部"></span>
              {/each}
            </div>
            <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px]">
              {#each data.byType as t (t.type)}
                <span class="flex items-center gap-1.5 text-ink-200">
                  <i class="size-2 rounded-full {TYPE_FILL[t.type] ?? 'bg-ink-600'}"></i>
                  {TYPE_CN[t.type] ?? t.type}<b class="font-semibold tabular-nums text-ink-100">{t.c}</b>
                </span>
              {/each}
            </div>
          </Panel>
        {/if}
      </div>

      {#if data.studios.length}
        <Panel title="制作公司" hint={COHORT} cls="lg:col-span-2">
          <ol class="mt-3 grid gap-x-6 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-3">
            {#each data.studios as s, i (s.studio)}
              <li>
                <a href="/catalog?studio={encodeURIComponent(s.studio)}"
                   class="group -mx-2 flex items-center gap-3 rounded-lg px-2 py-1.5 text-[13.5px] transition-colors hover:bg-ink-800">
                  <span class="w-5 shrink-0 text-center text-[13px] font-bold tabular-nums {RANK[i] ?? 'text-ink-400'}">{i + 1}</span>
                  <span class="min-w-0 flex-1 truncate text-ink-100 group-hover:text-accent">{s.label}</span>
                  <span class="shrink-0 text-[12px] tabular-nums text-ink-400">{s.c} 部</span>
                </a>
              </li>
            {/each}
          </ol>
        </Panel>
      {/if}
    </div>

    {#if data.top.length}
      <Section title="评分最高" action="全部" actionHref="/mine?status=completed&sort=mine">
        <CardGrid items={data.top} variant="row" score="mine" hideStatus />
      </Section>
    {/if}

    <div class="mt-8 sm:mt-9">
      <Timeline days={data.days} page={data.tl} pages={data.tlPages} total={data.tlTotal}
                per={data.tlPer} perIsDefault={data.tlPerIsDefault} {to} />
    </div>
  {/if}
  <div class="h-6"></div>
{/if}
</Page>
