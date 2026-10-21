<script>
  /**
   * 记录活动热力图（近 26 周，一列一周、周一在上）。
   *
   * 撑满面板宽度：列宽 1fr、格子 aspect-square，宽度变了格子跟着缩放、始终是方的
   * （原来固定 12px 格子，桌面上只占半块面板）。
   * 手机上只画最近 17 周：26 列挤进 360px 每格不到 10px，看不清也点不准；
   * 原来更糟 —— 固定宽度 + 横向滚动，最右边本月那列被裁掉。
   * 周数用 CSS 切（max-sm:hidden + --n），不靠 JS 判断视口：SSR 出来就是对的，水合不跳。
   */
  import Panel from './Panel.svelte';
  import { heatWeeks, heatCuts, heatLevel, localKey } from '$lib/heatmap.js';
  let { activity, longestStreak } = $props();

  const MOBILE_WEEKS = 17;
  const actMap = $derived(new Map(activity.map((r) => [r.d, r.c])));
  const weeks = $derived(heatWeeks(new Date(), actMap));
  const today = localKey(new Date());
  /** 深浅按有记录那些天的分位数分四档（#105：按最大值线性分时，快速标记一天 363 条，平时全挤在最淡一档） */
  const cuts = $derived(heatCuts(activity.map((r) => r.c)));
  // 空格子用 ink-700 半透明：ink-800 在亮色白卡片上几乎看不出格子
  const LV = ['bg-ink-700/50', 'bg-accent/25', 'bg-accent/50', 'bg-accent/75', 'bg-accent'];
  const thisWeek = $derived(weeks.at(-1).reduce((n, d) => n + d.c, 0));
  const active = (ws) => ws.flat().filter((d) => d.c > 0).length;
  const activeDays = $derived(active(weeks));
  const activeDaysM = $derived(active(weeks.slice(-MOBILE_WEEKS)));
  /** 这一周里出现了 1 号就在列头标那个月 */
  const monthOf = (col) => { const d = col.find((x) => x.key.endsWith('-01')); return d ? `${+d.key.slice(5, 7)}月` : ''; };
</script>

<Panel title="记录活动">
  {#snippet side()}
    最长连续 <b class="font-semibold text-ink-100" data-stat="streak">{longestStreak}</b> 天
    · 本周 <b class="font-semibold text-ink-100">{thisWeek}</b> 次
  {/snippet}
  <div class="heat mt-3" style="--n:{weeks.length}; --m:{MOBILE_WEEKS}">
    {#each weeks as col, w (col[0].key)}
      <div class="flex min-w-0 flex-col gap-[3px] sm:gap-1 {w < weeks.length - MOBILE_WEEKS ? 'max-sm:hidden' : ''}">
        <div class="h-3.5 overflow-visible whitespace-nowrap text-[10px] leading-none text-ink-400">{monthOf(col)}</div>
        {#each col as d (d.key)}
          {#if d.future}<div class="aspect-square"></div>
          {:else}
            <div class="aspect-square rounded-[3px] {LV[heatLevel(d.c, cuts)]}
                        {d.key === today ? 'outline outline-1 outline-offset-1 outline-accent' : ''}"
                 title="{d.key}：{d.c} 次记录"></div>
          {/if}
        {/each}
      </div>
    {/each}
  </div>
  <div class="mt-3 flex items-center justify-between gap-3 text-[11px] text-ink-400">
    <span><span class="max-sm:hidden">近 26 周 · 活跃 {activeDays} 天</span><span class="sm:hidden">近 {MOBILE_WEEKS} 周 · 活跃 {activeDaysM} 天</span></span>
    <span class="flex items-center gap-[3px]" aria-hidden="true">
      <span class="mr-0.5">少</span>{#each LV as c (c)}<i class="size-2.5 rounded-[2px] {c}"></i>{/each}<span class="ml-0.5">多</span>
    </span>
  </div>
</Panel>

<style>
  .heat { display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 4px; }
  @media (max-width: 639px) {
    .heat { grid-template-columns: repeat(var(--m), minmax(0, 1fr)); gap: 3px; }
  }
</style>
