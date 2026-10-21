<script>
  /**
   * 错误页（#106）：原来没有这个文件，用的是 SvelteKit 缺省页 —— 左上角两行白字「404 / Not Found」，
   * 没有样式也没有出路。放在根布局里渲染，侧栏照常在。
   * 2026-10 UI 大改：大号渐变描边的状态码 + 一句话 + 回首页按钮（目录作次要去处），背后一团很淡的 accent 光晕。
   */
  import House from 'phosphor-svelte/lib/House';
  import { page } from '$app/state';
  import Page from '$lib/ui/Page.svelte';

  const status = $derived(page.status);
  /** 自己抛的错（「找不到这部番」）原样显示；SvelteKit 自带的英文提示换成中文 */
  const message = $derived(
    status === 404 ? (/^not found$/i.test(page.error?.message ?? '') ? '页面不存在' : page.error?.message || '页面不存在')
      : status >= 500 ? '服务器出错了' : page.error?.message || '出错了'
  );
</script>

<Page>
  <div class="err relative isolate mx-auto mt-8 flex max-w-lg flex-col items-center px-4 py-16 text-center sm:mt-16">
    <div class="glow pointer-events-none absolute inset-0 -z-10" aria-hidden="true"></div>
    <!-- 描边用 SVG 画：stroke 直接吃渐变，比 CSS text-stroke + background-clip 的组合干净 -->
    <svg viewBox="0 0 320 130" class="w-[260px] select-none sm:w-[340px]" aria-hidden="true">
      <defs>
        <linearGradient id="err-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style="stop-color: var(--c-accent)" />
          <stop offset=".55" class="mid" />
          <stop offset="1" style="stop-color: var(--c-warm-fill)" />
        </linearGradient>
      </defs>
      <text x="160" y="112" text-anchor="middle" font-size="128" font-weight="800" letter-spacing="-4"
            fill="url(#err-g)" fill-opacity=".08" stroke="url(#err-g)" stroke-width="2.5" stroke-linejoin="round"
            class="tabular-nums">{status}</text>
    </svg>
    <h1 class="mt-5 text-lg font-semibold text-ink-100 sm:text-xl">{message}</h1>
    <div class="mt-7 flex gap-2.5">
      <a href="/" class="inline-flex h-10 items-center gap-1.5 rounded-xl bg-accent px-5 text-sm font-semibold text-on-accent
                         shadow-[0_10px_24px_-10px_var(--c-accent)] transition hover:brightness-110">
        <House size={16} weight="fill" />回首页
      </a>
      <a href="/catalog" class="inline-flex h-10 items-center rounded-xl border border-ink-600 bg-ink-900 px-5 text-sm text-ink-200
                                transition hover:border-ink-400">去目录</a>
    </div>
  </div>
</Page>

<style>
  .mid { stop-color: var(--c-brand-2); }
  .glow { background: radial-gradient(closest-side, color-mix(in srgb, var(--c-accent) 14%, transparent), transparent); }
</style>
