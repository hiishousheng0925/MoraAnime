<script>
  /**
   * 播放区里「还没有画面」时的样子：封面模糊做底 + 转圈 + 阶段词，或者加载失败 / 只能跳转 / 没有片源。
   * 两处用：播放器外（搜索片源、加载剧集、失败）和播放器内（已选好这一集、还在解析 —— 播放器不卸载，全屏不会掉）。
   *
   * phase：'搜索片源' | '加载剧集' | '解析中' | null
   * kind：'error'（这一集这次没加载出来）| 'failed'（这个站只能跳转）| 'none'（没有片源）| 'nomatch'（没自动匹配到）| null
   * 失败态只给「重新加载」（主人 2026-10-20：播放器里不放「换片源」「去原站」—— 原站链接在片源栏）；
   * 只能跳转的站本来就没有画面，「到原站看」是它唯一的看法，所以留着
   */
  import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
  import ArrowLeft from 'phosphor-svelte/lib/ArrowLeft';
  import FilmSlate from 'phosphor-svelte/lib/FilmSlate';
  import CoverBackdrop from '$lib/ui/CoverBackdrop.svelte';
  let { a, n = null, site = null, phase = null, kind: st = null, page = null, onretry, onunjump, onopen, onback = null, immersive = false } = $props();
</script>

<!-- 封面在纯黑底上：不跟主题的氛围透明度走（亮色主题的 .3 压在黑底上太暗），这里单独定 -->
<div class="absolute inset-0 isolate flex items-center justify-center overflow-hidden bg-black text-white" style="--c-backdrop-opacity:0.6">
  <CoverBackdrop {a} blur={32} fade="none" saturate={1.25} />
  <div class="absolute inset-0 -z-[5] bg-gradient-to-t from-black/85 via-black/50 to-black/35"></div>

  {#if onback}
    <button onclick={onback} aria-label="返回详情"
            class="tap absolute left-1 top-1.5 grid h-9 w-9 place-items-center rounded-lg text-white/90 hover:bg-white/10 {immersive ? '' : 'sm:hidden'}">
      <ArrowLeft size={20} weight="bold" />
    </button>
  {/if}

  <div class="flex flex-col items-center gap-2 px-6 text-center">
    {#if phase}
      <span class="h-10 w-10 animate-spin rounded-full border-[3px] border-white/15 border-t-white/90"></span>
      <span class="mt-2 text-[13px] tracking-wider text-white/80">{#if n}第 {n} 集 · {/if}{phase}</span>
    {:else if st === 'error' || st === 'failed'}
      {#if site}<span class="text-[11px] font-medium uppercase tracking-[0.18em] text-white/60">{site}</span>{/if}
      <span class="text-2xl font-semibold tracking-tight sm:text-3xl">第 {n} 集</span>
      <span class="text-[13px] text-white/75">{st === 'error' ? '没有加载出来' : '只能在原站播放'}</span>
      {#if st === 'error'}
        <button onclick={onretry} class="mt-2 inline-flex items-center gap-1.5 rounded-full bg-accent px-5 py-2 text-sm font-medium text-on-accent shadow-lg transition hover:brightness-110">
          <ArrowClockwise size={16} weight="bold" />重新加载
        </button>
      {:else}
        <div class="mt-2 flex gap-2">
          <a href={page} target="_blank" rel="noopener noreferrer" onclick={onopen}
             class="inline-flex items-center rounded-full bg-accent px-5 py-2 text-sm font-medium text-on-accent shadow-lg transition hover:brightness-110">到原站看第 {n} 集</a>
          <button onclick={onunjump} aria-label="重新加载" title="重新加载"
                  class="grid h-9 w-9 place-items-center rounded-full border border-white/25 bg-white/10 text-white backdrop-blur hover:bg-white/20"><ArrowClockwise size={16} /></button>
        </div>
      {/if}
    {:else if st}
      <FilmSlate size={34} class="text-white/70" />
      <span class="text-[14px] text-white/85">{st === 'none' ? '没有找到片源' : '未自动匹配到片源'}</span>
    {/if}
  </div>
</div>
