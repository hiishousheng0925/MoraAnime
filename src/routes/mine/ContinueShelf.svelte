<script>
  /**
   * 「继续看」书架：在看的番，一张横卡 = 小封面 + 标题 + 进度 + ▶。整张卡直达观看页。
   * 手机一行横滑（第二张露一截），≥640px 换成网格。
   *
   * props
   *   items  在看的番（带 current_episode / episodes / aired），loader 的 continueShelf()
   *
   * 追平已播集数的卡（$lib/nextEp.js，#7）：右上写「已追平」代替百分比，▶ 降成次要色 ——
   * 点进去观看页停在最新一集，不会跳到还没播的下一集
   */
  import Cover from '$lib/Cover.svelte';
  import Progress from '$lib/ui/Progress.svelte';
  import { dispTitle } from '$lib/format.js';
  import Play from 'phosphor-svelte/lib/Play';
  import { nextEp } from '$lib/nextEp.js';
  let { items } = $props();

  const caught = (a) => nextEp({ status: a.my_status, current: a.current_episode, total: a.episodes, aired: a.aired ?? null }).kind === 'caught';

  const pctOf = (a) => (a.episodes ? Math.min(100, Math.round(((a.current_episode ?? 0) / a.episodes) * 100)) : null);
</script>

<div class="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-1
            sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0 lg:grid-cols-3 xl:grid-cols-4">
  {#each items as a (a.id)}
    {@const pct = pctOf(a)}
    {@const done = caught(a)}
    <a href="/anime/{a.id}/watch"
       class="group flex w-[82%] max-w-[20rem] shrink-0 snap-start items-center gap-3 rounded-xl border border-ink-700 bg-ink-900 p-2.5
              transition duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-lift
              sm:w-auto sm:max-w-none">
      <div class="w-[52px] shrink-0 overflow-hidden rounded-lg shadow-md shadow-black/30 ring-1 ring-white/5">
        <Cover {a} cls="aspect-2/3" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="line-clamp-2 text-[13.5px] font-medium leading-snug transition-colors group-hover:text-accent">{dispTitle(a)}</div>
        <div class="mt-1.5 flex items-baseline justify-between gap-2 text-[11.5px] tabular-nums text-ink-400">
          <span>第 <b class="font-semibold text-ink-100">{a.current_episode ?? 0}</b> / {a.episodes ?? '?'} 集</span>
          {#if done}<span class="font-medium text-accent-ink">已追平</span>{:else if pct != null}<span>{pct}%</span>{/if}
        </div>
        <div class="mt-1.5">
          {#if a.episodes}<Progress current={a.current_episode ?? 0} total={a.episodes} variant="glow" h="h-1" />
          {:else}<div class="h-1 rounded-full bg-ink-700"></div>{/if}
        </div>
      </div>
      <span class="grid size-10 shrink-0 place-items-center rounded-full shadow-md
                   transition-transform duration-200 ease-out group-hover:scale-110 group-active:scale-95
                   {done ? 'border border-ink-600 bg-ink-800 text-ink-200' : 'bg-accent text-on-accent'}"
            aria-hidden="true">
        <Play size={16} weight="fill" class="translate-x-px" />
      </span>
    </a>
  {/each}
</div>
