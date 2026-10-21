<script>
  /**
   * 登录 / 注册弹窗（主人要求不做单独的页面）。挂在根布局，由 requireLogin() 打开（见 auth.svelte.js）。
   * 登录：用户名或邮箱 + 密码。注册：用户名 + 邮箱 + 密码（邮箱要在管理员的白名单里）。
   * 表单带 autocomplete，浏览器 / 手机的密码管理器能正确存取。
   * 外观（2026-10 UI 大改）：顶部品牌标 + j-anime；桌面是居中卡片（遮罩模糊、fade + scale .97→1 入场），
   * 手机改用底部抽屉 Sheet（按钮在拇指够得着的地方）。表单写成一个 snippet 两边共用。
   */
  import X from 'phosphor-svelte/lib/X';
  import Eye from 'phosphor-svelte/lib/Eye';
  import EyeSlash from 'phosphor-svelte/lib/EyeSlash';
  import { fade, scale } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import Sheet from './Sheet.svelte';
  import BrandMark from './BrandMark.svelte';
  import { media } from '$lib/media.svelte.js';
  import { page } from '$app/state';
  import { authDialog, finishLogin } from '$lib/auth.svelte.js';
  import { toast } from '$lib/toast.svelte.js';

  let ident = $state(''), username = $state(''), email = $state(''), password = $state('');
  let error = $state(''), busy = $state(false), showPw = $state(false);
  let first = $state(null);
  const reg = $derived(authDialog.mode === 'register');

  // 打开 / 切换模式时：清掉上次的错误、焦点落到第一个输入框
  $effect(() => { if (authDialog.open) { authDialog.mode; error = ''; showPw = false; queueMicrotask(() => first?.focus()); } });

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    busy = true; error = '';
    const body = reg ? { op: 'register', username, email, password } : { op: 'login', ident, password };
    try {
      const r = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body) }).then((x) => x.json());
      if (r.error) { error = r.error; return; }
      password = '';
      toast.ok(reg ? `欢迎，${r.user.username}` : `已登录：${r.user.username}`);
      await finishLogin(true);
    } catch (err) { error = String(err?.message ?? err); }
    finally { busy = false; }
  }
  const cancel = () => { if (!busy) finishLogin(false); };
  const swap = () => { authDialog.mode = reg ? 'login' : 'register'; };

  const INPUT = `w-full rounded-xl border border-ink-600 bg-ink-950 px-3.5 py-2.5 text-sm text-ink-100 transition
                 placeholder:text-ink-400 focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/15`;
  const dur = $derived(media.reducedMotion ? 0 : 1);
  const isTest = $derived(page.data?.env === 'test');
</script>

<!-- 密码框右侧的「显示 / 隐藏密码」：手机上输错一位看不见，是最常见的登录失败。label 的控件仍是输入框（第一个可标注的后代） -->
{#snippet pw(ac, isNew)}
  <span class="relative block">
    <input bind:value={password} name="password" type={showPw ? 'text' : 'password'} autocomplete={ac}
           required minlength={isNew ? 8 : undefined} placeholder={isNew ? '至少 8 位' : undefined}
           spellcheck="false" autocapitalize="off" class="{INPUT} pr-11" />
    <button type="button" onclick={() => (showPw = !showPw)} aria-label={showPw ? '隐藏密码' : '显示密码'}
            aria-pressed={showPw} title={showPw ? '隐藏密码' : '显示密码'}
            class="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-xl text-ink-400 transition hover:text-ink-100">
      {#if showPw}<EyeSlash size={18} />{:else}<Eye size={18} />{/if}
    </button>
  </span>
{/snippet}

{#snippet body(mobile)}
  <div class="flex items-center gap-2.5 {mobile ? 'pt-1' : ''}">
    <BrandMark size={30} test={isTest} />
    <div class="min-w-0">
      <div class="text-[12px] font-medium tracking-wide text-ink-400">j-anime</div>
      <h2 id="auth-title" class="text-[18px] font-semibold leading-tight">{reg ? '注册' : '登录'}</h2>
    </div>
    {#if !mobile}
      <button type="button" onclick={cancel} aria-label="关闭"
              class="ml-auto grid h-8 w-8 place-items-center self-start rounded-lg text-ink-400 hover:bg-ink-800 hover:text-ink-200">
        <X size={16} weight="bold" />
      </button>
    {/if}
  </div>

  <form onsubmit={submit} class="mt-5 space-y-3">
    {#if reg}
      <label class="block">
        <span class="mb-1.5 block text-[12px] text-ink-400">用户名</span>
        <input bind:this={first} bind:value={username} name="username" autocomplete="username" required
               minlength="2" maxlength="24" spellcheck="false" autocapitalize="off" class={INPUT} />
      </label>
      <label class="block">
        <span class="mb-1.5 block text-[12px] text-ink-400">邮箱</span>
        <input bind:value={email} name="email" type="email" autocomplete="email" required
               spellcheck="false" class={INPUT} />
      </label>
      <label class="block">
        <span class="mb-1.5 block text-[12px] text-ink-400">密码</span>
        {@render pw('new-password', true)}
      </label>
    {:else}
      <label class="block">
        <span class="mb-1.5 block text-[12px] text-ink-400">用户名或邮箱</span>
        <input bind:this={first} bind:value={ident} name="username" autocomplete="username" required
               spellcheck="false" autocapitalize="off" class={INPUT} />
      </label>
      <label class="block">
        <span class="mb-1.5 block text-[12px] text-ink-400">密码</span>
        {@render pw('current-password', false)}
      </label>
    {/if}

    {#if error}<p class="text-[13px] text-danger" role="alert">{error}</p>{/if}

    <button type="submit" disabled={busy}
            class="!mt-5 w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent shadow-[0_8px_20px_-8px_var(--c-accent)]
                   transition hover:brightness-110 active:scale-[0.99] disabled:bg-ink-800 disabled:text-ink-400 disabled:shadow-none
                   {mobile ? 'h-12 text-[15px]' : ''}">
      {busy ? (reg ? '注册中…' : '登录中…') : (reg ? '注册' : '登录')}
    </button>
  </form>

  <div class="mt-4 text-center text-[13px] text-ink-400">
    {reg ? '已有账号？' : '还没有账号？'}
    <button type="button" onclick={swap} class="font-medium text-accent hover:underline">{reg ? '登录' : '注册'}</button>
  </div>
{/snippet}

<svelte:window onkeydown={(e) => authDialog.open && !media.mobile && e.key === 'Escape' && cancel()} />

{#if media.mobile}
  <Sheet open={authDialog.open} label={reg ? '注册' : '登录'} onclose={cancel} maxh="92dvh">
    <div class="pb-1">{@render body(true)}</div>
  </Sheet>
{:else if authDialog.open}
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" role="presentation"
       onclick={cancel} transition:fade={{ duration: 180 * dur }}>
    <div role="dialog" aria-modal="true" aria-labelledby="auth-title" onclick={(e) => e.stopPropagation()}
         transition:scale={{ start: 0.97, duration: 200 * dur, easing: cubicOut }}
         class="card w-full max-w-sm rounded-2xl p-6 shadow-hero">
      {@render body(false)}
    </div>
  </div>
{/if}
