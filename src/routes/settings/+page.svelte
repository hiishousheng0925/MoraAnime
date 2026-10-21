<script>
  import Group from '$lib/ui/SettingsGroup.svelte';
  import { PRIMARY, SECONDARY, ROW, INPUT } from '$lib/ui/btn.js';
  import InfoTip from '$lib/ui/InfoTip.svelte';
  import { toast } from '$lib/toast.svelte.js';
  import ThemeToggle from '$lib/ui/ThemeToggle.svelte';
  import { invalidateAll } from '$app/navigation';
  import Page from '$lib/ui/Page.svelte';
  import RangeSlider from '$lib/ui/RangeSlider.svelte';
  import WatchSites from '$lib/ui/WatchSites.svelte';
  import BackupCard from '$lib/ui/BackupCard.svelte';
  import AccountCard from '$lib/ui/AccountCard.svelte';
  import SignupAllow from '$lib/ui/SignupAllow.svelte';
  import { requireLogin } from '$lib/auth.svelte.js';
  import { post } from '$lib/api.js';
  let { data } = $props();
  const user = $derived(data.user);
  const admin = $derived(data.user?.role === 'admin');

  let busy = $state(false);

  /**
   * 失败返回 null 并 toast —— 原来裸 fetch 不看结果，存年份出错会弹「只显示 undefined–undefined 年」。
   * 成功失败都 invalidateAll：失败时开关 / 滑块也要回到库里的真实值。
   */
  async function api(url, body) {
    busy = true;
    try { return await post(url, body); }
    catch (e) { toast.error(e); return null; }
    finally { busy = false; await invalidateAll(); }
  }

  const toggleNsfw = (v) => api('/api/settings', { key: 'hide_nsfw', value: v });

  /**
   * 显示年份窗口。库里存 1950–2050 的全部数据，这里只决定界面显示哪一段。
   * 控件是一根轨道两个滑块（ui/RangeSlider.svelte）—— 起点不可能超过终点，
   * 用两条独立滑块反而要用户自己保证这件事。
   */
  let yMin = $state(data.yearWin.min);
  let yMax = $state(data.yearWin.max);
  // 保存后 loader 会回传新值，本地状态要跟上（否则拖完再刷新会跳回旧值）
  $effect(() => { yMin = data.yearWin.min; yMax = data.yearWin.max; });
  const dirty = $derived(yMin !== data.yearWin.min || yMax !== data.yearWin.max);
  async function saveYears() {
    const r = await api('/api/settings', { key: 'year_window', min: yMin, max: yMax });
    if (r) toast.ok(`只显示 ${r.min}–${r.max} 年的内容`);
  }
  const delFilter = (id) => api('/api/filters', { op: 'del', id });

  async function share(op) {
    const r = await api('/api/share', { op });
    if (r) toast.ok(r.token ? '分享链接已更新' : '分享链接已撤销');
  }

  /** 截图保存位置（观看页右上角的相机）：服务端写盘，所以是这台电脑上的绝对路径 */
  let shotDir = $state('');
  $effect(() => { shotDir = data.shotDir; });
  async function saveShotDir(v) {
    const r = await api('/api/settings', { key: 'screenshot_dir', value: v });
    if (r) toast.ok(`截图保存到 ${r.value}`);
  }

  /**
   * 左侧目录（桌面）：设置项一多，滚来滚去找不到。分「个人」「站点管理」两组（组标题是结构不是说明）。
   * 多账号后按身份显示：个人的（账号 / 备份 / 分享 / 筛选）要登录；
   * 动的是服务器或全站的（截图位置 / 观看站 / 注册白名单）只有管理员看得到。
   * 桌面客户端（data.desktop，单机单用户）：没有账号 / 注册 / 分享（链接指向本机 127.0.0.1，发给别人打不开）
   */
  const desk = $derived(!!data.desktop);
  const TOC = $derived([
    ['个人', [['account', '账号', !desk], ['backup', '备份与恢复', !!user], ['look', '外观', true], ['years', '显示年份', true],
              ['filter', '内容过滤', true], ['share', '分享番单', !!user && !desk], ['saved', '保存的筛选', !!user && data.filters.length > 0]]],
    [desk ? '其他' : admin ? '站点管理' : '站点', [['members', '注册白名单', admin && !desk], ['shots', '截图', admin], ['sites', '观看站', admin],
              ['stats', '数据', true], ['sources', '数据来源', true]]]
  ].map(([g, xs]) => [g, xs.filter((x) => x[2])]));

  /**
   * 目录高亮当前区块：IntersectionObserver 看哪些区块落在「顶栏下 → 视口 45%」这条带里，取最上面那个。
   * 滚到底时最后几个短区块进不了那条带，单独认成最后一个。
   */
  let curSec = $state('account');
  $effect(() => {
    TOC;
    const els = [...document.querySelectorAll('[data-sec]')];
    const vis = new Map();
    const pick = () => {
      if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) { curSec = els.at(-1)?.id ?? curSec; return; }
      const first = els.find((el) => vis.get(el.id));
      if (first) curSec = first.id;
    };
    const io = new IntersectionObserver((es) => { for (const e of es) vis.set(e.target.id, e.isIntersecting); pick(); },
                                        { rootMargin: '-72px 0px -55% 0px' });
    els.forEach((el) => io.observe(el));
    addEventListener('scroll', pick, { passive: true });
    return () => { io.disconnect(); removeEventListener('scroll', pick); };
  });

  // bgm_ingest 原来也叫「Bangumi 数据」，和上面那行导出包日期同名，一屏四行「Bangumi 数据」（#110）
  const KIND_CN = { sync_all: '整轮同步', bgm_ingest: 'Bangumi 匹配', aod_ingest: '元数据', aod_ingest_incr: '新番', fix_status: '状态修正',
                    bgm_enrich: '中文名', bgm_calendar: '放送表', bgm_episodes: '分集',
                    mark_nsfw: '内容分级', franchise: '系列分组' };
  const latestSyncs = $derived(data.syncs.filter((s, i, all) => all.findIndex((x) => x.kind === s.kind) === i).slice(0, 6));
  const STATS = $derived([
    ['番剧条目', data.counts.anime], ['已补中文名', data.counts.cn], ['中文名待补', data.counts.cnPending],
    ['已缓存封面', data.counts.covers], ['封面死链', data.counts.dead], ['放送表', data.counts.weekday],
    ...(user ? [['我的番单', data.counts.entries], ['操作日志', data.counts.logs]] : [])
  ]);
</script>

<Page>
  <!--
    标题和左侧目录是同一列、一起吸顶（2026-10-21，主人：「设置」两字跟着滚有点怪）。
    原来标题在网格外、只有目录吸顶：一滚，标题走了、目录还钉着，左栏变成一串没头的链接，
    而它和内容区的上沿也对不齐。现在整列一起停在原位（top = 顶栏 --hdr-h + Page 的 py-5 20px，
    所以开始滚的那一下也不会跳），macOS 系统设置 / GitHub 设置页都是这个结构。
    手机上没有目录，标题照常在内容顶部、随页面滚走（和其他页一致）。
  -->
  <div class="lg:grid lg:grid-cols-[11rem_minmax(0,46rem)] lg:gap-10">
  <div class="self-start lg:sticky lg:top-[calc(var(--hdr-h)+20px)] lg:max-h-[calc(100dvh-var(--hdr-h)-20px)] lg:overflow-y-auto lg:pb-6">
    <h1 class="text-xl font-semibold lg:px-3 lg:pt-0.5 lg:text-[22px] lg:leading-7">设置</h1>
    <nav class="mt-5 hidden lg:block" aria-label="设置目录">
      {#each TOC as [g, xs] (g)}
        <div class="px-3 pb-1.5 pt-4 text-[11px] font-medium tracking-[0.08em] text-ink-400 first:pt-0">{g}</div>
        {#each xs as [id, label] (id)}
          <a href="#{id}" onclick={() => (curSec = id)} class:is-current={curSec === id} aria-current={curSec === id ? 'true' : undefined}
             class="block rounded-lg px-3 py-1.5 text-[13px] transition {curSec === id ? '' : 'text-ink-400 hover:bg-ink-800 hover:text-ink-200'}">{label}</a>
        {/each}
      {/each}
    </nav>
  </div>

  <div class="mt-5 space-y-7 lg:mt-0">
    <!-- ── 个人 ── -->
    <!-- 账号（多账号，2026-10-19）；桌面客户端没有 -->
    {#if !desk}
    <Group id="account" title="账号">
      {#if user}
        <AccountCard {user} sessions={data.sessions} />
      {:else}
        <div class={ROW}>
          <span class="text-[13px] text-ink-400">未登录</span>
          <button onclick={() => requireLogin()} class={PRIMARY}>登录</button>
        </div>
      {/if}
    </Group>
    {/if}

    {#if user}
      <Group id="backup" title="备份与恢复"><BackupCard total={data.stats?.total ?? 0} /></Group>
    {/if}

    <Group id="look" title="外观">
      <div class={ROW}>
        <span class="text-[13px] text-ink-200">主题</span>
        <ThemeToggle />
      </div>
    </Group>

    <!-- 显示年份 -->
    <Group id="years" title="显示年份">
      <div class="px-4 py-3.5">
        <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span class="text-[17px] font-semibold tabular-nums text-ink-100">{yMin} – {yMax}</span>
          <span class="text-[12px] text-ink-400">
            库内 {data.yearHard.min}–{data.yearHard.max} · 窗口外 {data.counts.outside.toLocaleString()} 条不显示
          </span>
        </div>

        <!-- 一根轨道两个滑块：起点不可能超过终点，两个独立滑块反而要用户自己保证 -->
        <div class="mt-4">
          <RangeSlider min={data.yearHard.min} max={data.yearHard.max}
                       from={yMin} to={yMax} disabled={busy}
                       onchange={(v) => { yMin = v.from; yMax = v.to; }} />
          <div class="mt-1.5 flex justify-between text-[11px] tabular-nums text-ink-400">
            <span>{data.yearHard.min}</span><span>{data.yearHard.max}</span>
          </div>
        </div>

        <div class="mt-3 flex items-center justify-end gap-2">
          {#if dirty}
            <button onclick={() => { yMin = data.yearWin.min; yMax = data.yearWin.max; }} class={SECONDARY}>撤销</button>
          {/if}
          <button onclick={saveYears} disabled={busy || !dirty} class={PRIMARY}>保存</button>
        </div>
      </div>
    </Group>

    <!-- 内容过滤 -->
    <Group id="filter" title="内容过滤">
      <label class="{ROW} cursor-pointer">
        <span class="flex items-center gap-1.5 text-[13px] text-ink-200">
          隐藏成人内容
          <InfoTip label="判定依据" w="20rem">
            <p class="text-[12px] leading-relaxed text-ink-400">
              仅依据 <code>hentai</code> 与 <code>18 restricted</code> 两个分级标签。
              <code>ecchi</code> / <code>harem</code> / <code>gore</code> 描述的是剧情内容，不是分级。
            </p>
          </InfoTip>
        </span>
        <span class="flex items-center gap-3">
          <span class="text-[12px] tabular-nums text-ink-400">{data.counts.nsfw.toLocaleString()} 条</span>
          <input type="checkbox" role="switch" checked={data.hideNsfw} disabled={busy}
                 onchange={(e) => toggleNsfw(e.currentTarget.checked)} class="switch" />
        </span>
      </label>
    </Group>

    <!-- 分享 -->
    {#if user && !desk}
    <Group id="share" title="分享番单">
      {#if data.shareToken}
        <div class="flex flex-wrap items-center gap-2 px-4 py-3">
          <input readonly value={`/share/${data.shareToken}`} onclick={(e) => e.currentTarget.select()}
                 aria-label="分享链接" class="{INPUT} font-mono text-[12px] max-sm:basis-full" />
          <a href="/share/{data.shareToken}" target="_blank" rel="noreferrer" class={SECONDARY}>打开</a>
          <button onclick={() => share('rotate')} disabled={busy} class={SECONDARY}>更换</button>
          <button onclick={() => share('revoke')} disabled={busy} class="{SECONDARY} hover:text-danger">撤销</button>
        </div>
      {:else}
        <div class={ROW}>
          <span class="text-[13px] text-ink-400">未生成 · 链接为只读</span>
          <button onclick={() => share('create')} disabled={busy} class={SECONDARY}>生成链接</button>
        </div>
      {/if}
    </Group>
    {/if}

    {#if user && data.filters.length}
      <Group id="saved" title="保存的筛选">
        {#each data.filters as fl (fl.id)}
          <div class="flex items-center gap-2 px-4 py-2.5">
            {#if fl.is_default}
              <span class="shrink-0 text-[11px] text-accent" title="默认">★</span>
            {/if}
            <a href="/catalog?{fl.filter_json}" class="min-w-0 flex-1 truncate text-[13px] hover:text-accent">{fl.name}</a>
            <span class="shrink-0 text-[11px] tabular-nums text-ink-400">{fl.created_at?.slice(0, 10)}</span>
            <button onclick={() => delFilter(fl.id)} disabled={busy}
                    class="shrink-0 px-1.5 text-[12px] text-ink-400 hover:text-danger">删除</button>
          </div>
        {/each}
      </Group>
    {/if}

    <!-- ── 站点管理 ── -->
    {#if admin && !desk}
      <Group id="members" title="注册白名单"><SignupAllow list={data.allow} /></Group>
    {/if}

    <!-- 截图：存在服务器这台电脑上，只有管理员能配（其他人的截图下载到自己设备） -->
    {#if admin}
    <Group id="shots" title="截图">
      <div class="px-4 py-3">
        <div class="text-[13px] text-ink-200">保存位置</div>
        <form class="mt-2 flex flex-wrap gap-2" onsubmit={(e) => { e.preventDefault(); saveShotDir(shotDir); }}>
          <input bind:value={shotDir} spellcheck="false" aria-label="截图保存位置" class="{INPUT} font-mono max-sm:basis-full" />
          <button disabled={busy || !shotDir.trim() || shotDir === data.shotDir} class={PRIMARY}>保存</button>
          {#if data.shotDir !== data.shotDefault}
            <button type="button" onclick={() => saveShotDir('')} disabled={busy} class={SECONDARY}>恢复默认</button>
          {/if}
        </form>
        <div class="mt-1.5 text-[12px] text-ink-400">缺省 {data.shotDefault}</div>
      </div>
    </Group>
    {/if}

    {#if admin}<WatchSites sites={data.watchSites} />{/if}

    <!-- 数据（「中文名已补」原来挂在侧栏，2026-10 起只在这里 —— 访客不该在侧栏看到运维数字） -->
    <Group id="stats" title="数据">
      <div class="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3.5 sm:grid-cols-4">
        {#each STATS as [k, v]}
          <div>
            <div class="text-[11px] text-ink-400">{k}</div>
            <div class="text-[16px] font-semibold tabular-nums text-ink-100">{v.toLocaleString()}</div>
          </div>
        {/each}
      </div>

      <div class="px-4 py-3">
        <div class="flex items-baseline justify-between text-[12px]">
          <span class="text-ink-400">Bangumi 导出包</span>
          <span class="tabular-nums {data.bangumiAgeDays == null || data.bangumiAgeDays > 14 ? 'text-danger' : ''}">
            {data.bangumiDump ?? '—'}{#if data.bangumiAgeDays != null} · {data.bangumiAgeDays} 天前{/if}
          </span>
        </div>
        <div class="mt-1 flex items-baseline justify-between text-[12px]">
          <span class="text-ink-400">AOD 快照（已停更）</span>
          <span class="tabular-nums text-ink-400">{data.aodUpdate ?? '—'}</span>
        </div>
        <!--
          key 必须用 s.id，不能用 kind+finished_at 拼出来的。
          实测事故：那两个字段【不唯一】—— 同一种任务在同一秒写完两条就撞了
          （我把两个 enrich-bgm 并行跑了，id 45/46 都是 bgm_enrich @ 02:06:07），
          两条都落在这里取的前 6 条里，Svelte 抛 each_key_duplicate，
          水合直接崩，正式站的设置页整片空白（DOM 从 19,284 字节塌到 4,062）。
          SSR 不校验 key，所以 HTTP 层的 e2e 测不出来；测试站用 dev.db 没有那两行，
          所以也不复现 —— 最后是靠 hooks.client.js 把浏览器异常送进日志才定位到。
        -->
        <!-- 每种任务只留最近一次（#110：同一种任务跑过几次就占几行，看不出各是什么） -->
        {#each latestSyncs as s (s.id)}
          <div class="mt-1 flex items-baseline justify-between gap-3 text-[12px]"
               title={s.error ?? undefined}>
            <span class={s.status === 'ok' ? 'text-ink-400' : 'text-danger'}>
              {KIND_CN[s.kind] ?? s.kind}{#if s.status !== 'ok'} · {s.error ?? s.status}{/if}
            </span>
            <span class="shrink-0 tabular-nums text-ink-400">
              {s.finished_at?.slice(5, 16) ?? '—'} · {(s.items ?? 0).toLocaleString()}
            </span>
          </div>
        {/each}
      </div>
    </Group>

    <!-- 数据来源 —— AOD 是 ODbL 许可，署名与「说明修改」是许可要求，不是客套 -->
    <Group id="sources" title="数据来源">
      <!-- lint-copy-ok: 整块「数据来源」都是署名与许可声明（ODbL 要求公开站标注来源、
           许可，并说明对原始数据做了哪些修改），不是使用说明，不能收进 hover 气泡 -->
      <div class="space-y-2 px-4 py-3.5 text-[12px] leading-relaxed text-ink-400">
        <div>
          番剧元数据来自
          <a href="https://github.com/manami-project/anime-offline-database" target="_blank"
             rel="noopener noreferrer" class="text-accent hover:underline">anime-offline-database</a>，
          依
          <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank"
             rel="noopener noreferrer" class="text-accent hover:underline">ODbL v1.0</a>
          与 DbCL v1.0 使用。
        </div>
        <div>
          中文名、评分、放送时间与 2026 年 7 月后的新番条目来自
          <a href="https://bgm.tv" target="_blank" rel="noopener noreferrer"
             class="text-accent hover:underline">Bangumi</a>
          （<a href="https://github.com/bangumi/Archive" target="_blank" rel="noopener noreferrer"
             class="text-accent hover:underline">bangumi/Archive</a> 每周导出的 wiki 数据）。
        </div>
        <!-- lint-copy-ok: ODbL 要求公开站说明对原始数据做了哪些修改，这段是许可义务不是使用说明 -->
        <div>
          本站对原始数据所做的修改：合并重复条目、按播出日期重推完结状态、
          归一制作公司名、中文分词建立搜索索引、按标签聚合中文题材、与 Bangumi 条目逐季对应。
        </div>
      </div>
    </Group>
  </div>
  <div class="h-8 lg:col-start-2"></div>
  </div>
</Page>

<style>
  /* 「隐藏成人内容」开关：还是原生 checkbox（行为、读屏、键盘都不变），只把外观画成开关 */
  .switch {
    appearance: none; position: relative; flex-shrink: 0; width: 40px; height: 24px; border-radius: 999px; cursor: pointer;
    background: var(--c-border-strong); transition: background-color .2s; min-height: 0;
  }
  .switch::after {
    content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 3px rgb(0 0 0 / 30%); transition: transform .2s;
  }
  .switch:checked { background: var(--c-accent); }
  .switch:checked::after { transform: translateX(16px); }
  .switch:disabled { cursor: default; }
</style>
