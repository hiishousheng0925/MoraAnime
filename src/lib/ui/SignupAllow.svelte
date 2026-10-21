<script>
  /**
   * 注册白名单（管理员）：只有名单里的邮箱能注册。主人 2026-10-19 要的「白名单」。
   * 已注册的标出来；从名单里移除不影响已经注册的账号。
   */
  import { PRIMARY, INPUT } from './btn.js';
  import { toast } from '$lib/toast.svelte.js';
  import { invalidateAll } from '$app/navigation';
  import { post } from '$lib/api.js';
  let { list = [] } = $props();

  let email = $state(''), busy = $state(false);
  async function run(body, ok) {
    busy = true;
    try { await post('/api/admin/allow', body); toast.ok(ok); await invalidateAll(); return true; }
    catch (e) { toast.error(e); return false; }
    finally { busy = false; }
  }
  async function add() {
    const e = email.trim();
    if (e && await run({ op: 'add', email: e }, `已加入白名单：${e}`)) email = '';
  }
</script>

<!-- 设置页「注册白名单」组的各行（外层卡片 + 分隔线由 SettingsGroup 提供） -->
<form class="flex gap-2 px-4 py-3" onsubmit={(e) => { e.preventDefault(); add(); }}>
  <input bind:value={email} type="email" placeholder="邮箱" aria-label="允许注册的邮箱" spellcheck="false" class={INPUT} />
  <button disabled={busy || !email.trim()} class={PRIMARY}>加入</button>
</form>
{#each list as a (a.email)}
  <div class="flex items-center gap-2 px-4 py-2.5">
    <span class="min-w-0 flex-1 truncate text-[13px]">{a.email}</span>
    {#if a.registered}<span class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] text-accent-ink">已注册</span>{/if}
    <span class="shrink-0 text-[11px] tabular-nums text-ink-400">{a.created_at?.slice(0, 10)}</span>
    <button onclick={() => run({ op: 'remove', email: a.email }, `已移出白名单：${a.email}`)} disabled={busy}
            class="shrink-0 px-1.5 text-[12px] text-ink-400 hover:text-danger">移除</button>
  </div>
{:else}
  <p class="px-4 py-3 text-[12px] text-ink-400">名单为空 · 暂无人可注册</p>
{/each}
