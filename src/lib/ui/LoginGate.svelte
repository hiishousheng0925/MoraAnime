<script>
  /**
   * 个人页（我的番单 / 我的统计 / 快速标记）的未登录状态：留在原页，标题照旧，正文换成一个登录入口。
   * 不跳转、不弹窗 —— 主人要的是「用到才登录」，打开页面本身不算用到。
   *
   * 2026-10 UI 大改：背后铺一面倾斜的热门封面墙（根布局 load 给访客算的 gateCovers），
   * 压一层页面底色的渐变保证文字对比度；前面只有一行字和一个登录按钮，不加说明句。
   */
  import SignIn from 'phosphor-svelte/lib/SignIn';
  import { page } from '$app/state';
  import { requireLogin } from '$lib/auth.svelte.js';
  import BrandMark from './BrandMark.svelte';
  let { title, line } = $props();
  const covers = $derived(page.data?.gateCovers ?? []);
</script>

<h1 class="text-xl font-semibold">{title}</h1>
<section class="gate relative isolate mt-6 overflow-hidden rounded-2xl border border-ink-700 bg-ink-900">
  {#if covers.length}
    <div class="wall pointer-events-none absolute -z-10" aria-hidden="true">
      {#each covers as id (id)}
        <img src="/cover/{id}" alt="" loading="lazy" decoding="async" class="aspect-[2/3] w-full rounded-lg object-cover" />
      {/each}
    </div>
  {/if}
  <div class="veil pointer-events-none absolute inset-0 -z-10" aria-hidden="true"></div>
  <div class="flex min-h-[340px] flex-col items-center justify-center gap-5 px-6 py-14 text-center sm:min-h-[400px]">
    <BrandMark size={44} test={page.data?.env === 'test'} />
    <p class="text-[17px] font-semibold text-ink-100 sm:text-lg">{line}</p>
    <button type="button" onclick={() => requireLogin()}
            class="inline-flex h-11 items-center gap-2 rounded-xl bg-accent px-6 text-[15px] font-semibold text-on-accent
                   shadow-[0_10px_24px_-10px_var(--c-accent)] transition hover:brightness-110 active:scale-[0.98]">
      <SignIn size={18} weight="bold" />登录
    </button>
  </div>
</section>

<style>
  .wall {
    inset: -40px -60px;
    display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px;
    transform: rotate(-8deg) scale(1.1);
    filter: blur(2px) saturate(1.15);
    opacity: var(--c-backdrop-opacity);
  }
  @media (min-width: 640px) { .wall { grid-template-columns: repeat(8, minmax(0, 1fr)); } }
  /* 中间压深（文字在这儿），四周透出封面 */
  .veil { background: radial-gradient(ellipse 60% 70% at 50% 50%, var(--c-surface) 25%,
                      color-mix(in srgb, var(--c-surface) 70%, transparent) 70%,
                      color-mix(in srgb, var(--c-surface) 35%, transparent)); }
</style>
