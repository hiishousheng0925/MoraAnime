<script>
  /**
   * 排序胶囊 —— 目录、季度浏览、番单共用。
   *
   * 抽出来的理由：三页原本各写一份，选项表还不是同一份
   * （目录用 SORT_OPTS 叫「最新/最早」，番单用 MINE_SORT_OPTS 叫「年份新/年份旧」，
   * 季度浏览干脆没有排序，写死在 SQL 里按人气）——
   * 同一个功能三种叫法，改一处要找三个文件。
   */
  import FilterPill from './FilterPill.svelte';
  import Chip from './Chip.svelte';
  import { TIME_SORTS, SORT2_OPTS, DEFAULT_SORT2 } from '$lib/constants.js';

  /**
   * sort2：按时间排时的第二排序（同一季里怎么排）。不传就不显示第二行（季度浏览：一块本来就是同一季）。
   * 摘要在缺省状态也写全「最新·人气」—— 规则要从控件上看得出来，但不高亮，改过才亮。
   */
  let { opts, sort, to, defaultSort = null, sort2 = null, label = '排序', w = '19rem', align = 'right' } = $props();

  const isTime = $derived(sort2 != null && TIME_SORTS.includes(sort));
  const isDefault = $derived(defaultSort != null && sort === defaultSort && (!isTime || sort2 === DEFAULT_SORT2));
  const cur = $derived(opts.find(([v]) => v === sort));
  const cur2 = $derived(SORT2_OPTS.find(([v]) => v === sort2));
  const summary = $derived(isTime ? `${cur?.[1]}·${cur2?.[1]}` : isDefault ? null : cur?.[1]);
</script>

<FilterPill {label} {summary} hot={!isDefault} count={isDefault ? 0 : (cur ? 1 : 0)} {w} {align}>
  <div class="flex flex-wrap gap-1.5">
    {#each opts as [v, l]}
      <!-- 换成不按时间的排序时去掉 s2：它只对最新 / 最早有意义 -->
      <Chip on={v === sort} href={to({ sort: v, s2: TIME_SORTS.includes(v) ? sort2 === DEFAULT_SORT2 ? null : sort2 : null })}>{l}</Chip>
    {/each}
  </div>
  {#if isTime}
    <div class="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-ink-700 pt-2.5">
      <span class="mr-1 text-[12px] text-ink-400">同季内</span>
      {#each SORT2_OPTS as [v, l]}
        <Chip on={v === sort2} href={to({ s2: v === DEFAULT_SORT2 ? null : v })}>{l}</Chip>
      {/each}
    </div>
  {/if}
</FilterPill>
