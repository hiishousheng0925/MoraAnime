<script>
  /**
   * 观看站管理 —— 主人自己配的 URL 模板，详情页据此渲染「观看」按钮。
   * 抽成组件是因为设置页超了 400 行的上限，而这一块本来就自成一体。
   * 只存模板、只生成链接：站里不请求这些网址、不解析对方页面。
   */
  import { invalidateAll } from '$app/navigation';
  import Group from './SettingsGroup.svelte';
  import InfoTip from '$lib/ui/InfoTip.svelte';
  import { PRIMARY } from './btn.js';
  import { toast } from '$lib/toast.svelte.js';
  import { isValidTemplate } from '$lib/watchSite.js';
  let { sites = [] } = $props();

  let busy = $state(false);
  let name = $state('');
  let url = $state('');
  // 行内编辑：一次只编辑一行，editId 为空就是没在编辑
  let editId = $state(null);
  let editName = $state('');
  let editUrl = $state('');

  async function api(body) {
    busy = true;
    try {
      return await fetch('/api/watch-sites', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then((r) => r.json());
    } finally { busy = false; await invalidateAll(); }
  }

  /** 不合法的网址在本地就挡掉，不跑一趟服务端 —— 服务端那道校验照样在 */
  const badUrl = (u) => !isValidTemplate(u) && '网址要以 http:// 或 https:// 开头';

  async function add() {
    const bad = badUrl(url);
    // ⚠️ toast 是对象不是函数（toast.ok / toast.error）。写成 toast(...) 会抛
    // TypeError，在 async 里被吞成 unhandledrejection：点了完全没反应。
    // lint-arch 规则 15b 盯着这个写法。
    if (bad) return toast.error(bad);
    const r = await api({ name, url });
    if (r?.error) return toast.error(r.error);
    name = ''; url = '';
  }

  const startEdit = (w) => { editId = w.id; editName = w.name; editUrl = w.url; };
  async function saveEdit() {
    const bad = badUrl(editUrl);
    if (bad) return toast.error(bad);
    const r = await api({ op: 'edit', id: editId, name: editName, url: editUrl });
    if (r?.error) return toast.error(r.error);
    editId = null;
  }

  const FIELD = 'rounded-lg border border-ink-600 bg-ink-950 px-2.5 py-1.5 text-[13px] text-ink-100 outline-none focus:border-accent';
  const ICON = 'shrink-0 px-1 text-[12px] text-ink-400 hover:text-ink-200 disabled:opacity-30';
</script>

<!-- 设置页「观看站」组：标题旁的 InfoTip + 各行（外层卡片 + 分隔线由 SettingsGroup 提供） -->
<Group id="sites" title="观看站">
  {#snippet extra()}
    <InfoTip>
      详情页的「观看」按钮由这里的模板生成，点了才跳转 —— 站里不会去请求这些网址。
      网址里放这几个占位符，会被替换成番名并做 URL 编码：
      <br />{'{cn}'} 中文名（缺时回退罗马字）· {'{ja}'} 日文原名 · {'{romaji}'} 罗马字/英文名
      <br />中文站用 {'{cn}'}、日文站用 {'{ja}'}、国际站用 {'{romaji}'}，用错了搜出来是空的。
      <br />不放占位符也行，那按钮就只是打开这个站的首页。
    </InfoTip>
  {/snippet}
    <!-- 输入栏在最上面：新加一条是最常做的操作，不该排在已有列表后面 -->
    <div class="flex flex-wrap items-center gap-2 px-4 py-3">
      <input bind:value={name} placeholder="站点名字" class="w-28 max-sm:flex-1 {FIELD}" />
      <input bind:value={url} placeholder="https://…/search?q={'{cn}'}" class="min-w-0 flex-1 max-sm:order-last max-sm:basis-full {FIELD}" />
      <button onclick={add} disabled={busy || !name.trim() || !url.trim()} class={PRIMARY}>添加</button>
    </div>
    {#each sites as w, i (w.id)}
      <div class="flex flex-wrap items-center gap-2 px-4 py-2.5">
        {#if editId === w.id}
          <input bind:value={editName} class="w-28 {FIELD}" />
          <input bind:value={editUrl} class="min-w-0 flex-1 {FIELD}" />
          <button onclick={saveEdit} disabled={busy || !editName.trim() || !editUrl.trim()} class={PRIMARY}>保存</button>
          <button onclick={() => (editId = null)} disabled={busy}
                  class="shrink-0 px-1.5 text-[11px] text-ink-400 hover:text-ink-200">取消</button>
        {:else}
          <button onclick={() => api({ op: 'toggle', id: w.id, enabled: !w.enabled })} disabled={busy}
                  class="shrink-0 text-[11px] {w.enabled ? 'text-accent' : 'text-ink-400'}"
                  title={w.enabled ? '已启用' : '已停用'}>{w.enabled ? '●' : '○'}</button>
          <div class="min-w-0 flex-1">
            <div class="truncate text-[13px] {w.enabled ? 'text-ink-200' : 'text-ink-400'}">{w.name}</div>
            <div class="truncate text-[11px] text-ink-400">{w.url}</div>
          </div>
          <button onclick={() => startEdit(w)} disabled={busy}
                  class="shrink-0 px-1.5 text-[11px] text-ink-400 hover:text-accent">编辑</button>
          <button onclick={() => api({ op: 'move', id: w.id, dir: 'up' })} disabled={busy || i === 0}
                  class={ICON}>↑</button>
          <button onclick={() => api({ op: 'move', id: w.id, dir: 'down' })} disabled={busy || i === sites.length - 1}
                  class={ICON}>↓</button>
          <button onclick={() => api({ op: 'del', id: w.id })} disabled={busy}
                  class="shrink-0 px-1.5 text-[11px] text-ink-400 hover:text-danger">删除</button>
        {/if}
      </div>
    {/each}
</Group>
