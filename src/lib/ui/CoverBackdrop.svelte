<script>
  /**
   * 番剧封面做的氛围背景层：模糊放大的封面铺满父元素，边缘用 mask 渐隐到页面底色。
   * 用在：首页 hero 卡、详情页头部、季度浏览 hero、统计 hero、番单页头、观看页氛围光、排行榜前 3、放送表主卡。
   *
   * 父元素要求：`relative isolate`（这一层是 -z-10，isolate 让它只沉到父元素自己的底下，不沉到页面底色后面），
   * 卡片类再加 `overflow-hidden` + 圆角。内容照常写，不用额外定位。
   *
   *   <section class="relative isolate overflow-hidden rounded-2xl border border-ink-700">
   *     <CoverBackdrop id={a.id} scrim />
   *     …hero 内容…
   *   </section>
   *   <!-- 详情页头部：只铺顶上 560px，往下渐隐进页面 -->
   *   <div class="relative isolate"><CoverBackdrop {a} height="560px" fadeFrom={45} />…</div>
   *
   * props
   *   a          番剧行（取 a.id；a.cover_dead 或没有 picture/thumbnail 时整层不渲染）   三选一
   *   id         番剧 id → /cover/{id}                                                   三选一
   *   src        直接给图片地址（优先级最高）                                              三选一
   *   height     CSS 高度，从父元素顶部量；null = 铺满父元素                                默认 null
   *   blur       模糊半径 px（36–90 合适；小卡片用小值，整页头部用大值）                    默认 48
   *   intensity  不透明度倍数，乘在主题基准上（暗色 0.55 / 亮色 0.3，app.css --c-backdrop-opacity） 默认 1
   *   saturate   饱和度                                                                   默认 1.4
   *   fade       渐隐方向：'bottom' | 'top' | 'left' | 'right' | 'none'                    默认 'bottom'
   *   fadeFrom   从百分之几开始渐隐（之前全实）                                            默认 40
   *   scrim      左侧压一层页面底色渐变，保证左侧文字对比度                                 默认 false
   *   scrimWidth scrim 渐变到透明的位置                                                    默认 '65%'
   *   position   图片 object-position（封面人物多在上部）                                   默认 '50% 25%'
   * 图片加载完 300ms 淡入（系统「减少动态效果」时直接出现，app.css 全局处理）；加载失败整层不显示。
   * 始终 pointer-events-none + aria-hidden，纯装饰。
   */
  let { a = null, id = null, src = null, height = null, blur = 48, intensity = 1, saturate = 1.4,
        fade = 'bottom', fadeFrom = 40, scrim = false, scrimWidth = '65%', position = '50% 25%' } = $props();

  const url = $derived(src ?? (a ? (a.cover_dead || !(a.picture || a.thumbnail) ? null : `/cover/${a.id}`)
                                 : id != null ? `/cover/${id}` : null));
  // 记「哪个地址」加载好 / 坏了，换番时组件不重建也不会串（同 Cover.svelte）
  let loadedSrc = $state(null);
  let brokenSrc = $state(null);
  const loaded = $derived(loadedSrc !== null && loadedSrc === url);
  const broken = $derived(brokenSrc !== null && brokenSrc === url);

  const DIR = { bottom: 'to bottom', top: 'to top', left: 'to left', right: 'to right' };
  const mask = $derived(fade in DIR ? `linear-gradient(${DIR[fade]}, #000 ${fadeFrom}%, transparent 100%)` : 'none');

  let img = $state(null);
  // SSR 出来的 <img> 可能在水合前就加载完了，onload 不会再触发
  $effect(() => { if (img && url && img.complete && img.naturalWidth) loadedSrc = url; });
</script>

{#if url && !broken}
  <div aria-hidden="true"
       class="pointer-events-none absolute inset-x-0 top-0 -z-10 overflow-hidden {height ? '' : 'bottom-0'}"
       style:height={height}
       style:-webkit-mask-image={mask} style:mask-image={mask}>
    <img bind:this={img} src={url} alt="" decoding="async"
         onload={() => (loadedSrc = url)} onerror={() => (brokenSrc = url)}
         class="absolute inset-0 h-full w-full scale-125 object-cover transition-opacity duration-300"
         style:object-position={position}
         style:filter="blur({blur}px) saturate({saturate})"
         style:opacity={loaded ? `calc(var(--c-backdrop-opacity) * ${intensity})` : 0} />
    {#if scrim}
      <div class="absolute inset-0"
           style:background="linear-gradient(90deg, var(--c-backdrop-scrim) 0%, transparent {scrimWidth})"></div>
    {/if}
  </div>
{/if}
