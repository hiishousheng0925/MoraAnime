<script>
  import Cover from '$lib/Cover.svelte';
  import InfoTip from '$lib/ui/InfoTip.svelte';
  import { toast } from '$lib/toast.svelte.js';
  import EpisodeSlider from '$lib/ui/EpisodeSlider.svelte';
  import StarScore from '$lib/ui/StarScore.svelte';
  import Section from '$lib/ui/Section.svelte';
  import Chip from '$lib/ui/Chip.svelte';
  import SeriesList from '$lib/ui/SeriesList.svelte';
  import LinkPicker from '$lib/ui/LinkPicker.svelte';
  import CoverBackdrop from '$lib/ui/CoverBackdrop.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import ExternalLinks from '$lib/ui/ExternalLinks.svelte';
  import {
    TYPE_CN, STATUS_CN, SEASON_CN, WATCH_OPTS, showScore, MIN_VOTES_FOR_SCORE,
    STATUS_PILL
  } from '$lib/constants.js';
  import { TAG_TO_GENRE, TAG_NOISE } from '$lib/genres.js';
  import { dispTitle, subTitle, yearText, dispStudio } from '$lib/format.js';
  import { entry } from '$lib/api.js';
  import { invalidateAll, replaceState } from '$app/navigation';
  import { page as pg } from '$app/state';
  import { untrack } from 'svelte';
  import Page from '$lib/ui/Page.svelte';
  import Confirm from '$lib/ui/Confirm.svelte';
  import BackLink from '$lib/ui/BackLink.svelte';
  import Play from 'phosphor-svelte/lib/Play';
  import Trash from 'phosphor-svelte/lib/Trash';
  import CaretDown from 'phosphor-svelte/lib/CaretDown';
  import Stack from 'phosphor-svelte/lib/Stack';
  import CheckCircle from 'phosphor-svelte/lib/CheckCircle';
  import CalendarBlank from 'phosphor-svelte/lib/CalendarBlank';
  import { nextEp, nextAirText } from '$lib/nextEp.js';
  let { data } = $props();

  const a = $derived(data.a);
  const st = $derived(a.status_eff ?? a.status);

  /**
   * 唯一的观看入口 → 观看页（自动搜片源、接着进度播）。原来这里是一排外站搜索按钮，
   * 和下面的片源面板做的是同一件事；外站搜索挪进观看页最下面当备用。
   * 文案和观看页起始集共用 $lib/nextEp.js：追平已播集数时不说「继续看第 N+1 集」，改成次要样式的「已追到第 N 集」+ 下一集更新日（#7）
   */
  const next = $derived(nextEp({ status: a.my_status, current: a.current_episode,
                                 total: data.aired?.total ?? a.episodes, aired: data.aired?.aired ?? null }));
  const waiting = $derived(next.kind === 'caught' || next.kind === 'upcoming');
  const airText = $derived(waiting ? nextAirText({ airdate: data.aired?.next?.airdate, weekday: a.bgm_weekday,
                                                   verb: next.kind === 'upcoming' ? '开播' : '更新' }) : null);
  let saving = $state(false);

  /**
   * 头部封面用清晰版（/cover/:id?hd=1，Bangumi 400px 宽那档；没有就回退普通那张，见 cover/[id]/+server.js）。
   * 背景层用同一个地址，浏览器只下载一次。清晰版也加载失败（断网 503）时退回 Cover 组件的占位。
   */
  const hdSrc = $derived(!a.cover_dead && (a.picture || a.thumbnail) ? `/cover/${a.id}?hd=1` : null);
  let hdBroken = $state(null);

  /** 元信息写成一行文字；只有「已完结 / 连载中」是胶囊（STATUS_PILL），未上映这类并进文字里 */
  const meta = $derived([
    !STATUS_PILL[st] && st === 'UPCOMING' ? STATUS_CN[st] : null,
    TYPE_CN[a.type] ?? a.type,
    `${yearText(a)}${SEASON_CN[a.season] ? ` ${SEASON_CN[a.season]}` : ''}`,
    a.episodes ? `${a.episodes} 集` : null,
    a.duration_sec ? `单集 ${Math.round(a.duration_sec / 60)} 分` : null,
    a.is_short ? '泡面番' : null,
    a.bgm_weekday ? `每周${'一二三四五六日'[a.bgm_weekday - 1]}更新` : null
  ].filter(Boolean));
  const studios = $derived([...new Set((a.studios ?? []).map(dispStudio))].join(' / '));

  const TABS = [['info', '概览'], ['series', '同系列']];
  const urlTab = () => (pg.url.searchParams.get('tab') === 'series' ? 'series' : 'info');
  // 初值直接取网址：$effect 不在服务端跑，打开 ?tab=series 首屏会先闪一下概览
  let tab = $state(urlTab());
  // 换了一部番（同系列里点进另一部）时按网址重新取 tab
  $effect(() => { a.id; tab = untrack(urlTab); });
  function setTab(t) {
    tab = t;
    const u = new URL(pg.url);
    if (t === 'info') u.searchParams.delete('tab'); else u.searchParams.set('tab', t);
    replaceState(u, {});
  }

  const hasLinks = $derived(!!a.bgm_id || !!a.links?.length);

  /**
   * 简介：Bangumi 的简介常是「中文正文 + [简介原文] + 日文原文」，原来整段铺开，
   * 手机上日文占了大半屏。正文默认三行可展开，原文另收进折叠。没有中文正文时原文就当正文。
   * 正文和原文之间常连着三四个空行，压成一个；\r\n 先统一。
   */
  const summary = $derived.by(() => {
    const s = (a.bgm_summary ?? '').replace(/\r\n?/g, '\n').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
    const k = s.indexOf('[简介原文]');
    if (k < 0) return { body: s, orig: '' };
    const body = s.slice(0, k).trim(), orig = s.slice(k + '[简介原文]'.length).trim();
    return body ? { body, orig } : { body: orig, orig: '' };
  });
  let sumOpen = $state(false);
  let sumEl = $state(null);
  let sumW = $state(0);
  let clamped = $state(false);
  $effect(() => { a.id; sumOpen = false; });
  // 只有真被截断了才给「展开」：量 scrollHeight（宽度变了重新量）
  $effect(() => {
    summary.body; sumW;
    if (sumEl && !sumOpen) clamped = sumEl.scrollHeight > sumEl.clientHeight + 1;
  });

  /** 标签中文化：能映射的走中文题材，剩下的英文标签去噪后收进折叠区 */
  const tags = $derived.by(() => {
    const cn = new Set(), en = [];
    for (const t of a.tags ?? []) {
      const k = String(t).toLowerCase().trim();
      if (TAG_NOISE.has(k)) continue;
      if (TAG_TO_GENRE[k]) cn.add(TAG_TO_GENRE[k]); else en.push(t);
    }
    return { cn: [...cn], en: en.slice(0, 24) };
  });

  async function act(fn) {
    saving = true;
    try { await fn(); await invalidateAll(); }
    catch (e) { toast.error(e); }
    finally { saving = false; }
  }
  /**
   * 移出番单会连评分 / 短评 / 进度一起删。有这些内容时先确认（Web Interface Guidelines：
   * 破坏性操作要确认或可撤销）；只是个空标记就直接删，不多打扰。「再点一次当前状态」也走这里。
   */
  let asking = $state(false);
  const hasData = $derived(a.my_score != null || !!a.my_note || (a.current_episode ?? 0) > 0);
  const remove = () => (hasData ? (asking = true) : act(() => entry.clear(a.id)));
  const setStatus = (v) => (a.my_status === v ? remove() : act(() => entry.patch(a.id, { status: v })));

  /** 短评平时一行，聚焦展开两行；失焦（change）保存 */
  let noteFocus = $state(false);
</script>

{#snippet watchBtn(cls)}
  {#if waiting}
    <!-- 追平 / 未开播：没有「下一集」可看，降成和状态分段同一档的次要按钮，第二行写下一集哪天播 -->
    <a href="/anime/{a.id}/watch" data-next={next.kind}
       class="inline-flex h-11 items-center justify-center gap-2.5 rounded-xl border border-ink-600 bg-ink-900/70 px-5
              text-ink-100 backdrop-blur-md transition hover:border-accent/60 hover:bg-ink-800 {cls}">
      {#if next.kind === 'caught'}<CheckCircle size={18} weight="fill" class="shrink-0 text-accent" aria-hidden="true" />
      {:else}<CalendarBlank size={18} class="shrink-0 text-ink-200" aria-hidden="true" />{/if}
      <span class="flex flex-col items-start leading-tight">
        <span class="text-[14px] font-semibold">{next.label}</span>
        {#if airText}<span class="mt-0.5 text-[11.5px] text-ink-200">{airText}</span>{/if}
      </span>
    </a>
  {:else}
    <a href="/anime/{a.id}/watch" data-next={next.kind}
       class="cta inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-6 text-[15px] font-semibold
              text-on-accent transition hover:brightness-110 {cls}">
      <Play size={16} weight="fill" aria-hidden="true" />{next.label}
    </a>
  {/if}
{/snippet}

<!-- 五个状态合成一个分段控件；选中段再点一次 = 移出番单（有内容时先确认） -->
{#snippet statusSeg(cls)}
  <div role="group" aria-label="我的状态"
       class="flex h-11 overflow-hidden rounded-xl border border-ink-600 bg-ink-900/70 backdrop-blur-md {cls}">
    {#each WATCH_OPTS as [v, l], i (v)}
      {@const on = a.my_status === v}
      <button onclick={() => setStatus(v)} disabled={saving} aria-pressed={on} title={on ? '再点一次取消' : undefined}
              class="flex min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-1 text-[14px] transition
                     disabled:cursor-wait sm:px-4 {i ? 'border-l border-ink-700' : ''}
                     {on ? 'bg-accent/20 font-semibold text-ink-100' : 'text-ink-200 hover:bg-ink-800 hover:text-ink-100'}">
        {#if on}<span class="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true"></span>{/if}{l}
      </button>
    {/each}
  </div>
{/snippet}

<Confirm open={asking} danger title="从番单移除？" body="评分 / 短评 / 进度会一起删除" confirmLabel="移除"
         onconfirm={() => { asking = false; act(() => entry.clear(a.id)); }} oncancel={() => (asking = false)} />

<!-- 头部氛围：模糊封面铺顶上 560px、底部渐隐进页面底色（原来是一块定高矩形，未标记的番 tab 栏正好贴着它的硬边） -->
<div class="detail relative isolate" class:cover-tint={data.tint} style={data.tint?.style} data-tint-light={data.tint?.light ? '' : undefined}>
  {#if hdSrc}
    <CoverBackdrop src={hdSrc} height="560px" fadeFrom={45} blur={80} scrim scrimWidth="70%" />
    <!-- 再压一层底色薄纱：封面颜色再艳，头部的小字也要 ≥4.5:1（实测不压时最差 2.6:1） -->
    <div class="veil pointer-events-none absolute inset-x-0 top-0 -z-10 h-[560px]" aria-hidden="true"></div>
  {/if}

  <Page>
    <!-- 用浏览器历史返回 —— 写死 /catalog 会让从排行榜/放送表进来的人跳错页 -->
    <BackLink onclick={() => history.back()}>返回</BackLink>

    <div class="mt-4 flex items-start gap-4 sm:mt-5 sm:items-end sm:gap-7">
      {#key a.id}
        <div class="hero-cover cover relative aspect-2/3 w-[124px] shrink-0 overflow-hidden rounded-xl shadow-hero sm:w-48 sm:rounded-2xl">
          {#if hdSrc && hdBroken !== hdSrc}
            <img src={hdSrc} alt={dispTitle(a)} fetchpriority="high" onerror={() => (hdBroken = hdSrc)}
                 class="h-full w-full object-cover" />
          {:else}
            <Cover {a} eager cls="h-full w-full" />
          {/if}
        </div>
      {/key}

      <div class="min-w-0 flex-1 sm:pb-1">
        <h1 class="text-[21px] font-bold leading-tight tracking-tight text-ink-100 sm:text-[34px] sm:leading-[1.15]">{dispTitle(a)}</h1>
        {#if subTitle(a)}<div class="mt-1 text-[13px] text-ink-200 max-sm:line-clamp-2 sm:mt-1.5 sm:text-[15px]">{subTitle(a)}</div>{/if}
        {#if a.title_ja && a.title_ja !== dispTitle(a) && a.title_ja !== subTitle(a)}
          <div class="mt-0.5 text-[12px] text-ink-200 sm:text-[13px]">{a.title_ja}</div>
        {/if}
        {#if !a.title_cn}<div class="mt-1 text-[12px] text-ink-200">中文名待补充</div>{/if}

        <div class="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-ink-200 sm:mt-3.5 sm:text-[13px]">
          {#if STATUS_PILL[st]}
            <span class="mr-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-semibold {STATUS_PILL[st]}">
              {#if st === 'ONGOING'}<span class="size-1.5 rounded-full bg-live" aria-hidden="true"></span>{/if}{STATUS_CN[st]}
            </span>
          {/if}
          {#each meta as m, i (i)}
            {#if i}<span class="text-ink-200" aria-hidden="true">·</span>{/if}<span>{m}</span>
          {/each}
          {#if studios}<span class="text-ink-200 sm:hidden" aria-hidden="true">·</span><span class="sm:hidden">{studios}</span>{/if}
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 sm:mt-4">
          {#if showScore(a)}
            <div class="flex items-center gap-2.5 sm:gap-3">
              <b class="text-[30px] font-bold leading-none tracking-tight text-warm sm:text-[40px]">{a.bgm_score.toFixed(1)}</b>
              <div class="text-[12px] leading-normal text-ink-200">
                <div class="font-semibold text-ink-100">{a.bgm_rank > 0 ? `Bangumi 第 ${a.bgm_rank}` : 'Bangumi'}</div>
                <div>{(a.bgm_votes ?? 0).toLocaleString()} 人评</div>
              </div>
            </div>
          {:else if st === 'UPCOMING'}
            <div class="text-[13px] text-ink-200">暂无评分</div>
          {:else if a.bgm_score != null}
            <div class="flex items-center gap-1.5 text-[13px] text-ink-200">
              暂不展示评分
              <InfoTip label="为什么" w="18rem">
                <p class="text-[12px] leading-relaxed text-ink-400">
                  Bangumi 上只有 {a.bgm_votes ?? 0} 人评价，少于 {MIN_VOTES_FOR_SCORE} 票。
                  样本太小的分数没有参考价值。
                </p>
              </InfoTip>
            </div>
          {/if}
          {#if studios}
            <div class="hidden items-center gap-5 sm:flex">
              {#if showScore(a) || a.bgm_score != null || st === 'UPCOMING'}<span class="h-9 w-px bg-ink-600" aria-hidden="true"></span>{/if}
              <div class="text-[12px] leading-normal text-ink-200">
                <div>制作</div>
                <div class="text-[13px] font-semibold text-ink-100">{studios}</div>
              </div>
            </div>
          {/if}
        </div>

        <div class="mt-6 hidden flex-wrap items-center gap-3 sm:flex">
          {@render watchBtn('')}
          {@render statusSeg('')}
        </div>
      </div>
    </div>

    <!-- 手机：主按钮整行、分段控件五等分整行（挤在标题旁时信息列只剩一百多 px） -->
    <div class="mt-5 space-y-2.5 sm:hidden">
      {@render watchBtn('flex w-full')}
      {@render statusSeg('w-full')}
    </div>

    <!-- 「我的记录」只在标记过之后出现。半透明 + 背景模糊，压在头部渐隐区上和头部连成一体 -->
    {#if a.my_status}
      <section class="record mt-6 rounded-2xl border border-ink-700 bg-ink-900/75 p-4 shadow-lift backdrop-blur-xl sm:mt-8 sm:p-5">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-[13px] font-semibold text-ink-400">我的记录</h2>
          <button onclick={remove} disabled={saving}
                  class="tap -my-1 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-ink-400 transition
                         hover:bg-ink-800 hover:text-danger disabled:opacity-50">
            <Trash size={14} aria-hidden="true" />从番单移除
          </button>
        </div>

        <!-- 进度和评分：宽屏左右并排、中间一道竖线；窄屏上下排 -->
        <div class="mt-3 md:flex md:items-stretch md:gap-6">
          <div class="md:min-w-0 md:flex-1">
            <EpisodeSlider current={a.current_episode} total={data.aired?.total ?? a.episodes} aired={data.aired?.aired ?? null} disabled={saving}
                           onset={(n) => act(() => entry.patch(a.id, { current_episode: n }))}
                           onbump={(d) => act(() => entry.bump(a.id, d))} />
          </div>
          <div class="mt-4 border-t border-ink-700 pt-4 md:mt-0 md:shrink-0 md:border-l md:border-t-0 md:pl-6 md:pt-0">
            <StarScore value={a.my_score} disabled={saving}
                       onset={(v) => act(() => entry.patch(a.id, { my_score: v }))} />
          </div>
        </div>

        <textarea placeholder="一句话短评" value={a.my_note ?? ''} rows={noteFocus ? 2 : 1} aria-label="短评"
                  onfocus={() => (noteFocus = true)} onblur={() => (noteFocus = false)}
                  onchange={(e) => act(() => entry.patch(a.id, { my_note: e.currentTarget.value }))}
                  class="mt-4 block w-full resize-none rounded-xl border border-ink-700 bg-ink-800/70 px-3.5 py-2.5
                         text-[14px] leading-6 outline-none transition placeholder:text-ink-400 focus:border-accent"></textarea>
      </section>
    {/if}

    <!-- 拆成两个 tab（主人 2026-10-18，参考 Kazumi）：原来简介 / 题材 / 同系列 / 外部条目一路往下排，
         同系列常有十几部，要找外部条目得滚很久。观看在单独的页面，不占 tab。
         tab 记在网址上（?tab=series）、切换用 replaceState —— 刷新停在原 tab，「← 返回」不会先退一个 tab -->
    <div role="tablist" class="mt-8 flex gap-6 border-b border-ink-700 sm:mt-10">
      {#each TABS as [k, l] (k)}
        <button role="tab" id="tab-{k}" aria-selected={tab === k} aria-controls={tab === k ? 'tabpanel' : undefined} onclick={() => setTab(k)}
                class="-mb-px border-b-2 px-0.5 pb-2.5 text-[15px] transition
                       {tab === k ? 'border-accent font-semibold text-ink-100' : 'border-transparent text-ink-400 hover:text-ink-200'}">
          {l}{#if k === 'series' && a.related?.length}<span class="ml-1.5 text-[13px] font-normal text-ink-400">{a.related.length}</span>{/if}
        </button>
      {/each}
    </div>

    {#key tab}
    <div class="tab-in" role="tabpanel" id="tabpanel" aria-labelledby="tab-{tab}">
    {#if tab === 'info'}
      {#if summary.body}
        <Section title="简介">
          <!-- 不限宽：72ch 按西文字符算，中文一行只放得下三十几个字，句子说到一半就折行（主人 2026-10-18） -->
          <p bind:this={sumEl} bind:clientWidth={sumW}
             class="whitespace-pre-line text-[15px] leading-[1.85] text-ink-200 {sumOpen ? '' : 'line-clamp-3'}">{summary.body}</p>
          {#if clamped || sumOpen}
            <button onclick={() => (sumOpen = !sumOpen)} class="mt-1 text-[13px] font-medium text-accent hover:underline">
              {sumOpen ? '收起' : '展开'}
            </button>
          {/if}
          {#if summary.orig}
            <details class="group mt-3">
              <summary class="inline-flex cursor-pointer list-none items-center gap-1 text-[13px] text-ink-400 hover:text-ink-200">
                原文<CaretDown size={12} class="transition group-open:rotate-180" aria-hidden="true" />
              </summary>
              <p class="mt-2 whitespace-pre-line text-[14px] leading-[1.85] text-ink-400">{summary.orig}</p>
            </details>
          {/if}
        </Section>
      {/if}
      {#if tags.cn.length || tags.en.length}
        <Section title="题材">
          <!-- 不用选中态（on）：这些是去目录的链接，不是选中项。原来整墙 accent 描边，比主按钮还抢眼（#112） -->
          <div class="flex flex-wrap gap-2">
            {#each tags.cn as g (g)}<Chip tone="soft" href="/catalog?g={encodeURIComponent(g)}">{g}</Chip>{/each}
          </div>
          {#if tags.en.length}
            <details class="group mt-3">
              <summary class="inline-flex cursor-pointer list-none items-center gap-1 text-[13px] text-ink-400 hover:text-ink-200">
                其他标签 {tags.en.length}<CaretDown size={12} class="transition group-open:rotate-180" aria-hidden="true" />
              </summary>
              <div class="mt-2 flex flex-wrap gap-1.5">
                {#each tags.en as t (t)}
                  <a href="/catalog?tag={encodeURIComponent(t)}"
                     class="rounded-full bg-ink-800 px-2.5 py-1 text-[12px] text-ink-400 hover:bg-ink-700 hover:text-ink-200">{t}</a>
                {/each}
              </div>
            </details>
          {/if}
        </Section>
      {/if}
      {#if hasLinks}
        <Section title="外部条目"><ExternalLinks links={a.links ?? []} bangumiUrl={a.bgm_id ? `https://bgm.tv/subject/${a.bgm_id}` : null} /></Section>
      {/if}
      {#if !summary.body && !tags.cn.length && !tags.en.length && !hasLinks}
        <div class="mt-6"><EmptyState title="暂无简介" icon={Stack} /></div>
      {/if}
    {:else}
      <div class="mt-5">
        {#if a.related?.length}
          <SeriesList items={a.related} currentId={a.id} franchise={a.franchise}
                      hasCustomOrder={a.hasCustomOrder} />
        {:else}
          <EmptyState title="暂无关联作品" icon={Stack} />
        {/if}
        <!-- 手动关联同样是公共修正：只有管理员能加（别人看得到加好的结果，在上面的系列里） -->
        {#if data.user?.role === 'admin'}<div class="mt-3"><LinkPicker animeId={a.id} links={data.manualLinks} /></div>{/if}
      </div>
    {/if}
    </div>
    {/key}
    <div class="h-6"></div>
  </Page>
</div>

<style>
  /* 背景层浓度：暗色 0.55（基础层默认）、亮色 0.45（基础层默认 0.3 对这么大一片头部太淡） */
  .detail { --c-backdrop-opacity: 0.55; }
  :global(:root[data-theme='light']) .detail { --c-backdrop-opacity: 0.45; }
  .veil {
    background: color-mix(in srgb, var(--c-bg) var(--veil), transparent);
    --veil: 38%;
  }
  :global(:root[data-theme='light']) .veil { --veil: 45%; }
  /* 主按钮的 accent 光晕 */
  .cta { box-shadow: 0 8px 24px -8px color-mix(in srgb, var(--c-accent) 70%, transparent); }
  /* 进场：封面 .98→1；tab 内容淡入。系统「减少动态效果」时 app.css 全局把时长压成 0 */
  .hero-cover { animation: cover-in 220ms cubic-bezier(.2, .7, .3, 1) both; }
  .tab-in { animation: tab-in 200ms ease-out both; }
  @keyframes cover-in { from { opacity: 0; transform: scale(.98); } }
  @keyframes tab-in { from { opacity: 0; transform: translateY(4px); } }
</style>
