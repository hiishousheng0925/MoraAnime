<script>
  /**
   * 年份 / 季度筛选胶囊 —— 目录、季度浏览、排行榜、番单共用。
   *
   * ⚠️ 为什么不在里面嵌 Select：Select 自己是个绝对定位弹层，
   * 嵌在 FilterPill 面板里会被裁剪（表现为下拉只露出两三行）。
   * 之前目录页改成内联 chip 修好了，季度浏览却漏改 —— 所以统一抽到这里，
   * 四个页面用同一份实现，不会再各自跑偏。
   */
  import FilterPill from './FilterPill.svelte';
  import Chip from './Chip.svelte';
  import { SEASON_OPTS_M, DECADE_OPTS } from '$lib/constants.js';
  import { yearSummary } from '$lib/yearSummary.js';

  let {
    years = [],            // [{ year, c }]
    year = null,           // 选中的具体年份
    yearMax = null,        // 区间上限（目录页用）
    season = null,
    decade = null,         // 年代（排行榜用）
    to,                    // (patch) => href
    showDecade = true,
    /** 是否显示季度那一段。快速标记只按年份出题，没有季度概念 */
    showSeason = true,
    showRange = false,     // 是否显示年代区间（目录页）
    label = '年份',
    yearFloor = null,
    /** 当前值就是默认值时传 true —— 胶囊显示为未激活，
     *  否则重置后仍会显示「2026」，让人以为没重置成功。
     *  注意 year 仍要传，面板里的高亮要用它。 */
    isDefault = false,
    /** 「全部季度」这一项要写进 URL 的值。
     *  目录页缺省就是「不限季度」，传 null 即可；
     *  季度浏览的缺省是「当前季」，必须显式传 'all' 才能表达「四季都看」。 */
    seasonAllValue = null,
    /** 「全部季度」是否选中。不传就按「没有 season」判断。 */
    seasonAllOn = null,
    /** 是否显示年份的「全部」。
     *  季度浏览必须传 false —— 那页缺省是「当前年」，点「全部」只会跳回当前年，
     *  胶囊也永远亮不起来（year 一直有值），等于一个骗人的按钮。 */
    showYearAll = true,
    /** 置灰并禁用，透传给内部的 FilterPill */
    muted = false,
    /** 当前值就是页面默认（但仍要写出来）→ 弱色摘要 + 小点，透传给 FilterPill */
    dflt = false
  } = $props();

  // 判断顺序见 yearSummary.js（区间分支曾被单年分支截胡）
  const summary = $derived(yearSummary({ year, yearMax, season, decade, yearFloor, isDefault }));
  const count = $derived(isDefault ? 0 : [year, season, decade].filter(Boolean).length);

  /** 2000 年前的年份默认收起 —— 一次铺 78 个太长。选中的年份始终可见。 */
  const RECENT_FROM = 2000;
  let allYears = $state(false);
  const recent = $derived(years.filter((y) => y.year >= RECENT_FROM));
  const older = $derived(years.filter((y) => y.year < RECENT_FROM));
  const shownYears = $derived(
    allYears ? years
      : [...recent, ...older.filter((y) => y.year === year || y.year === yearMax)]
  );
</script>

<FilterPill {label} {summary} {count} w="28rem" scroll {muted} {dflt}>
  {#if showSeason}
    <!-- 季度口径（冬 1-3 月…）直接写在 chip 上，不再另挂说明气泡 -->
    <div class="mb-1.5 text-[12px] text-ink-400">季度</div>
    <div class="flex flex-wrap gap-1.5">
      <Chip on={seasonAllOn ?? !season} href={to({ season: seasonAllValue })}>全部</Chip>
      {#each SEASON_OPTS_M as [v, l]}
        <Chip on={season === v} href={to({ season: season === v ? seasonAllValue : v })}>{l}</Chip>
      {/each}
    </div>
  {/if}

  {#if showDecade}
    <div class="mt-3 mb-1.5 text-[12px] text-ink-400">年代</div>
    <div class="flex flex-wrap gap-1.5">
      <Chip on={!decade && !year && !yearMax} href={to({ decade: null, year: null, from: null, to: null })}>全部</Chip>
      {#each DECADE_OPTS as [a, b, l]}
        <Chip on={showRange ? (year === a && yearMax === b) : decade === a}
              href={to(showRange ? { from: a, to: b, season: null, year: null }
                                  : { decade: a, year: null })}>{l}</Chip>
      {/each}
    </div>
  {/if}

  <div class="{showSeason || showDecade ? 'mt-3' : ''} mb-1.5 flex items-baseline justify-between gap-3 text-[12px]">
    <span class="text-ink-400">
      <!-- 「·」前的空格写在 span 开头会被 Svelte 吃掉（渲染成「具体年份· 1995 年起」），用 ml-1 -->
      具体年份{#if yearFloor}<span class="ml-1">· {yearFloor} 年起</span>{/if}
    </span>
    {#if older.length}
      <button onclick={() => (allYears = !allYears)} class="shrink-0 text-accent">
        {allYears ? '收起' : `展开全部 ${years.length}`}
      </button>
    {/if}
  </div>
  <div class="flex flex-wrap gap-1.5">
    {#if !showRange && showYearAll}
      <Chip on={!year} href={to({ year: null })}>全部</Chip>
    {/if}
    {#each shownYears as y (y.year)}
      <Chip on={showRange ? (year === y.year && yearMax === y.year) : year === y.year}
            href={to(showRange ? { from: y.year, to: y.year, decade: null }
                                : { year: y.year, decade: null })}>
        {y.year}{#if y.c}<span class="ml-1 text-[11px] text-ink-400">{y.c}</span>{/if}
      </Chip>
    {/each}
  </div>
</FilterPill>
