<script>
  /**
   * 观看时间线：左侧一根竖线 + 每行一个圆点；日期是吸顶的小标题（顶栏 53px 下面）。
   * 同一天同一部番合并成一行（timeline.js 的 mergeDay），原来逐条一张带边框的卡片。
   * 分页沿用原逻辑（按日志条数分页，?tl=）。
   */
  import Cover from '$lib/Cover.svelte';
  import Pager from '$lib/ui/Pager.svelte';
  import Panel from './Panel.svelte';
  import { dispTitle } from '$lib/format.js';
  import { localKey } from '$lib/heatmap.js';
  import { mergeDay, dayLabel } from './timeline.js';
  import { fmtNum } from './fmt.js';
  let { days, page, pages, total, per, perIsDefault, to } = $props();

  const today = localKey(new Date());
  const rows = $derived(days.map((d) => ({ date: d.date, label: dayLabel(d.date, today), rows: mergeDay(d.items) })));
</script>

<Panel title="时间线" hint={total ? `共 ${fmtNum(total)} 条` : null}>
  {#if !total}
    <div class="py-8 text-center text-[13px] text-ink-400">暂无记录</div>
  {:else}
    <div class="mt-2">
      {#each rows as d (d.date)}
        <div class="relative">
          <div class="sticky top-[53px] z-[1] -mx-1 flex items-baseline gap-2 bg-ink-900 px-1 pb-1.5 pt-3">
            <span class="text-[13px] font-semibold text-ink-100">{d.label.head}</span>
            <span class="text-[12px] text-ink-400">{d.label.rel}</span>
          </div>
          <ol class="tl relative ml-[5px] border-l border-ink-700 pl-4 sm:pl-5">
            {#each d.rows as r (r.key)}
              <li class="relative">
                <span class="dot absolute top-1/2 size-[9px] -translate-y-1/2 rounded-full border-2 border-ink-900 bg-accent"></span>
                <a href="/anime/{r.anime.id}"
                   class="group -mx-2 flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-ink-800">
                  <Cover a={r.anime} cls="h-12 w-8 shrink-0 rounded-md" />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-[13.5px] font-medium text-ink-100 group-hover:text-accent">{dispTitle(r.anime)}</div>
                    <div class="mt-0.5 truncate text-[12px] text-ink-400">{r.text}</div>
                  </div>
                  <span class="shrink-0 text-[11.5px] tabular-nums text-ink-400">{r.time}</span>
                </a>
              </li>
            {/each}
          </ol>
        </div>
      {/each}
    </div>
    <Pager {page} {pages} {to} param="tl" noScroll {per} {perIsDefault} />
  {/if}
</Panel>

<style>
  /* 圆点压在竖线上：竖线在 ol 的左边框，圆点往左挪出 ol 的内边距 + 半个点宽 */
  .dot { left: calc(-1rem - 5px); }
  @media (min-width: 640px) { .dot { left: calc(-1.25rem - 5px); } }
</style>
