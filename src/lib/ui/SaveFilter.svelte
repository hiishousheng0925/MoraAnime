<script>
  import { post } from '$lib/api.js';
  /**
   * 「我的筛选」：命名保存多套筛选组合，其中一套可标为默认。
   *
   * 合并前这里只管保存，另有一个独立的「默认」胶囊 —— 两个入口做类似的事，
   * 解释起来要列表格，那就是概念冗余。现在默认是某套组合的属性：
   *   列表第一项是内置的「系统默认」（出厂筛选，不可删改）
   *   每套右边的 ★ 切换默认；默认那套无参数进入目录时自动套用，「重置」也回到它
   *   删掉默认那套 → 自动回落到系统默认（is_default 跟着行一起删）
   */
  import { goto, invalidateAll } from '$app/navigation';
  import { SORT_OPTS, SORT2_OPTS, TYPE_CN, STATUS_CN } from '$lib/constants.js';
  import { toast } from '$lib/toast.svelte.js';
  import Sheet from './Sheet.svelte';
  import { BAR_BOX } from './bar.js';
  import { media } from '$lib/media.svelte.js';

  let { query = '', saved = [], canSave = false, systemIsDefault = true } = $props();

  let open = $state(false);
  let name = $state('');
  let busy = $state(false);
  let root;

  const already = $derived(saved.some((f) => f.filter_json === query));

  /** 把 query string 说成人能看懂的一行，否则存了几套就分不清哪套是哪套 */
  function summarize(qs) {
    const p = new URLSearchParams(qs);
    const out = [];
    if (p.get('q')) out.push(`搜「${p.get('q')}」`);
    const t = p.getAll('type').filter((x) => x !== 'all');
    if (p.getAll('type').includes('all')) out.push('全部类型');
    else if (t.length) out.push(t.map((x) => TYPE_CN[x] ?? x).join('·'));
    const g = [...p.getAll('g'), ...p.getAll('any')];
    if (g.length) out.push(g.join('/'));
    if (p.get('from') || p.get('to'))
      out.push(p.get('from') === p.get('to') ? p.get('from') : `${p.get('from') ?? ''}–${p.get('to') ?? ''}`);
    if (p.get('season')) out.push({ WINTER: '冬', SPRING: '春', SUMMER: '夏', FALL: '秋' }[p.get('season')] + '季');
    const st = p.getAll('status').filter((x) => x !== 'all');
    if (st.length) out.push(st.map((x) => STATUS_CN[x] ?? x).join('·'));
    if (p.get('smin')) out.push(`≥${p.get('smin')}分`);
    if (p.get('studio')) out.push(p.get('studio'));
    if (p.get('sort')) out.push(SORT_OPTS.find(([v]) => v === p.get('sort'))?.[1] ?? p.get('sort'));
    if (p.get('s2')) out.push('同季按' + (SORT2_OPTS.find(([v]) => v === p.get('s2'))?.[1] ?? p.get('s2')));
    return out.join(' · ') || '无条件';
  }

  async function api(body) {
    busy = true;
    try {
      // 走 api.js 的 post：访客点「保存」会先弹登录框，登录后接着存
      const r = await post('/api/filters', body).catch((e) => (e?.cancelled ? null : { error: e.message }));
      await invalidateAll();
      return r;
    } finally { busy = false; }
  }
  async function save() {
    if (!name.trim()) return;
    const n = name.trim();
    const r = await api({ name: n, query });
    if (r?.error) toast.error(r.error); else { toast.ok(`已保存「${n}」`); name = ''; open = false; }
  }
  const del = (id) => api({ op: 'del', id });
  /**
   * 切换默认后要跳到基础 URL —— 否则地址栏还带着旧筛选参数，
   * invalidateAll 只是重渲染同一个 URL，★ 移了但看到的内容没变。
   * /catalog 会重定向到新默认；默认被清掉时它直接渲染系统默认。
   */
  async function setDefault(id) {
    const r = await api({ op: 'default', id });
    if (r?.error) { toast.error(r.error); return; }
    open = false;
    toast.ok(id ? '已设为默认' : '已切回系统默认');
    await goto('/catalog', { invalidateAll: true });
  }
  // 手机上走 Sheet（挂在 body 下），点抽屉里不算「点外面」
  function onDoc(e) { if (open && !media.mobile && !root?.contains(e.target)) open = false; }
</script>

<svelte:document onclick={onDoc} />
<svelte:window onkeydown={(e) => e.key === 'Escape' && !media.mobile && (open = false)} />

{#snippet body()}
      <form onsubmit={(e) => { e.preventDefault(); save(); }} class="flex gap-1.5">
        <input bind:value={name} maxlength="30" disabled={!canSave}
               placeholder={!canSave ? '无筛选条件' : already ? '这组已保存过' : '命名'}
               class="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 text-[13px] max-sm:py-2 max-sm:text-base
                      outline-none placeholder:text-ink-400 focus:border-accent
                      disabled:cursor-not-allowed disabled:opacity-50" />
        <button disabled={busy || !canSave || !name.trim()}
                class="shrink-0 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent
                       disabled:opacity-40">保存</button>
      </form>

      <div class="mt-2.5 divide-y divide-ink-700 border-t border-ink-700 sm:max-h-72 sm:overflow-y-auto">
        <!-- 内置项：出厂筛选。不占表里的行，所以不可删也不可改名 -->
        <div class="flex items-center">
          <a href="/catalog?raw=1" class="min-w-0 flex-1 rounded px-2 py-2 hover:bg-ink-700">
            <div class="truncate text-[13px] text-ink-200">系统默认</div>
            <div class="truncate text-[11px] text-ink-400">TV·剧场版·OVA · 不含未上映 · 最新</div>
          </a>
          <div class="flex shrink-0 items-center">
            <button onclick={() => setDefault(null)} disabled={busy || systemIsDefault}
                    aria-label="设为默认" aria-pressed={systemIsDefault}
                    class="grid h-8 w-8 place-items-center rounded text-[15px] disabled:cursor-default
                           {systemIsDefault ? 'text-accent' : 'text-ink-400 hover:bg-ink-700 hover:text-accent'}"
                    >{systemIsDefault ? '★' : '☆'}</button>
            <span class="h-8 w-8"></span>
          </div>
        </div>

        {#each saved as f (f.id)}
          <div class="flex items-center">
            <a href="/catalog?{f.filter_json}" class="min-w-0 flex-1 rounded px-2 py-2 hover:bg-ink-700">
              <div class="truncate text-[13px] text-ink-200">{f.name}</div>
              <div class="truncate text-[11px] text-ink-400">{summarize(f.filter_json)}</div>
            </a>
            <div class="flex shrink-0 items-center">
              <button onclick={() => setDefault(f.is_default ? null : f.id)} disabled={busy}
                      aria-label="设为默认" aria-pressed={!!f.is_default}
                      class="grid h-8 w-8 place-items-center rounded text-[15px]
                             {f.is_default ? 'text-accent' : 'text-ink-400 hover:bg-ink-700 hover:text-accent'}"
                      >{f.is_default ? '★' : '☆'}</button>
              <button onclick={() => del(f.id)} disabled={busy} aria-label="删除"
                      class="grid h-8 w-8 place-items-center rounded text-[13px] text-ink-400
                             hover:bg-ink-700 hover:text-danger">✕</button>
            </div>
          </div>
        {/each}
      </div>

{/snippet}

<div bind:this={root} class="relative shrink-0">
  <button type="button" onclick={() => (open = !open)} aria-expanded={open}
          class="flex items-center gap-1.5 whitespace-nowrap bg-ink-900 px-3 {BAR_BOX}
                 {open ? 'border-accent text-accent-ink' : 'border-ink-600 text-ink-200 hover:border-ink-400'}">
    <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" stroke="currentColor"
         stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 2h8v12l-4-3-4 3V2z" />
    </svg>
    我的筛选{#if saved.length}<span class="text-ink-400">{saved.length}</span>{/if}
  </button>

  {#if media.mobile}
    <Sheet bind:open title="我的筛选" done="完成">{@render body()}</Sheet>
  {:else if open}
    <div class="absolute right-0 z-50 mt-1.5 w-[22rem] max-w-[calc(100vw-1.5rem)] rounded-xl border border-ink-600 bg-ink-800 p-3 shadow-2xl">
      {@render body()}
    </div>
  {/if}
</div>
