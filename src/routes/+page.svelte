<script>
  import CardGrid from '$lib/ui/CardGrid.svelte';
  import Section from '$lib/ui/Section.svelte';
  import Cover from '$lib/Cover.svelte';
  import CoverBackdrop from '$lib/ui/CoverBackdrop.svelte';
  import HeroUpdate from '$lib/ui/HeroUpdate.svelte';
  import EpisodeStepper from '$lib/ui/EpisodeStepper.svelte';
  import Progress from '$lib/ui/Progress.svelte';
  import { STATUS_CN, TYPE_CN, showScore } from '$lib/constants.js';
  import { dispTitle, epTitle } from '$lib/format.js';
  import { entry } from '$lib/api.js';
  import { toast } from '$lib/toast.svelte.js';
  import { invalidate } from '$app/navigation';
  import Play from 'phosphor-svelte/lib/Play';
  import Lightning from 'phosphor-svelte/lib/Lightning';
  import Page from '$lib/ui/Page.svelte';
  import { nextEp, nextAirText } from '$lib/nextEp.js';
  let { data } = $props();

  /**
   * 本地 state：+1 后就地改进度，不走导航。同步认准 data.watching 的引用（同 triage 页的说明）——
   * bump 后 invalidate('app:stats') 会重跑根布局，合并出来的 data 是新对象，
   * 无条件 `items = data.watching` 会把刚改的进度盖回旧值
   */
  let items = $state(data.watching);
  let syncedFrom = data.watching;
  $effect(() => {
    if (data.watching === syncedFrom) return;
    syncedFrom = data.watching;
    items = data.watching;
  });
  const hasAny = $derived((data.stats.total ?? 0) > 0);
  const triaged = $derived(data.triage.decided > 0);
  const remain = $derived(data.triage.remaining ?? 0);

  /**
   * 首屏 hero 只放一张，按优先级取：
   *   今天更新 → 我在追的第一部（继续看）→ 冷启动引导（登录了还没任何记录）
   *   → 快速标记进度（标过但没有在看的）→ 推荐第一部（访客 / 其余情况）
   * 推荐第一部上了 hero 时，下面的推荐网格就从第二部起（server 多取一条，网格仍是 8×2）。
   */
  /** 今天更新里已经看过今天那一集的不上 hero（看完了还写「播放 第 3 集」，#7 同一类） */
  const today = $derived(data.today.filter((x) => (x.current_episode ?? 0) < x.ep.n));
  const kind = $derived(
    today.length ? 'today'
    : items.length ? 'watching'
    : data.user && !hasAny && !triaged ? 'onboard'
    : triaged ? 'triage'
    : 'recommend');
  const recRest = $derived(data.recommend.slice(kind === 'recommend' ? 1 : 0, (kind === 'recommend' ? 1 : 0) + 16));
  // 拼封面墙用的高分封面（冷启动 / 快速标记两种 hero 没有「一部番」可展示）
  const mosaic = $derived(data.recommend.slice(0, 4));

  // 今天有多部更新时，右下角小海报切换；导航回来时回到第一部
  let pick = $state(0);
  $effect(() => { data.today; pick = 0; });
  const t = $derived(today[Math.min(pick, today.length - 1)]);
  /**
   * 「继续看」那张：下一集的说法和详情页、观看页共用 $lib/nextEp.js（#7）。
   * 优先挑真有下一集可看的；全都追平了才放追平的那部（写「已追到第 N 集」+ 下一集哪天播，不给播放主按钮）
   */
  const nx = (x) => nextEp({ status: x.my_status, current: x.current_episode, total: x.episodes, aired: x.aired ?? null });
  const w = $derived(items.find((x) => ['resume', 'start'].includes(nx(x).kind)) ?? items[0]);
  const wn = $derived(w ? nx(w) : null);
  const wWait = $derived(wn?.kind === 'caught' || wn?.kind === 'upcoming');
  const wAir = $derived(wWait ? nextAirText({ airdate: w.next?.airdate, weekday: w.bgm_weekday,
                                              verb: wn.kind === 'upcoming' ? '开播' : '更新' }) : null);
  const rec = $derived(data.recommend[0]);

  // 防连点：请求没回来前同一部再点不发（连点两下 +1 会在旧进度上各加一次，结果取决于先后）
  const pending = {};
  async function bump(a, delta) {
    if (pending[a.id]) return;
    pending[a.id] = true;
    try {
      const { entry: e } = await entry.bump(a.id, delta);
      if (e.status === 'completed') items = items.filter((x) => x.id !== a.id);
      else items = items.map((x) => x.id === a.id
        ? { ...x, current_episode: e.current_episode,
            // 有分集数据时按已播集数算（见 +page.server.js），没有就按总集数
            behind: (x.aired ?? x.episodes) != null ? (x.aired ?? x.episodes) - e.current_episode : null }
        : x);
      // 侧栏 / 顶栏的「在看」「看完」数字在根布局 load 里算，同快速标记页
      invalidate('app:stats');
    } catch (err) { toast.error(err); }
    finally { delete pending[a.id]; }
  }

  const BTN = `inline-flex h-11 items-center justify-center gap-2 rounded-xl px-5 text-[14.5px] font-semibold
               transition active:scale-[0.98]`;
  // 手机上主按钮吃掉整行剩余宽度，次按钮保持紧凑
  const PRIMARY = `${BTN} max-sm:flex-1 bg-accent text-on-accent shadow-[0_8px_24px_-8px_var(--c-accent)] hover:brightness-110`;
  const SECONDARY = `${BTN} border border-ink-600 bg-ink-900/60 font-medium text-ink-200 backdrop-blur-sm
                     hover:border-ink-400 hover:text-ink-100`;
  const META = 'mt-1 text-[12.5px] text-ink-400';
</script>

<Page>
  <h1 class="sr-only">首页</h1>

  {#if kind === 'today'}
    <HeroUpdate a={t} kicker="今天更新" title={dispTitle(t)} href="/anime/{t.id}">
      <p class="mt-2 line-clamp-1 text-[15px] text-ink-200">
        <b class="font-semibold text-warm">第 {t.ep.n} 集</b>{epTitle(t.ep) ? ` · ${epTitle(t.ep)}` : ''}
      </p>
      <p class={META}>
        {t.my_status === 'watching' ? '在看' : '想看'} · 已看 {t.current_episode ?? 0}{t.episodes ? ` / ${t.episodes}` : ''}
      </p>
      {#snippet actions()}
        <a href="/anime/{t.id}/watch?ep={t.ep.n}" class={PRIMARY}><Play size={15} weight="fill" />播放 第 {t.ep.n} 集</a>
        <a href="/anime/{t.id}" class={SECONDARY}>详情</a>
      {/snippet}
      {#snippet aside()}
        {#if today.length > 1}
          <div class="flex gap-2" role="group" aria-label="今天更新">
            {#each today as x, i (x.id)}
              <button type="button" onclick={() => (pick = i)} aria-pressed={i === pick} aria-label={dispTitle(x)}
                      title={dispTitle(x)}
                      class="rounded-lg transition hover:opacity-100 {i === pick ? 'ring-2 ring-accent' : 'opacity-70 ring-1 ring-ink-600'}">
                <Cover a={x} cls="aspect-[2/3] w-10 rounded-lg sm:w-11" />
              </button>
            {/each}
          </div>
        {/if}
      {/snippet}
    </HeroUpdate>

  {:else if kind === 'watching'}
    <HeroUpdate a={w} kicker={wWait ? '在追' : '继续看'} tone="accent" title={dispTitle(w)} href="/anime/{w.id}">
      <p class="mt-2 text-[15px] text-ink-200" data-next={wn.kind}>
        {#if wWait}
          <b class="font-semibold text-accent-ink">{wn.label}</b>{wAir ? ` · ${wAir}` : ''}
        {:else}
          <b class="font-semibold text-accent-ink">第 {wn.ep} 集</b>{w.behind > 1 ? ` · 未看 ${w.behind} 集` : ''}
        {/if}
      </p>
      <p class={META}>
        已看 {w.current_episode ?? 0}{w.episodes ? ` / ${w.episodes}` : ''}{w.status === 'ONGOING' ? ` · ${STATUS_CN.ONGOING}` : ''}
      </p>
      {#snippet actions()}
        {#if wWait}
          <!-- 追平了没有「下一集」：不给发光的主按钮。观看页自己决定放哪集（片源已有下一集就放下一集） -->
          <a href="/anime/{w.id}/watch" class={SECONDARY}><Play size={15} weight="fill" />观看</a>
        {:else}
          <a href="/anime/{w.id}/watch?ep={wn.ep}" class={PRIMARY}><Play size={15} weight="fill" />{wn.kind === 'resume' ? `继续看 第 ${wn.ep} 集` : wn.kind === 'start' ? '播放 第 1 集' : wn.label}</a>
        {/if}
        <a href="/anime/{w.id}" class={SECONDARY}>详情</a>
      {/snippet}
    </HeroUpdate>

  {:else if kind === 'onboard'}
    <!-- 访客没有「观看记录」可言，冷启动引导只给登录了还没标过的人（多账号，2026-10-19） -->
    <HeroUpdate covers={mosaic} title="尚无观看记录">
      <p class="mt-2 text-[15px] text-ink-200">库内 <b class="font-semibold text-ink-100">{data.libraryTotal.toLocaleString()}</b> 部作品</p>
      {#snippet actions()}
        <a href="/triage" class={PRIMARY}><Lightning size={16} weight="fill" />开始快速标记</a>
        <a href="/catalog" class={SECONDARY}>浏览目录</a>
      {/snippet}
    </HeroUpdate>

  {:else if kind === 'triage'}
    <HeroUpdate covers={mosaic} kicker="快速标记进度" tone="accent"
                title="已判定 {data.triage.decided.toLocaleString()} / {data.triage.pool.toLocaleString()}">
      <div class="mt-3 max-w-md"><Progress current={data.triage.decided} total={data.triage.pool} variant="glow" h="h-[5px]" /></div>
      <p class={META}>
        {#if data.triage.seen === 0}<span class="text-warm">「看过」为 0 部</span>
        {:else}看过 <b class="font-semibold text-ink-200">{data.triage.seen}</b> 部{/if}
      </p>
      {#snippet actions()}
        {#if remain}
          <a href="/triage" class={PRIMARY}><Lightning size={16} weight="fill" />继续标记 · 剩余 {remain.toLocaleString()}</a>
        {/if}
        <a href="/catalog?watch=none&status=FINISHED&sort=score" class={SECONDARY}>浏览目录</a>
      {/snippet}
    </HeroUpdate>

  {:else if rec}
    <HeroUpdate a={rec} kicker="推荐" tone="accent" title={dispTitle(rec)} href="/anime/{rec.id}">
      <p class="mt-2 text-[15px] text-ink-200">
        {#if showScore(rec)}<b class="font-semibold text-warm">★ {rec.bgm_score.toFixed(1)}</b>{' · '}{/if}{[rec.year, TYPE_CN[rec.type] ?? rec.type, rec.episodes ? `${rec.episodes} 集` : null].filter(Boolean).join(' · ')}
      </p>
      {#snippet actions()}
        <!-- 访客也能站内播放，主按钮一样给「播放」；登录入口在顶栏 / 侧栏，hero 里不重复放 -->
        <a href="/anime/{rec.id}/watch?ep=1" class={PRIMARY} data-hero-play><Play size={15} weight="fill" />{rec.episodes === 1 ? '播放' : '播放 第 1 集'}</a>
        <a href="/anime/{rec.id}" class={SECONDARY}>详情</a>
      {/snippet}
    </HeroUpdate>
  {/if}

  <!-- 顺序：今天更新（hero）→ 推荐 → 我在追的 → 最近已看过（主人定的，今天更新 2026-10-19 加在最前）。
       「我在追的」通常只有两三条、而且侧栏和顶栏已经有「在看 N」的入口，
       首屏第一眼给「接下来能看什么」更有用。 -->
  {#if recRest.length}
    <!-- 「推荐」而不是「接下来看什么」：后者是口语提问式。
         右边是去目录的入口，和「我在追的」右边的「全部 →」同一种东西 ——
         原来那儿放的是来源标签（「口味相近」），既不能点、又在解释算法。
         推荐是「挑几个给你看」，看不中就该有地方去翻全部，那个地方是目录。
         手机上一行横滑：16 张竖排要翻 6 屏。 -->
    <Section title="推荐" action="目录 →" actionHref="/catalog">
      <CardGrid items={recRest} variant="row" />
    </Section>
  {/if}

  {#if items.length}
    <Section title="我在追的" count={items.length} action="全部 →" actionHref="/mine?status=watching">
      <div class="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(340px,100%),1fr))]">
        {#each items as a (a.id)}
          <div class="relative isolate flex items-center gap-3.5 overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 p-3">
            <CoverBackdrop {a} blur={28} intensity={0.45} fade="none" position="50% 30%" />
            <a href="/anime/{a.id}" class="shrink-0" tabindex="-1" aria-hidden="true">
              <Cover {a} cls="aspect-[2/3] w-16 rounded-[10px] shadow-[0_6px_16px_-6px_rgb(0_0_0/0.5)]" />
            </a>
            <div class="min-w-0 flex-1">
              <a href="/anime/{a.id}" class="line-clamp-1 text-[14.5px] font-semibold text-ink-100 hover:text-accent-ink">{dispTitle(a)}</a>
              <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-400">
                <span>已看 {a.current_episode ?? 0}/{a.episodes ?? '?'}{#if a.aired && a.episodes && a.aired < a.episodes} · 已播 {a.aired}{/if}</span>
                {#if a.behind > 0}
                  <!-- 「未看 N 集」而不是「落后 N 集」：中文的「落后」带贬义（落后于人），
                       而这里只是个进度事实，不是在评判主人追得慢 -->
                  <span class="rounded-md bg-warm-fill/15 px-1.5 py-0.5 font-medium text-warm">未看 {a.behind} 集</span>
                {/if}
                <!-- 文案走 STATUS_CN，别在这里写死 —— 主人把「更新中」改成「连载中」时
                     这一处漏了就会两个词并存。绿色跟封面上的连载中小圆点一致 -->
                {#if a.status === 'ONGOING'}<span class="text-live-ink">{STATUS_CN.ONGOING}</span>{/if}
              </div>
              <div class="mt-2.5"><Progress current={a.current_episode} total={a.episodes} variant="glow" h="h-[5px]" /></div>
            </div>
            <EpisodeStepper onbump={(d) => bump(a, d)} />
          </div>
        {/each}
      </div>
    </Section>
  {/if}

  {#if data.recentlySeen.length}
    <!-- 区块本身就是「看完」，卡上不再挂「看完 12/12」；角上给我的评分（没打分就空着） -->
    <Section title="最近已看过" action="全部 {data.stats.completed ?? 0} 部"
             actionHref="/mine?status=completed">
      <CardGrid items={data.recentlySeen} variant="row" hideStatus score="mine" />
    </Section>
  {/if}
  <div class="h-6"></div>
</Page>
