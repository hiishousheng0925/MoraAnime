<script>
  /**
   * 首页主视觉 hero 卡（今天更新 / 继续看 / 推荐 / 快速标记进度 / 冷启动引导共用一套外壳）。
   *
   * 桌面：模糊封面铺底 + 右侧封面原图向左渐隐，左边海报 + 文字 + 按钮。
   * 手机（<640px）：封面原图做顶部横幅渐隐进卡片，不放海报，按钮整行（由 actions 里的 max-sm:flex-1 决定）。
   *
   * props
   *   a        番剧行：给氛围底、右侧大图、海报、标题链接                        与 covers 二选一
   *   covers   番剧行数组（取前 4）：拼成封面墙做右侧大图（冷启动 / 快速标记用）  默认 []
   *   kicker   标题上方的小胶囊文字（如「今天更新」）；null 不显示               默认 null
   *   tone     小胶囊配色 'warm' | 'accent'                                     默认 'warm'
   *   title    大标题                                                          必填
   *   href     大标题 / 海报的链接；null 不加链接                               默认 null
   *   children 标题下面的内容（集数行、元信息、进度条等）
   *   actions  按钮区（snippet）
   *   aside    桌面右下角 / 手机按钮下方的附加区（如今天多部更新时的切换小海报）
   */
  import CoverBackdrop from './CoverBackdrop.svelte';
  import Cover from '$lib/Cover.svelte';

  let { a = null, covers = [], kicker = null, tone = 'warm', title, href = null,
        children, actions, aside } = $props();

  const art = $derived(a ? [a] : covers.slice(0, 4));
  const artUrl = (x) => (x.cover_dead || !(x.picture || x.thumbnail) ? null : `/cover/${x.id}`);
  const bgId = $derived(art.find((x) => artUrl(x))?.id ?? null);

  /**
   * 原图分辨率不够（放大超过 1.25 倍）时加 1.5–2.5px 模糊，免得马赛克感。
   * 加载完才知道 naturalWidth，所以用 action；窗口缩放不重算，差一点无所谓。
   */
  function soften(img) {
    const run = () => {
      if (!img.naturalWidth) return;
      const k = img.clientWidth / img.naturalWidth;
      img.style.filter = k <= 1.25 ? '' : `blur(${k < 2.5 ? 1.5 : 2.5}px)`;
    };
    if (img.complete) run(); else img.addEventListener('load', run, { once: true });
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; }, { once: true });
  }
</script>

<section class="hero relative isolate overflow-hidden rounded-[20px] border border-ink-700 bg-ink-900">
  {#if bgId != null}<CoverBackdrop id={bgId} blur={44} fade="none" scrim scrimWidth="78%" intensity={1.15} />{/if}

  <!-- 封面原图：手机是顶部横幅，桌面是右侧大图（都用 mask 渐隐） -->
  <div aria-hidden="true"
       class="art pointer-events-none flex overflow-hidden max-sm:relative max-sm:h-[168px]
              sm:absolute sm:inset-y-0 sm:right-0 sm:-z-10 sm:w-[62%]">
    {#each art as x (x.id)}
      {#if artUrl(x)}
        <img use:soften src={artUrl(x)} alt="" decoding="async"
             class="h-full min-w-0 flex-1 scale-105 object-cover" style:object-position="50% 25%" />
      {/if}
    {/each}
  </div>
  <!-- 桌面底部压一层，右下角的切换小海报在亮图上也看得清 -->
  <div aria-hidden="true" class="shade pointer-events-none absolute inset-0 -z-10 max-sm:hidden"></div>

  <div class="relative flex flex-col px-[18px] pb-[18px] max-sm:-mt-11 sm:flex-row sm:items-end sm:gap-7 sm:p-7">
    {#if a}
      <a href={href ?? `/anime/${a.id}`} class="shrink-0 max-sm:hidden" tabindex="-1" aria-hidden="true">
        <Cover {a} eager cls="aspect-[2/3] w-[150px] rounded-[14px] shadow-hero" />
      </a>
    {/if}
    <div class="min-w-0 flex-1 sm:pb-1">
      {#if kicker}
        <span class="kick inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[12px] font-semibold tracking-wide
                     backdrop-blur-md {tone === 'accent' ? 'text-accent-ink' : 'text-warm'}">
          <i class="dot h-1.5 w-1.5 rounded-full {tone === 'accent' ? 'bg-accent' : 'bg-warm-fill'}"></i>{kicker}
        </span>
      {/if}
      <h2 class="mt-2.5 line-clamp-2 text-[22px] font-bold leading-tight tracking-tight text-ink-100 sm:mt-3 sm:text-[30px]">
        {#if href}<a {href} class="hover:text-accent-ink">{title}</a>{:else}{title}{/if}
      </h2>
      {#if children}{@render children()}{/if}
      {#if actions}<div class="mt-5 flex flex-wrap gap-2.5">{@render actions()}</div>{/if}
    </div>
    {#if aside}
      <div class="max-sm:mt-4 sm:absolute sm:bottom-5 sm:right-5">{@render aside()}</div>
    {/if}
  </div>
</section>

<style>
  .art { mask-image: linear-gradient(to bottom, #000 35%, transparent); -webkit-mask-image: linear-gradient(to bottom, #000 35%, transparent); }
  .art img { transition: opacity 300ms; }
  .shade { background: linear-gradient(0deg, color-mix(in srgb, var(--c-bg) 45%, transparent), transparent 55%); }
  /* 底色 = 半透明卡面 + 一点自身色：手机上胶囊压在封面横幅上，纯淡色底在花图上看不清 */
  .kick { background: color-mix(in srgb, currentColor 14%, color-mix(in srgb, var(--c-surface) 75%, transparent)); }
  .kick .dot { box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 22%, transparent); }
  @media (min-width: 640px) {
    .art { mask-image: linear-gradient(to left, #000 30%, transparent 96%); -webkit-mask-image: linear-gradient(to left, #000 30%, transparent 96%); }
  }
</style>
