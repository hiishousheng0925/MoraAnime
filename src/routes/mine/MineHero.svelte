<script>
  /**
   * 番单页头：最近那部的封面做氛围底 + 大号累计数字 + 右侧最近几部的封面扇。
   * 数字由 loader 算（口径同统计页：status <> 'plan'），这里只负责排版。
   *
   * props
   *   hero   { days, avg, recent[] }  —— loader 的 myHero()
   *   stats  { total, episodes }      —— myStats()
   *   name   用户名
   */
  import CoverBackdrop from '$lib/ui/CoverBackdrop.svelte';
  import Cover from '$lib/Cover.svelte';
  let { hero, stats, name = null } = $props();

  const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');
  const items = $derived([
    { v: fmt(stats.total), u: '部' },
    { v: fmt(stats.episodes), u: '集' },
    { v: `${hero.days > 0 && hero.days < 1 ? '<1' : fmt(Math.round(hero.days))}`, u: '天', pre: '≈' },
    ...(hero.avg != null ? [{ v: hero.avg.toFixed(1), u: '均分', warm: true }] : [])
  ]);
  const fan = $derived(hero.recent.slice(0, 5));
  // 扇形：中间那张最高，两边依次压低、外转
  const tilt = (i, n) => (i - (n - 1) / 2) * 7;
</script>

<section class="relative isolate overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-hero">
  {#if fan[0]}<CoverBackdrop a={fan[0]} blur={64} fade="none" scrim scrimWidth="75%" position="50% 30%" />{/if}
  <div class="flex items-center gap-6 px-4 py-4 sm:px-7 sm:py-6">
    <div class="min-w-0 flex-1">
      <div class="flex items-baseline gap-2.5">
        <h1 class="text-[22px] font-bold leading-tight tracking-tight sm:text-[28px]">我的番单</h1>
        {#if name}<span class="truncate text-[12px] text-ink-400">{name}</span>{/if}
      </div>
      <dl class="mt-3 grid grid-cols-4 gap-x-3 sm:mt-5 sm:flex sm:gap-x-9">
        {#each items as it}
          <div class="min-w-0">
            <dt class="sr-only">{it.u}</dt>
            <dd class="flex items-baseline gap-0.5 whitespace-nowrap tabular-nums">
              {#if it.pre}<span class="text-[14px] text-ink-400 sm:text-[18px]">{it.pre}</span>{/if}
              <span class="text-[22px] font-bold leading-none tracking-tight sm:text-[34px]
                           {it.warm ? 'text-warm' : 'text-ink-100'}">{it.v}</span>
              <span class="ml-0.5 text-[11px] text-ink-400 sm:text-[13px]">{it.u}</span>
            </dd>
          </div>
        {/each}
      </dl>
    </div>
    {#if fan.length >= 3}
      <div class="relative hidden h-[148px] shrink-0 items-end md:flex" style="width:{64 + fan.length * 44}px" aria-hidden="true">
        {#each fan as a, i (a.id)}
          <div class="absolute bottom-0 w-[92px] origin-bottom overflow-hidden rounded-lg shadow-lift ring-1 ring-white/10
                      transition-transform duration-300 ease-out"
               style="left:{i * 44}px; transform:rotate({tilt(i, fan.length)}deg) translateY({Math.abs(i - (fan.length - 1) / 2) * 6}px);
                      z-index:{10 - Math.abs(i - Math.floor(fan.length / 2))}">
            <Cover {a} cls="aspect-2/3" eager />
          </div>
        {/each}
      </div>
    {/if}
  </div>
</section>
