<script>
  /**
   * 修改密码弹窗（主人 2026-10-19：改密码不要摊在设置页里，做成弹窗）。
   * 新密码输两遍；成功后服务端顺带把其他设备下线（见 api/auth 的 password）。
   */
  import X from 'phosphor-svelte/lib/X';
  import { toast } from '$lib/toast.svelte.js';
  import { invalidateAll } from '$app/navigation';
  import { post } from '$lib/api.js';
  let { open = false, username, onclose } = $props();

  let oldPw = $state(''), newPw = $state(''), again = $state('');
  let error = $state(''), busy = $state(false);
  let first = $state(null);
  $effect(() => {
    if (!open) return;
    oldPw = ''; newPw = ''; again = ''; error = '';
    queueMicrotask(() => first?.focus());
  });
  const mismatch = $derived(again.length > 0 && again !== newPw);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (newPw !== again) { error = '两次输入的新密码不一样'; return; }
    busy = true; error = '';
    try {
      const r = await post('/api/auth', { op: 'password', old: oldPw, password: newPw });
      toast.ok(r.ended ? `密码已修改，其他 ${r.ended} 台设备已下线` : '密码已修改');
      await invalidateAll();
      onclose?.();
    } catch (err) { if (!err?.cancelled) error = err.message; }
    finally { busy = false; }
  }
  const cancel = () => { if (!busy) onclose?.(); };

  const INPUT = `w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2.5 text-sm text-ink-100
                 placeholder:text-ink-400 focus:border-accent focus:outline-none`;
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && cancel()} />

{#if open}
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4" role="presentation" onclick={cancel}>
    <div role="dialog" aria-modal="true" aria-labelledby="pw-title" onclick={(e) => e.stopPropagation()}
         class="card w-full max-w-sm rounded-xl p-5">
      <div class="mb-4 flex items-center">
        <h2 id="pw-title" class="text-[17px] font-semibold">修改密码</h2>
        <button type="button" onclick={cancel} aria-label="关闭"
                class="ml-auto grid h-8 w-8 place-items-center rounded-lg text-ink-400 hover:bg-ink-800 hover:text-ink-200">
          <X size={16} weight="bold" />
        </button>
      </div>
      <form onsubmit={submit} class="space-y-2.5">
        <!-- 隐藏的用户名：让密码管理器知道改的是哪个账号的密码 -->
        <input type="text" value={username} autocomplete="username" class="hidden" tabindex="-1" aria-hidden="true" readonly />
        <label class="block">
          <span class="mb-1 block text-[12px] text-ink-400">原密码</span>
          <input bind:this={first} bind:value={oldPw} type="password" autocomplete="current-password" required class={INPUT} />
        </label>
        <label class="block">
          <span class="mb-1 block text-[12px] text-ink-400">新密码</span>
          <input bind:value={newPw} type="password" autocomplete="new-password" required minlength="8" placeholder="至少 8 位" class={INPUT} />
        </label>
        <label class="block">
          <span class="mb-1 block text-[12px] text-ink-400">再输一次新密码</span>
          <input bind:value={again} type="password" autocomplete="new-password" required minlength="8"
                 class="{INPUT} {mismatch ? 'border-danger/70' : ''}" aria-invalid={mismatch} />
        </label>
        {#if error}<p class="text-[13px] text-danger" role="alert">{error}</p>{/if}
        <button type="submit" disabled={busy || newPw.length < 8 || mismatch || !oldPw}
                class="mt-1 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-on-accent
                       transition active:scale-[0.99] disabled:opacity-50">
          {busy ? '修改中…' : '修改密码'}
        </button>
      </form>
    </div>
  </div>
{/if}
