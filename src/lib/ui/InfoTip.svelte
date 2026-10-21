<script>
  /**
   * 说明气泡。不占页面高度 —— 鼠标移到「?」上就展开。
   *
   * 为什么是 hover + click 两种都留：
   *   hover 在桌面上最省事（不用点、不用再点一次关掉），但触屏没有 hover，
   *   手机上访问（tailnet 里手机是主要设备之一）就永远打不开。
   *   所以 hover 进/出负责桌面，click 切换负责触屏，两者共用同一个 open 状态。
   * 图标保留成可见的「?」而不是纯 hover 热区 —— 不然没人知道这里有说明。
   */
  let { label = '说明', w = '22rem', children } = $props();
  let open = $state(false);
  let root;
  /** 触屏点开的不该被 mouseleave 关掉（有些浏览器点击后会补发 mouseenter/leave） */
  let pinned = $state(false);
  function onDoc(e) { if (open && !root?.contains(e.target)) { open = false; pinned = false; } }
</script>

<svelte:document onclick={onDoc} />
<svelte:window onkeydown={(e) => e.key === 'Escape' && ((open = false), (pinned = false))} />

<span bind:this={root} class="relative inline-flex align-middle"
      onmouseenter={() => (open = true)}
      onmouseleave={() => !pinned && (open = false)}>
  <button type="button" aria-label={label} title={label}
          onclick={(e) => { e.stopPropagation(); pinned = !pinned; open = pinned || !open; }}
          onfocus={() => (open = true)} onblur={() => !pinned && (open = false)}
          class="group/tip grid size-[18px] place-items-center rounded-full
                 [@media(pointer:coarse)]:-m-[13px] [@media(pointer:coarse)]:size-11">
    <!-- 视觉上是 18px 的圆；触屏上命中区撑成 44×44 正方形（负外边距抵掉，不挤布局）。
         原来 app.css 的 pointer:coarse min-height:44px 直接作用在圆上，把它撑成竖长胶囊 -->
    <span class="grid size-[18px] place-items-center rounded-full border bg-ink-900 text-[11px] transition
                 {open ? 'border-accent text-accent' : 'border-ink-600 text-ink-400 group-hover/tip:text-ink-200'}">?</span>
  </button>
  {#if open}
    <div class="absolute left-0 top-6 z-50 rounded-xl border border-ink-600 bg-ink-800 p-3 shadow-2xl"
         style="width:{w}; max-width:calc(100vw - 2rem)">{@render children()}</div>
  {/if}
</span>
