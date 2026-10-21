<script>
  import Cover from '$lib/Cover.svelte';
  import YearPill from '$lib/ui/YearPill.svelte';
  import ResetButton from '$lib/ui/ResetButton.svelte';
  import { dispTitle } from '$lib/format.js';
  import { triage } from '$lib/api.js';
  import { toast } from '$lib/toast.svelte.js';
  import { invalidate } from '$app/navigation';
  import InfoTip from '$lib/ui/InfoTip.svelte';
  import Confirm from '$lib/ui/Confirm.svelte';
  import Page from '$lib/ui/Page.svelte';
  import Progress from '$lib/ui/Progress.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import { CARD_GRID } from '$lib/ui/grid.js';
  import { media } from '$lib/media.svelte.js';
  import { page as pg } from '$app/state';
  import { makeHref } from '$lib/urlBuild.js';
  import { Tween } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';
  import Check from 'phosphor-svelte/lib/Check';
  import Confetti from 'phosphor-svelte/lib/Confetti';
  let { data } = $props();

  const href = $derived(makeHref('/triage', pg.url.searchParams));

  /**
   * ⚠️ $state(data.x) 只在初始化时快照一次。导航（换年份）后 prop 变了但本地状态不变，
   * 表现为「URL 改了、卡片没换，刷新才对」。所以要用 $effect 跟随 data 同步。
   * 这里之所以还用本地 state 而不是纯 $derived：提交一批后要用 API 返回的新队列
   * 就地替换，不走导航。
   *
   * ⚠️⚠️ 但同步【必须认准来源】，不能只写 `$effect(() => { queue = data.queue })`。
   * run() 里会 invalidate('app:stats') 去刷侧栏的数字，那会重跑【根布局】的 load；
   * 本页的 load 没有重跑，可是父层数据一变，合并出来的 data 对象就是新的，
   * effect 跟着跑一遍，把刚从 API 拿到的新队列又覆盖成 page load 那份【旧】队列 ——
   * 实测点「下一批」后侧栏数字变了（4645→4621），页面里的卡片和「已判定 216」
   * 却一动不动，刷新才对。
   *
   * 判据用 data.queue 的引用：page load 每次都返回新数组，所以
   *   引用没变 = 只是父层数据变了 → 不动本地状态
   *   引用变了 = 本页 load 真的重跑了（换年份 / 刷新）→ 整体同步，并清掉勾选
   */
  let queue = $state(data.queue);
  let stats = $state(data.stats);
  let years = $state(data.years);
  let syncedFrom = data.queue;
  $effect(() => {
    if (data.queue === syncedFrom) return;
    syncedFrom = data.queue;
    queue = data.queue; stats = data.stats; years = data.years; marks = {};
  });
  let marks = $state({});
  let saving = $state(false);

  const seenCount = $derived(Object.keys(marks).length);
  const lastBatch = $derived(stats.lastBatch);
  const scope = $derived({ yearMin: data.year, yearMax: data.year });
  const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');
  const pct = $derived(stats.pool ? (stats.decided / stats.pool) * 100 : 0);

  /**
   * 节奏感：「看过」数字滚动跳到新值、旁边冒一个 +N；「本次」是这一趟打开页面以来累计标了多少部看过
   * （纯前端，刷新清零）。撤销时按提交时记下的数退回去 —— 撤的是更早的批次就不动它。
   */
  // 服务端渲染 / 水合前直接显示 stats.seen；水合后第一次对齐不播动画，之后每次变化滚过去
  const seenShown = new Tween(0, { duration: 600, easing: cubicOut });
  let tweenReady = $state(false);
  let tweenFirst = true;
  $effect(() => {
    const v = stats.seen ?? 0;
    seenShown.set(v, { duration: tweenFirst || media.reducedMotion ? 0 : 600 });
    tweenFirst = false;
    tweenReady = true;
  });
  let session = $state(0);
  let sessionBatches = [];
  let bump = $state(null);          // { n, k } —— k 变了就重播 +N 动画

  const toggle = (id) => {
    const m = { ...marks };
    if (m[id]) delete m[id]; else m[id] = true;
    marks = m;
  };

  async function run(fn) {
    if (saving) return null;
    saving = true;
    try {
      const r = await fn();
      if (r.queue) queue = r.queue;
      if (r.years) years = r.years;
      if (r.stats) stats = r.stats;
      marks = {};
      // 侧栏和页头的数字在根布局的 load 里算，这里是 API 调用、不导航 ——
      // 不主动让它重跑的话，页头写着「待判定 480」而侧栏还挂着 504
      invalidate('app:stats');
      return r;
    } catch (e) { toast.error(e); return null; }
    finally { saving = false; }
  }

  /** 待确认的动作。原生 confirm() 会弹出浏览器自带的「站点 says」弹窗，换成站内的 */
  let ask = $state(null);

  /** 提交时勾过的卡先淡出（和请求并行，至少等这么久再换新一批） */
  let leaving = $state(false);
  const LEAVE_MS = 200;

  async function submitBatch() {
    const batch = queue.map((a) => ({ id: a.id, verdict: marks[a.id] ? 'seen' : 'not_seen' }));
    const n = seenCount;
    const anim = !media.reducedMotion;
    leaving = anim;
    const minWait = new Promise((res) => setTimeout(res, anim ? LEAVE_MS : 0));
    const r = await run(async () => { const out = await triage.submit(batch, scope); await minWait; return out; });
    leaving = false;
    if (!r) return;
    session += n;
    sessionBatches.push(n);
    if (n) bump = { n, k: (bump?.k ?? 0) + 1 };
    window.scrollTo({ top: 0, behavior: anim ? 'smooth' : 'auto' });
  }
  function commit() {
    if (seenCount === 0) {
      ask = {
        title: `一部都没选，这 ${queue.length} 部都记为「没看过」？`,
        body: '之后可以用「重置队列」找回来。',
        label: '提交',
        run: submitBatch
      };
      return;
    }
    submitBatch();
  }
  const undo = async () => {
    const r = await run(() => triage.undo(scope));
    if (r && sessionBatches.length) session = Math.max(0, session - sessionBatches.pop());
    // 说清「一批 = 一整屏」：勾过的和没勾的都算判定，都会回队列
    if (r) toast.ok(r.seen
      ? `已撤销上一批 ${r.undone} 部（含标为看过的 ${r.seen} 部），全部回到队列`
      : `已撤销上一批 ${r.undone} 部，全部回到队列`);
  };
  async function restoreNotSeen() {
    const r = await run(() => triage.resetNotSeen(scope));
    if (r) toast.ok(`${r.restored} 部已放回队列`);
  }
  const askReset = () => {
    ask = {
      title: data.year
        ? `把 ${data.year} 年记为「没看过」的 ${stats.notSeen} 部放回队列？`
        : `把记为「没看过」的 ${stats.notSeen} 部放回队列？`,
      body: `已标「看过」的 ${stats.seen} 部不受影响。`,
      label: '重置',
      run: restoreNotSeen
    };
  };

  /**
   * Enter = 下一批。只在焦点不在别的控件上时接管（页面本身 / 卡片 / 底栏）：
   * 输入框、链接、弹窗里的 Enter 照常。卡片按钮上的 Enter 原本是「勾选」，这里改成提交 ——
   * 勾选用点击 / 空格。
   */
  function onKey(e) {
    if (e.key !== 'Enter' || e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (ask || saving || !queue.length || !data.user) return;
    const t = /** @type {HTMLElement} */ (e.target);
    if (t !== document.body && !t.closest?.('[data-triage]')) return;
    e.preventDefault();
    commit();
  }

  /** 新一批错开 20ms 淡入上浮（首屏不播；减少动态效果时直接出现） */
  function enter(node, { i }) {
    if (media.reducedMotion) return { duration: 0 };
    return {
      delay: Math.min(i, 23) * 20, duration: 260, easing: cubicOut,
      css: (t) => `opacity:${t};transform:translateY(${(1 - t) * 10}px) scale(${0.97 + 0.03 * t})`
    };
  }
  import LoginGate from '$lib/ui/LoginGate.svelte';
</script>

<svelte:window onkeydown={onKey} />

<Confirm open={!!ask} title={ask?.title} body={ask?.body}
         confirmLabel={ask?.label} danger={ask?.danger}
         onconfirm={() => { const a = ask; ask = null; a?.run(); }}
         oncancel={() => (ask = null)} />

<Page>
{#if !data.user}
  <LoginGate title="快速标记" line="登录后开始标记看过的番" />
{:else}
  <!-- 「?」跟在标题后面，不再单独占一行。
       原来那行写着「勾选＝看过，没勾的记为「没看过」」—— 删了：底部操作栏的
       「标了 N 部看过 · 其余 M 部记为没看过」已经把同一件事说了，还带实时数字，
       而且就在「下一批」按钮旁边。操作后果要在按下按钮的地方说，不是页面顶端。 -->
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h1 class="flex items-center gap-2 text-xl font-semibold">
      快速标记
      <InfoTip label="规则">
        <ul class="list-disc space-y-1 pl-4 text-[12px] text-ink-400">
          <li>勾选＝看过；没勾的提交后记为「没看过」</li>
          <li>队列按知名度排序，已判定的作品不再出现</li>
          <li>集数与评分为选填</li>
          <li>判定仅作用于本队列，不影响目录与搜索</li>
          <li>一批 = 一整屏，勾过的和没勾的都算判定</li>
          <li>可用「撤销上一批」或「重置队列」回退</li>
        </ul>
      </InfoTip>
    </h1>
    <!-- 年份用目录页那个折叠胶囊，不再铺一长排；重置只留一个按钮 -->
    <div class="flex items-center gap-1.5">
      <YearPill years={years} year={data.year} to={href} label="年份"
                showSeason={false} showDecade={false} isDefault={data.year === null} />
      <ResetButton onclick={askReset} disabled={saving || !stats.notSeen} label="重置队列" />
    </div>
  </div>

  <!-- 总进度是这一页的主角：大号已判定 / 总量，渐变条尾端那一小段是眼前这一批 -->
  <section class="card relative mt-3 overflow-hidden rounded-2xl px-4 py-3.5 sm:px-6 sm:py-5">
    <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <div class="flex items-baseline gap-1.5 tabular-nums">
        <span class="sr-only">已判定</span>
        <span class="text-[30px] font-bold leading-none tracking-tight sm:text-[38px]">{fmt(stats.decided)}</span>
        <span class="text-[14px] text-ink-400 sm:text-[16px]">/ {fmt(stats.pool)}</span>
        <span class="ml-1 text-[14px] font-semibold text-accent-ink sm:text-[16px]">{pct.toFixed(1)}%</span>
      </div>
      <dl class="flex items-baseline gap-5 text-[12px] text-ink-400 tabular-nums max-sm:w-full max-sm:justify-between sm:gap-7">
        <div class="relative flex items-baseline gap-1.5">
          <dt>看过</dt>
          <dd class="text-[18px] font-bold leading-none text-accent">{fmt(tweenReady ? Math.round(seenShown.current) : stats.seen)}</dd>
          {#key bump?.k}
            {#if bump}<span class="bump pointer-events-none absolute -top-3 left-full ml-0.5 text-[12px] font-bold text-accent-ink"
                             aria-hidden="true">+{bump.n}</span>{/if}
          {/key}
        </div>
        <div class="flex items-baseline gap-1.5">
          <dt>待判定</dt>
          <dd class="text-[18px] font-bold leading-none text-ink-100">{fmt(stats.remaining)}</dd>
        </div>
        <div class="flex items-baseline gap-1.5">
          <dt>本次</dt>
          <dd class="text-[18px] font-bold leading-none {session ? 'text-warm' : 'text-ink-200'}">+{session}</dd>
        </div>
      </dl>
    </div>
    <div class="mt-3">
      <Progress current={stats.decided} total={stats.pool} extra={queue.length} variant="glow" h="h-2" />
    </div>
  </section>

  {#if !queue.length}
    <div class="mt-5">
      <EmptyState icon={Confetti} title="此范围已全部判定">
        <a href="/mine" class="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-on-accent transition hover:brightness-110">我的番单</a>
        {#if lastBatch}
          <button onclick={undo} disabled={saving}
                  class="rounded-lg border border-ink-600 bg-ink-900 px-3.5 py-2 text-[13px] text-ink-200 disabled:opacity-50">
            撤销上一批（{lastBatch.n}）
          </button>
        {/if}
      </EmptyState>
    </div>
  {:else}
    <div class="mt-4 grid gap-x-3.5 gap-y-5 {CARD_GRID}" data-triage>
      {#each queue as a, i (a.id)}
        {@const on = !!marks[a.id]}
        <!--
          flex flex-col 是必须的：<button> 的内容默认【垂直居中】，
          而网格行高由最高的那个格子（三行标题的那个）决定 —— 标题短的格子里
          封面就往下沉，一排封面的上边缘参差不齐。
          min-w-0：原图宽度会撑宽网格列（min-content），不加的话一排封面宽高也不齐。
        -->
        <button type="button" onclick={() => toggle(a.id)} aria-pressed={on}
                in:enter={{ i }}
                class="group flex min-w-0 flex-col text-left transition duration-200
                       {leaving && on ? 'scale-90 opacity-0' : ''}">
          <!-- 选中：保持原色，accent 描边 + 发光 + 上浮 3px（回弹）+ 右上实心 ✓；不再盖一层罩子（像禁用） -->
          <div class="tri-card relative overflow-hidden rounded-xl bg-ink-800
                      {on ? 'is-on -translate-y-[3px] ring-2 ring-accent'
                          : 'shadow-md shadow-black/30 ring-1 ring-white/5 group-hover:-translate-y-0.5'}">
            <Cover {a} cls="aspect-2/3" />
            {#if a.bgm_score != null && (a.bgm_votes ?? 0) >= 100}
              <div class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end bg-gradient-to-t from-black/75 to-transparent px-1.5 pb-1.5 pt-6">
                <span class="text-[12px] font-semibold text-white drop-shadow">★ {a.bgm_score.toFixed(1)}</span>
              </div>
            {/if}
            <div class="tri-check pointer-events-none absolute right-1.5 top-1.5 grid size-[26px] place-items-center rounded-full
                        {on ? 'bg-accent text-on-accent shadow-[0_2px_8px_rgb(0_0_0/0.45)]'
                            : 'border-2 border-white/90 bg-black/25 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-70'}"
                 aria-hidden="true">
              {#if on}<Check size={15} weight="bold" />{/if}
            </div>
          </div>
          <!-- 不截断：标题是判断「看过没看过」的唯一依据，截成「第…」等于没有 -->
          <div class="mt-2 break-words px-0.5 text-[13px] font-medium leading-snug transition-colors
                      {on ? 'text-accent-ink' : 'text-ink-200 group-hover:text-accent'}">{dispTitle(a)}</div>
          <div class="mt-0.5 px-0.5 text-[11px] text-ink-400">{a.year ?? '—'} · {a.episodes ?? '?'} 集</div>
        </button>
      {/each}
    </div>

    <div class="sticky bottom-[calc(1rem+var(--tabbar-h,0px)+env(safe-area-inset-bottom))] mt-5" data-triage>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2.5 rounded-2xl border border-ink-600 bg-ink-800/95 p-3 shadow-lift backdrop-blur">
        <div class="min-w-0 flex-1 basis-56">
          <div class="text-[13px] text-ink-200">
            标了 <b class="text-accent">{seenCount}</b> 部看过
            <span class="text-ink-400">· 其余 {queue.length - seenCount} 部记为没看过</span>
          </div>
          <!-- 这一批每部一格，勾一张亮一格 -->
          <div class="mt-2 flex flex-wrap gap-1" aria-hidden="true">
            {#each queue as a (a.id)}
              <i class="block size-1.5 rounded-full transition-colors duration-150
                        {marks[a.id] ? 'bg-accent shadow-[0_0_6px_var(--c-accent)]' : 'bg-ink-600'}"></i>
            {/each}
          </div>
        </div>
        <!-- 两个按钮同高（原来撤销 37px、下一批 40px，并排时底边不齐） -->
        <div class="flex shrink-0 gap-2 max-sm:w-full">
          {#if lastBatch}
            <button onclick={undo} disabled={saving}
                    class="h-11 shrink-0 rounded-xl border border-ink-600 bg-ink-900 px-4 text-[13px] text-ink-200
                           transition hover:border-ink-400 active:scale-95 disabled:opacity-50 max-sm:flex-1">撤销上一批</button>
          {/if}
          <button onclick={commit} disabled={saving}
                  class="flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold transition
                         active:scale-95 disabled:opacity-50 max-sm:flex-[2]
                         {seenCount ? 'bg-accent text-on-accent shadow-[0_6px_18px_-6px_var(--c-accent)] hover:brightness-110'
                                    : 'border border-ink-600 bg-ink-900 text-ink-200 hover:border-ink-400'}">
            {saving ? '保存中…' : '下一批 →'}
            <kbd class="rounded border px-1 py-px font-sans text-[10.5px] font-medium leading-tight max-sm:hidden
                        {seenCount ? 'border-on-accent/40 bg-on-accent/10 text-on-accent' : 'border-ink-600 bg-ink-800 text-ink-400'}">Enter</kbd>
          </button>
        </div>
      </div>
    </div>
  {/if}
{/if}
</Page>

<style>
  /* 选中的回弹：稍微冲过头再落回（只作用在位移 / 阴影上，颜色照常） */
  .tri-card {
    transition: transform 320ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 200ms ease-out;
  }
  .tri-card.is-on {
    box-shadow: 0 0 0 2px var(--c-accent), 0 12px 28px -8px color-mix(in srgb, var(--c-accent) 70%, transparent);
  }
  .tri-check { transition: opacity 150ms ease-out, transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1); }
  .is-on .tri-check { animation: tick 260ms cubic-bezier(0.34, 1.56, 0.64, 1); }
  @keyframes tick { from { transform: scale(0.4); } to { transform: scale(1); } }

  /* +N：往上飘一点再消失 */
  .bump { animation: bump 1100ms ease-out forwards; }
  @keyframes bump {
    0% { opacity: 0; transform: translateY(6px) scale(0.8); }
    15% { opacity: 1; transform: translateY(0) scale(1.1); }
    30% { transform: translateY(-2px) scale(1); }
    100% { opacity: 0; transform: translateY(-10px); }
  }
</style>
