<script>
  /**
   * 海报墙卡片（全站封面网格统一用它；一般经 CardGrid 用，不直接用）。
   *
   * props
   *   a            番剧行：id / title* / type / is_short / status_eff / episodes / year / bgm_score / bgm_votes /
   *                my_status / current_episode / my_score（各列表查询都已带上）
   *   showProgress 「在看 3/12」带进度                                     默认 false
   *   score        右下角显示哪个分：'bangumi'（Bangumi 分，票数 ≥100 才显示，见 showScore）
   *                | 'mine'（我的分，warm-fill 实心胶囊，统一一位小数；没打分就不显示）   默认 'bangumi'
   *   hideStatus   不显示左下「我的状态 / 进度」徽标 —— 整页本来就是同一个状态时用（如番单的「看完」tab） 默认 false
   *   eager        封面立即加载（首屏第一排用，其余懒加载）                 默认 false
   * 例：<PosterCard {a} score="mine" hideStatus />
   *
   * 角标：左上类型（非 TV 才标）/ 泡面；右上「连载中」= 8px 绿点、「未上映」= 文字角标；
   * 左下我的状态（MY_STATUS_BADGE 按状态分色）；右下分数。已完结是常态，不标。
   * 悬停：整卡上移 2px、阴影加深、accent 描边，封面放大（Cover 的 group-hover:scale-105，外层 <a> 带 group）。
   */
  import Cover from '$lib/Cover.svelte';
  import { TYPE_CN, WATCH_STATUS, STATUS_CN, STATUS_BADGE, MY_STATUS_BADGE, showScore } from '$lib/constants.js';
  import { dispTitle, yearText } from '$lib/format.js';
  let { a, showProgress = false, score = 'bangumi', hideStatus = false, eager = false } = $props();

  const st = $derived(a.status_eff ?? a.status);
  const scoreText = $derived(
    score === 'mine' ? (a.my_score != null ? Number(a.my_score).toFixed(1) : null)
      : showScore(a) ? a.bgm_score.toFixed(1) : null);
  const mine = $derived(!hideStatus && a.my_status ? a.my_status : null);
  // 分隔符显式拼：模板里 `{year}{#if} · …` 的前导空格会被 Svelte 吃掉，出现「2026· 12 集」
  const meta = $derived([yearText(a), a.episodes ? `${a.episodes} 集` : null].filter(Boolean).join(' · '));
</script>

<a href="/anime/{a.id}" class="group block min-w-0 transition-transform duration-200 ease-out hover:-translate-y-0.5">
  <div class="relative overflow-hidden rounded-xl bg-ink-800 shadow-md shadow-black/30 ring-1 ring-white/5
              transition-[box-shadow] duration-200 group-hover:shadow-lift group-hover:ring-accent/40">
    <Cover {a} {eager} cls="aspect-2/3" />
    <div class="pointer-events-none absolute left-1.5 top-1.5 flex gap-1">
      {#if a.type !== 'TV'}<span class="rounded-md bg-black/70 px-1.5 py-0.5 text-[10.5px] text-white/90 backdrop-blur-sm">{TYPE_CN[a.type] ?? a.type}</span>{/if}
      {#if a.is_short}<span class="rounded-md bg-amber-950/70 px-1.5 py-0.5 text-[10.5px] text-white">泡面</span>{/if}
    </div>
    {#if st === 'ONGOING'}
      <span class="pointer-events-none absolute right-2 top-2 size-2 rounded-full bg-live
                   shadow-[0_0_0_2px_rgb(0_0_0/0.55),0_0_8px_var(--c-live)]" title={STATUS_CN.ONGOING}>
        <span class="sr-only">{STATUS_CN.ONGOING}</span>
      </span>
    {:else if st === 'UPCOMING'}
      <span class="pointer-events-none absolute right-1.5 top-1.5 rounded-md px-1.5 py-0.5 text-[10.5px] backdrop-blur-sm {STATUS_BADGE[st]}">{STATUS_CN[st]}</span>
    {/if}
    {#if mine || scoreText}
      <div class="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-1 bg-gradient-to-t from-black/75 via-black/30 to-transparent px-1.5 pb-1.5 pt-6">
        {#if mine}
          <span class="min-w-0 truncate whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10.5px] font-medium backdrop-blur-sm {MY_STATUS_BADGE[mine]}">
            {WATCH_STATUS[mine]}{#if showProgress && a.current_episode != null}{' '}{a.current_episode}/{a.episodes ?? '?'}{/if}
          </span>
        {:else}<span></span>{/if}
        {#if scoreText && score === 'mine'}
          <span class="shrink-0 whitespace-nowrap rounded-full bg-warm-fill px-1.5 py-0.5 text-[11px] font-semibold leading-none text-on-fill">★ {scoreText}</span>
        {:else if scoreText}
          <span class="shrink-0 whitespace-nowrap text-[12px] font-semibold text-white drop-shadow">★ {scoreText}</span>
        {/if}
      </div>
    {/if}
  </div>
  <div class="mt-2 px-0.5">
    <div class="line-clamp-2 text-[13.5px] font-medium leading-snug transition-colors group-hover:text-accent">{dispTitle(a)}</div>
    {#if meta}<div class="mt-0.5 text-[11px] text-ink-400">{meta}</div>{/if}
  </div>
</a>
