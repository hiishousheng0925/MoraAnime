<script>
  /**
   * 封面网格（海报墙）。列数在 ui/grid.js 里定义一次，桌面一排 8 个。
   *
   * props
   *   items        番剧行数组                                              必填
   *   variant      'grid'（默认，各宽度都是网格）
   *                | 'row'（手机 <640px 改成一行横向滑动：卡宽 118px、左右 16px 内边距贴屏幕边、
   *                  吸附滚动、隐藏滚动条、最后一张露出一部分暗示能滑；≥640px 仍是网格）
   *                  ⚠️ row 用负外边距 -mx-4 撑到屏幕边，父容器左右内边距须是 16px（Page 默认就是 px-4）
   *   empty        items 为空时显示的 EmptyState 标题（如「没有找到「xxx」」）；不传则空数组什么都不渲染
   *   emptyIcon    EmptyState 的图标组件（phosphor-svelte）；不传用默认
   *   showProgress / score / hideStatus / eager —— 原样透传给每张 PosterCard（eager 只给前 8 张）
   * 例：<CardGrid items={data.recommend} variant="row" />
   *     <CardGrid items={rows} score="mine" hideStatus empty="还没有看完的番" />
   */
  import PosterCard from '$lib/PosterCard.svelte';
  import EmptyState from './EmptyState.svelte';
  import { CARD_GRID } from './grid.js';
  let { items = [], variant = 'grid', showProgress = false, score = 'bangumi', hideStatus = false,
        eager = false, empty = null, emptyIcon = undefined } = $props();
</script>

{#if items.length}
  <div class="grid gap-x-3.5 gap-y-5 {CARD_GRID}
              {variant === 'row' ? 'max-sm:-mx-4 max-sm:flex max-sm:snap-x max-sm:snap-mandatory max-sm:gap-3 max-sm:overflow-x-auto max-sm:scroll-px-4 max-sm:px-4 max-sm:pb-1 no-scrollbar' : ''}">
    {#each items as a, i (a.id)}
      {#if variant === 'row'}
        <div class="min-w-0 max-sm:w-[118px] max-sm:shrink-0 max-sm:snap-start">
          <PosterCard {a} {showProgress} {score} {hideStatus} eager={eager && i < 8} />
        </div>
      {:else}
        <PosterCard {a} {showProgress} {score} {hideStatus} eager={eager && i < 8} />
      {/if}
    {/each}
  </div>
{:else if empty}
  <EmptyState title={empty} icon={emptyIcon} />
{/if}
