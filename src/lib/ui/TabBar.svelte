<script>
  /**
   * 手机底部标签栏（<md，2026-10 UI 大改）：首页 / 目录 / 放送表 / 番单 / 更多。
   * 主人要求手机端不要只是把电脑端压窄 —— 常用的四个入口放在拇指够得着的地方，其余导航和账号收进「更多」（根布局的抽屉）。
   *
   * - 高度 56px + safe-area；根布局在 :root 设 --tabbar-h，Toaster 和页面底部留白据此让开
   * - 链接和侧栏一样走整页跳转（data-sveltekit-reload，原因见 +layout.svelte 侧栏那段注释）
   * - 访客点「番单」：弹登录框，登录成功再进番单页（和 LoginGate 一样「用到才登录」）
   * - hidden：观看页横屏 / 全屏时由根布局隐藏
   *
   * props: user（访客 = null）· more（「更多」抽屉是否打开）· onmore（点「更多」）· onnav（点任一标签，用来收起抽屉）
   */
  import DotsThreeOutline from 'phosphor-svelte/lib/DotsThreeOutline';
  import { page } from '$app/state';
  import { NAV, isActive } from '$lib/nav.js';
  import { requireLogin } from '$lib/auth.svelte.js';
  let { user = null, more = false, onmore, onnav } = $props();

  const TABS = NAV.filter((n) => n.tab);
  // 抽屉开着时「更多」是当前项；当前页是抽屉里的那几项（季度浏览 / 设置…）时也亮「更多」
  const inMore = $derived(NAV.some((n) => !n.tab && isActive(n.href, page.url.pathname)));
  const moreOn = $derived(more || inMore);

  async function guard(e, t) {
    onnav?.();
    if (!t.auth || user) return;
    e.preventDefault();
    if (await requireLogin()) location.href = t.href;
  }
</script>

<nav aria-label="主导航"
     class="tabbar fixed inset-x-0 bottom-0 z-[45] border-t border-ink-700 bg-ink-900/90 backdrop-blur-xl md:hidden
            pb-[env(safe-area-inset-bottom)]">
  <div class="grid h-14 grid-cols-5">
    {#each TABS as t (t.href)}
      {@const on = !more && isActive(t.href, page.url.pathname)}
      <a href={t.href} data-sveltekit-reload onclick={(e) => guard(e, t)} aria-current={on ? 'page' : undefined}
         class="tab {on ? 'text-accent' : 'text-ink-400'}">
        <span class="pill" class:on><t.icon size={22} weight={on ? 'fill' : 'regular'} /></span>
        <span class="text-[10.5px] leading-none {on ? 'font-semibold' : ''}">{t.tab}</span>
      </a>
    {/each}
    <button type="button" onclick={() => onmore?.()} aria-expanded={more} aria-label="更多"
            class="tab {moreOn ? 'text-accent' : 'text-ink-400'}">
      <span class="pill" class:on={moreOn}><DotsThreeOutline size={22} weight={moreOn ? 'fill' : 'regular'} /></span>
      <span class="text-[10.5px] leading-none {moreOn ? 'font-semibold' : ''}">更多</span>
    </button>
  </div>
</nav>

<style>
  .tab { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
         min-height: 0; transition: color .15s; }
  .tab:active .pill { transform: scale(.92); }
  /* 当前项：图标后面一枚 accent 淡底胶囊（Material 3 式的指示器），比只换颜色更容易一眼认出 */
  .pill { display: grid; place-items: center; width: 52px; height: 28px; border-radius: 999px;
          transition: background-color .2s, transform .15s; }
  .pill.on { background: color-mix(in srgb, var(--c-accent) 16%, transparent); }
</style>
