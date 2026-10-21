<script>
  /**
   * 设置页「账号」：改用户名 / 邮箱、下线其他设备（多账号，2026-10-19）。
   * 改密码是弹窗（PasswordDialog，主人要求不摊在设置页里）。
   */
  import { PRIMARY, SECONDARY, ROW, INPUT } from './btn.js';
  import { toast } from '$lib/toast.svelte.js';
  import { invalidateAll } from '$app/navigation';
  import { post } from '$lib/api.js';
  import PasswordDialog from '$lib/ui/PasswordDialog.svelte';
  let { user, sessions = 0 } = $props();

  let username = $state(''), email = $state('');
  $effect(() => { username = user.username; email = user.email ?? ''; });
  const dirty = $derived(username.trim() !== user.username || email.trim() !== (user.email ?? ''));
  let pwOpen = $state(false);
  let busy = $state(false);

  async function run(body, ok) {
    busy = true;
    try { const r = await post('/api/auth', body); toast.ok(ok(r)); await invalidateAll(); return true; }
    catch (e) { toast.error(e); return false; }
    finally { busy = false; }
  }
  const saveProfile = () => run({ op: 'profile', username: username.trim(), email: email.trim() }, () => '账号信息已保存');
  const kickOthers = () => run({ op: 'logout-others' }, (r) => `已下线 ${r.ended} 台设备`);

  const LABEL = 'w-14 shrink-0 text-[13px] text-ink-400';
</script>

<!-- 设置页「账号」组的各行（外层卡片 + 分隔线由 SettingsGroup 提供）。角色 chip 跟在用户名旁边 -->
<PasswordDialog open={pwOpen} username={user.username} onclose={() => (pwOpen = false)} />

<div class="flex items-center gap-3 px-4 py-4">
  <span class="ava grid h-11 w-11 shrink-0 place-items-center rounded-full text-[17px] font-bold uppercase text-white">
    {user.username.slice(0, 1)}
  </span>
  <div class="min-w-0">
    <div class="flex items-center gap-2">
      <span class="truncate text-[15px] font-semibold text-ink-100">{user.username}</span>
      {#if user.role === 'admin'}
        <span class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent-ink">管理员</span>
      {/if}
    </div>
    {#if user.email}<div class="truncate text-[12px] text-ink-400">{user.email}</div>{/if}
  </div>
</div>

<form class="space-y-2.5 px-4 py-3.5" onsubmit={(e) => { e.preventDefault(); saveProfile(); }}>
  <label class="flex items-center gap-3">
    <span class={LABEL}>用户名</span>
    <input bind:value={username} autocomplete="username" spellcheck="false" maxlength="24" class={INPUT} />
  </label>
  <label class="flex items-center gap-3">
    <span class={LABEL}>邮箱</span>
    <input bind:value={email} type="email" autocomplete="email" spellcheck="false" class={INPUT} />
  </label>
  <div class="flex justify-end">
    <button disabled={busy || !dirty} class={PRIMARY}>保存</button>
  </div>
</form>

<div class={ROW}>
  <span class="text-[13px] text-ink-200">密码</span>
  <button onclick={() => (pwOpen = true)} class={SECONDARY}>修改密码</button>
</div>

<div class={ROW}>
  <span class="text-[13px] text-ink-200">登录中的设备 <b class="font-semibold text-ink-100 tabular-nums">{sessions}</b> 台</span>
  <button onclick={kickOthers} disabled={busy || sessions < 2} class={SECONDARY}>下线其他设备</button>
</div>

<style>
  .ava { background: linear-gradient(135deg, var(--c-accent), var(--c-brand-2)); }
</style>
