<script>
  /**
   * 观看页：进来就自动搜片源 → 选中最像「这一季」的那条 → 接着上次的进度开播。
   *
   * 原来详情页里是「输入框 → 搜索 → 五行结果里挑一条 → 选线路 → 选集 → 解析失败再点原站打开」，每次都从头点一遍（2026-10-18）。现在：
   *   · 每部番记住上次的站 / 线路（watch_pick），找不回来才按打分自动选
   *   · 同分的站按历史上解析出直链的比例排；自动选的那条只能跳转时，往下试同样匹配的其他站
   *   · 站内播放到 90% 记进度；只能跳转的站，点开那一集就记
   */
  import { untrack } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { toast } from '$lib/toast.svelte.js';
  import { entry } from '$lib/api.js';
  import { dispTitle } from '$lib/format.js';
  import { takeShot } from '$lib/shot.js';
  import { watchUrl } from '$lib/watchSite.js';
  import { WATCH_AUTO_PICK } from '$lib/constants.js';
  import { epNo, indexOfEp, loadQuality, saveQuality } from './watchUtil.js';
  import { startEp } from '$lib/nextEp.js';
  import { epTitle } from '$lib/format.js';
  import Page from '$lib/ui/Page.svelte';
  import CoverBackdrop from '$lib/ui/CoverBackdrop.svelte';
  import StageStatus from './StageStatus.svelte';
  import Player from '$lib/ui/Player.svelte';
  import Confirm from '$lib/ui/Confirm.svelte';
  import BackLink from '$lib/ui/BackLink.svelte';
  import EpisodePicker from '$lib/ui/EpisodePicker.svelte';
  import SourcePanel from '$lib/ui/SourcePanel.svelte';
  let { data } = $props();

  /**
   * 「← 详情」不能是普通链接：详情 → 观看 → 点链接回详情，历史里就是「目录 → 详情 → 观看 → 详情」，
   * 详情页的「← 返回」是 history.back()，于是退回观看页（主人 2026-10-18 报的）。
   * 从详情页进来的就后退一步；直接打开观看页的（收藏、刷新）替换掉当前这条，不往历史里多压一层。
   */
  let fromDetail = false;
  afterNavigate(({ from }) => { fromDetail = from?.url.pathname === `/anime/${data.a.id}`; });
  function backToDetail(e) {
    e.preventDefault();
    if (fromDetail) history.back(); else goto(`/anime/${a.id}`, { replaceState: true });
  }

  const a = $derived(data.a);
  /** 自动试几个站：每个要多一次取剧集 + 一次解析，再多就等太久了 */
  const AUTO_TRIES = 3;

  let q = $state('');
  let searching = $state(true);         // 进页面就搜，首屏直接是「搜索片源」
  let results = $state(null);          // [{ site, hits: [{ name, url, score }] }]
  let pick = $state(null);             // { site, name, url }
  let roads = $state([]);
  let road = $state(0);
  let loadingEps = $state(false);
  /** failed = 这个站确认只能跳转；error = 这一集这次没加载出来（慢、超时、列表 502），给「重新加载」 */
  let cur = $state(null);              // { i, n, name, page, src, failed, error, marked }
  let showPicker = $state(false);
  let progress = $state(0);
  /**
   * 这次会话里已知只能跳转的站：它的选集直接是原站链接，不再先解析一遍。
   * 一次失败不算（#90：加载慢、超时、列表一次 502 都会失败一次，原来就整站变成跳转）——
   * 同一个站这次会话里解析失败两次才算
   */
  let jumpOnly = $state({});
  const misses = {};

  /**
   * 作废旧请求（2026-10-21 审核）：同一个组件在两部番之间导航时，上一部的搜索结果、自动选源后的 playAt 会落到新番上；
   * 连点几集时旧的解析也还在服务端排队嗅探。run = 这一部番的请求，play = 当前这一集的解析；每个 await 之后看 aborted
   */
  let run = new AbortController(), play = null;
  const api = (params, signal) => fetch(`/api/sources?${new URLSearchParams(params)}`, { signal }).then((r) => r.json());
  const found = $derived((results ?? []).filter((r) => r.hits.length));
  const eps = $derived(roads[road]?.eps ?? []);
  const watchLinks = $derived(
    (data.watchSites ?? []).map((w) => ({ id: w.id, name: w.name, url: watchUrl(w.url, a) })).filter((w) => w.url)
  );

  /** 从哪一集开始：?ep=N 优先，其余和详情页按钮同一套（$lib/nextEp.js；追平时停在最新一集，#7） */
  const askedEp = +(page.url.searchParams.get('ep') ?? 0) || 0;
  const startIndex = (list) => indexOfEp(list, startEp({ asked: askedEp, status: a.my_status, current: progress,
    total: data.aired?.total ?? a.episodes, aired: data.aired?.aired ?? null, has: (n) => list.some((ep, k) => epNo(ep, k) === n) }));

  $effect(() => {
    a.id;
    untrack(() => {
      run = new AbortController();
      progress = a.current_episode ?? 0;
      q = a.title_cn || a.title_ja || a.title || '';
      results = null; pick = null; roads = []; cur = null; showPicker = false; loadingEps = false;
      start(run.signal);
    });
    return () => { run.abort(); play?.abort(); };   // 换番前、离开页面时
  });

  /** expand：自动搜索时让服务端多用几个关键词（手动在「换片源」里输入的就只搜那一个） */
  async function search(expand = false) {
    const sig = run.signal; searching = true;
    try {
      const r = await api({ op: 'search', q: q.trim(), id: a.id, ...(expand ? { expand: 1 } : {}) }, sig);
      if (sig.aborted) return false;
      if (r.error) { toast.error(r.error); return false; }
      results = r.results;
      return true;
    } catch (e) { if (!sig.aborted) toast.error(e); return false; } finally { if (!sig.aborted) searching = false; }
  }

  /** 只能跳转的站：这次会话里解析失败过，或历史战绩里基本解析不出直链 */
  const isJump = (r) => jumpOnly[r.site] || (r.embed != null && r.embed < 0.2);

  /** 候选顺序：记住的那条 → 分数高的 → 同分时站内可播比例高的；分数不够门槛的不自动选 */
  function candidates() {
    const all = found.flatMap((r) => r.hits.map((h) => ({ site: r.site, hit: h, embed: r.embed ?? 0.5 })));
    const mem = data.pick;
    const remembered = mem && all.find((c) => c.site === mem.site && c.hit.name === mem.name);
    const ranked = all.filter((c) => c.hit.score >= WATCH_AUTO_PICK && c !== remembered)
      .sort((x, y) => y.hit.score - x.hit.score || y.embed - x.embed);
    // 同一个站只试分数最高的那条
    const seen = new Set();
    const uniq = ranked.filter((c) => !seen.has(c.site) && seen.add(c.site));
    return { remembered, list: remembered ? [remembered, ...uniq] : uniq };
  }

  async function start(sig) {
    if (!q.trim()) { searching = false; return; }
    if (!(await search(true)) || sig.aborted) return;
    const { remembered, list } = candidates();
    if (!list.length) { showPicker = true; return; }
    let fallback = null;
    for (const c of list.slice(0, AUTO_TRIES)) {
      if (!(await choose(c.site, c.hit, { auto: true }))) { if (sig.aborted) return; continue; }
      const ok = await playAt(startIndex(eps));
      if (sig.aborted) return;
      // 手动选过的那条就算只能跳转也用它；自动兜底记下的只能跳转的站不粘住 ——
      // 转生就是剑 第二季 当初只搜得到 baimao，记住它之后 akianime 搜得到了也轮不上
      const sticky = c === remembered && !!data.pick?.manual;
      if (ok || sticky) { manual = sticky; return save(); }
      fallback ??= c;
    }
    if (fallback) {
      await choose(fallback.site, fallback.hit, { auto: true }); if (sig.aborted) return;
      await playAt(startIndex(eps)); if (sig.aborted) return;
      manual = false; save();
    } else {
      // 候选全都取不到剧集：别把最后试过的那个站留在页头和片源栏上（Chidori 显示「片源 baimao」却没东西播）
      pick = null; roads = []; cur = null; showPicker = true;
    }
  }

  async function choose(site, hit, { auto = false } = {}) {
    const sig = run.signal; play?.abort();
    pick = { site, name: hit.name, url: hit.url }; roads = []; cur = null; loadingEps = true;
    const mem = data.pick;
    try {
      const r = await api({ op: 'episodes', site, url: hit.url }, sig);
      if (sig.aborted) return false;
      if (r.error) { if (!auto) toast.error(r.error); return false; }
      roads = r.roads ?? [];
      road = mem && mem.site === site && mem.name === hit.name && mem.road < roads.length ? mem.road : 0;
      return roads.length > 0;
    } catch (e) { if (!auto && !sig.aborted) toast.error(e); return false; } finally { if (!sig.aborted) loadingEps = false; }
  }

  /** 手动换片源也停在当前这一集（和换线路同理，#94） */
  async function pickManually(site, hit) {
    showPicker = false;
    const n = cur?.n;
    if (await choose(site, hit)) { manual = true; save(); await playAt(n ? indexOfEp(eps, n) : startIndex(eps)); }
  }

  /** 当前片源是不是主人在「换片源」里手动选的（手动的才一直沿用，见 start） */
  let manual = false;
  function save() {
    if (!pick) return;
    fetch('/api/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'pick', id: a.id, site: pick.site, name: pick.name, road, manual }) }).catch(() => {});
  }

  /** 换线路停在当前这一集（#94：原来跳回「进度的下一集」，看第 7 集换线路变成第 5 集） */
  function setRoad(i) {
    const n = cur?.n;
    road = i; cur = null; save();
    playAt(n ? indexOfEp(eps, n) : startIndex(eps));
  }

  /**
   * 服务端只认一小时内发出去过的链接，服务器重启后也全部作废（#91）：开着页面看完两三集再点下一集，
   * 解析就回「链接已过期」。这不是这个站的问题 —— 后台重搜一遍、重取剧集，同一集再解析一次
   */
  async function relink(sig) {
    const site = pick?.site, name = pick?.name, n = cur?.n;
    const r = await api({ op: 'search', q: q.trim(), id: a.id, expand: 1 }, sig).catch(() => null);
    if (!r?.results || sig.aborted || pick?.site !== site) return null;
    results = r.results;
    const hit = r.results.find((x) => x.site === site)?.hits.find((h) => h.name === name);
    if (!hit) return null;
    const e = await api({ op: 'episodes', site, url: hit.url }, sig).catch(() => null);
    if (!e?.roads?.length || sig.aborted || pick?.site !== site) return null;
    pick = { site, name, url: hit.url };
    roads = e.roads; if (road >= roads.length) road = 0;
    const i = indexOfEp(eps, n);
    return eps[i] ? { ep: eps[i], i } : null;
  }

  /** @returns 能否站内播放 */
  async function playAt(i, { fresh = false } = {}) {
    let ep = eps[i];
    if (!ep) return false;
    play?.abort();                   // 上一集还在解析：取消掉，服务端那边排队中的嗅探跟着出队
    const sig = (play = new AbortController()).signal;
    // 先赋值再取回：$state 存的是代理，拿原对象和 cur 比永远不相等
    cur = { i, n: epNo(ep, i), name: ep.name, page: ep.url, src: null, failed: false, error: false, marked: false };
    const mine = cur;
    if (jumpOnly[pick.site]) { mine.failed = true; return false; }
    let r = null;
    try {
      r = await api({ op: 'resolve', site: pick.site, url: ep.url, ...(fresh ? { fresh: 1 } : {}) }, sig);
      if (cur !== mine) return false;
      if (!r.url && /过期/.test(r.error ?? '')) {
        const again = await relink(sig);
        if (cur !== mine) return false;
        if (again) { ep = again.ep; mine.i = again.i; mine.page = ep.url; r = await api({ op: 'resolve', site: pick.site, url: ep.url }, sig); }
        if (cur !== mine) return false;
      }
      if (r.url) { mine.srSrc = r.srUrl ?? null; mine.src = r.url; return true; }
    } catch { /* 网络错误：当作这次没加载出来 */ }
    if (cur !== mine || sig.aborted) return false;   // 被取消的不算失败，也不弹错
    // 「没找到直链」连续两次才认定这个站只能跳转；超时、过期、网络错误只给「重新加载」
    const noDirect = /没找到/.test(r?.error ?? '');
    if (noDirect && (misses[pick.site] = (misses[pick.site] ?? 0) + 1) >= 2) { mine.failed = true; jumpOnly[pick.site] = true; }
    else mine.error = true;
    return false;
  }
  /** 「重新加载」：同一集跳过服务端的解析缓存再来一次 */
  const retry = () => { if (cur) playAt(cur.i, { fresh: true }); };

  async function markWatched(n) {
    // 访客看番不记进度 —— 播到 90% 时弹登录框会打断观看（要记就先登录）
    if (!data.user || progress >= n) return;
    const total = a.episodes > 0 ? a.episodes : null;
    const patch = { current_episode: n };
    if (total && n >= total) patch.status = 'completed';
    else if (!a.my_status || a.my_status === 'plan') patch.status = 'watching';
    try {
      await entry.patch(a.id, patch);
      progress = n;
      toast.ok(`已记到第 ${n} 集`);
    } catch (e) { toast.error(e); }
  }

  /**
   * 右上角爱心 = 标记「在看」；再点一下取消（移出番单）—— 有进度 / 评分 / 短评时先确认，和详情页同一条规矩
   */
  let myStatus = $state(null);
  $effect(() => { myStatus = a.my_status ?? null; });
  let asking = $state(false);
  async function like() {
    // 全屏时登录框会被盖在全屏画面后面看不见：访客点爱心先退出全屏
    if (!data.user && document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    if (myStatus === 'watching') {
      if (progress > 0 || a.my_score != null || a.my_note) { asking = true; return; }
      return unlike();
    }
    try { await entry.patch(a.id, { status: 'watching' }); myStatus = 'watching'; toast.ok('已加入在看'); }
    catch (e) { toast.error(e); }
  }
  async function unlike() {
    asking = false;
    try { await entry.clear(a.id); myStatus = null; progress = 0; toast.ok('已移出番单'); } catch (e) { toast.error(e); }
  }

  /** 截图（见 lib/shot.js）：管理员存到服务器那台电脑，其他人下载到自己设备 */
  const shot = (blob, t) => takeShot({ blob, t, animeId: a.id, ep: cur?.n ?? null, title: dispTitle(a),
                                       mp4Src: cur?.srSrc, admin: data.user?.role === 'admin' });

  /** 播到 90% 记进度 */
  function onProgress(pct) {
    const c = cur;
    if (!c || c.marked || pct < 0.9) return;
    c.marked = true;
    markWatched(c.n);
  }
  const hasPrev = $derived(!!cur && cur.i > 0);
  const hasNext = $derived(!!cur && cur.i < eps.length - 1);
  const go = (d) => { if (cur) playAt(cur.i + d); };

  /** 各站实际清晰度：播过一次就记下 videoHeight（1080 → 「1080p」），换片源时一眼看出哪家清楚（存本机，见 watchUtil.js） */
  let quality = $state({});
  $effect(() => { quality = loadQuality(); });
  function onMeta(h) { if (pick && h) saveQuality(quality = { ...quality, [pick.site]: h }); }
  /** 片源站给的名字和这部番同名（忽略空格 / 标点）就不再写一遍 */
  const sameName = (x) => { const k = (t) => String(t ?? '').replace(/[\s\p{P}]/gu, ''); return k(x) === k(dispTitle(a)); };

  /** 播放区现在是什么状态：阶段词（转圈）/ 失败 / 没片源；播放器已挂上时只管「解析中」 */
  const phase = $derived(searching ? '搜索片源' : loadingEps ? '加载剧集' : cur && !cur.src && !cur.failed && !cur.error ? '解析中' : null);
  const kind = $derived(cur?.error ? 'error' : cur?.failed ? 'failed' : !cur && results ? (found.length ? 'nomatch' : 'none') : null);
  /** 本集标题（Bangumi 分集数据，按集号对上） */
  const curTitle = $derived(cur ? epTitle(data.episodes?.find((e) => e.n === cur.n)) : '');

  /**
   * 给框架的标记：<html data-watch>（在观看页）、<html data-watch-immersive>（手机横屏，播放器铺满整屏）。
   * 框架据此在横屏时藏起底部标签栏；播放器本身靠下面 <style> 里同一条媒体查询铺满
   */
  const IMMERSIVE = '(orientation: landscape) and (max-height: 500px)';
  let immersive = $state(false);   // 给播放器：横屏铺满时顶栏留返回键 + 番名（宽 ≥640 命中 sm:，原来返回键被藏掉、无路可退）
  $effect(() => {
    const el = document.documentElement, mq = matchMedia(IMMERSIVE);
    const on = () => { immersive = mq.matches; el.toggleAttribute('data-watch-immersive', mq.matches); };
    el.setAttribute('data-watch', ''); on(); mq.addEventListener('change', on);
    return () => { mq.removeEventListener('change', on); el.removeAttribute('data-watch'); el.removeAttribute('data-watch-immersive'); };
  });
</script>

<!-- 拉片源时不带来源页：7sefun 的视频在腾讯 CDN 上，带着本站地址当 Referer 就 404（防盗链），不带才 206。
     <video> / hls.js 的请求都跟着文档的 referrer 策略走，所以在观看页这一层设 -->
<svelte:head><meta name="referrer" content="no-referrer" /></svelte:head>

<Confirm open={asking} danger title="取消在看？" body="会移出番单，进度 / 评分 / 短评一起删除" confirmLabel="移出番单"
         onconfirm={unlike} oncancel={() => (asking = false)} />

{#snippet resolving()}<StageStatus {a} n={cur?.n} phase="解析中" />{/snippet}

<!-- 影院氛围：播放区背后铺一层模糊封面，往下渐隐进页面。铺在 Page 外面，宽屏两侧不会切出硬边 -->
<div class="relative" class:cover-tint={data.tint} style={data.tint?.style} data-tint-light={data.tint?.light ? '' : undefined}>
  <!-- 氛围层单独 isolate、沉到 -z-10：外层不能 isolate，否则手机吸顶的播放器（z-45）压不过顶栏 -->
  <div class="ambient pointer-events-none absolute inset-x-0 top-0 -z-10 isolate h-[820px]"><CoverBackdrop {a} blur={90} saturate={1.5} fadeFrom={30} position="50% 30%" /></div>
  <Page cls="max-sm:pt-0">
    <!-- 返回键和详情页同一位置：内容区左上角、播放器上方（#1，原来夹在播放器和标题中间）；手机在播放器左上角（onback） -->
    <div class="mb-5 max-sm:hidden"><BackLink href="/anime/{a.id}" onclick={backToDetail}>详情</BackLink></div>
    <!-- 桌面：左列 播放器 / 标题 / 片源，右列选集（和播放器齐高，集数多时自己滚）；手机：播放器吸顶，下面依次是标题、选集、片源 -->
    <div class="lg:grid lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-x-5 xl:grid-cols-[minmax(0,1fr)_21rem]">
      <div class="stage relative aspect-video overflow-hidden bg-black max-sm:sticky max-sm:top-0 max-sm:z-[45] max-sm:-mx-4 sm:rounded-2xl lg:col-start-1 lg:self-start">
        {#if cur && !cur.failed && !cur.error}
          <!-- 播放出错（hls 致命错误、video error）只算这一次没加载出来，给「重新加载」，不判这个站只能跳转（#90） -->
          <Player src={cur.src} srSrc={cur.srSrc} title={dispTitle(a)} epLabel="第 {cur.n} 集" httpsUrl={data.httpsUrl}
                  liked={myStatus === 'watching'} onlike={like} onshot={shot} onback={backToDetail} pending={resolving} {immersive}
                  {hasPrev} {hasNext} onprev={() => go(-1)} onnext={() => go(1)}
                  onprogress={onProgress} onmeta={onMeta} onfail={() => { if (cur) cur.error = true; }} />
        {:else}
          <StageStatus {a} n={cur?.n} site={pick?.site} {phase} {kind} page={cur?.page} onback={backToDetail} {immersive}
                       onretry={retry} onopen={() => markWatched(cur.n)}
                       onunjump={() => { if (pick) { delete misses[pick.site]; jumpOnly[pick.site] = false; } retry(); }} />
        {/if}
      </div>

      <!-- 标题在播放器下面（YouTube / B 站式）：番名 + 一行「第 5 集 · 本集标题 · 已看到第 4 集」 -->
      <div class="mt-4 min-w-0 sm:mt-5 lg:col-start-1">
        <h1 class="text-lg font-semibold leading-snug tracking-tight text-ink-100 sm:text-[22px]">{dispTitle(a)}</h1>
        <p data-ep={cur?.n ?? ''} class="mt-1.5 text-[13px] text-ink-200">
          {#if cur}<span class="font-medium text-ink-100">第 {cur.n} 集</span>{#if curTitle}{' · ' + curTitle}{/if}{/if}{#if progress}<span class="text-ink-400">{cur ? ' · ' : ''}已看到第 {progress} 集</span>{/if}
        </p>
      </div>

      <aside class="glass-aside mt-6 flex min-h-0 flex-col lg:col-start-2 lg:row-start-1 lg:mt-0 lg:h-0 lg:min-h-full lg:rounded-2xl lg:p-2.5">
        <EpisodePicker {eps} info={data.episodes} {epNo} {roads} {road} onroad={setRoad} curI={cur?.i ?? null} {progress} jump={!!jumpOnly[pick?.site]}
                       loading={searching || loadingEps}
                       onplay={(i) => playAt(i)}
                       onjump={(i, n, ep) => { cur = { i, n, name: ep.name, page: ep.url, src: null, failed: true, marked: true }; markWatched(n); }} />
        {#if !eps.length && !searching && !loadingEps}<p class="px-1.5 py-3 text-[12px] text-ink-400">还没有选中片源</p>{/if}
      </aside>

      <div class="mt-6 lg:col-start-1">
        <SourcePanel {watchLinks} {results} {pick} {cur} {quality} {searching} {isJump} {sameName}
                     bind:q bind:open={showPicker} onsearch={() => search()} onpick={pickManually} />
      </div>
    </div>
    <div class="h-6"></div>
  </Page>
</div>

<style>
  /* 氛围光：深色 .35 / 浅色 .15（覆盖主题的氛围透明度基准） */
  .ambient { --c-backdrop-opacity: 0.35; }
  :global(:root[data-theme='light']) .ambient { --c-backdrop-opacity: 0.15; }
  /* 播放器：深投影 + 1px 白 6% 描边 */
  .stage { box-shadow: 0 28px 70px -24px rgb(0 0 0 / 0.75), 0 0 0 1px rgb(255 255 255 / 0.06); }
  :global(:root[data-theme='light']) .stage { box-shadow: 0 24px 56px -22px rgb(16 20 28 / 0.5), 0 0 0 1px rgb(16 20 28 / 0.06); }
  @media (max-width: 639px) { .stage { box-shadow: none; } }
  /* 选集侧栏（桌面）：半透明 + 磨砂，叠在氛围光上 */
  @media (min-width: 1024px) {
    .glass-aside {
      background: color-mix(in srgb, var(--c-surface) 58%, transparent);
      border: 1px solid color-mix(in srgb, var(--c-border) 70%, transparent);
      box-shadow: var(--c-shadow);
      -webkit-backdrop-filter: blur(20px) saturate(1.3);
      backdrop-filter: blur(20px) saturate(1.3);
    }
  }
  /* 手机横屏：播放器铺满整屏（盖住顶栏、标题和底部标签栏），竖回来恢复 */
  @media (orientation: landscape) and (max-height: 500px) {
    .stage { position: fixed; inset: 0; z-index: 90; margin: 0; aspect-ratio: auto; border-radius: 0; box-shadow: none; }
    :global(html[data-watch-immersive]) { overflow: hidden; }
  }
</style>
