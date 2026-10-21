<script>
  /**
   * 评分：10 颗星，按比例填到一位小数（7.5 = 第 8 颗填一半）。主人 2026-10-21 选定（子代理出的方案 D）：
   * 卡片里已经有进度条，评分再用一条滑条就成了两条一样的条；星一看就是评分。
   *
   * 鼠标：点 / 拖到哪就是哪。手指：按下先跳到手指位置，之后的移动改成相对增量（8px = 0.1）——
   * 一颗星 26px，绝对定位 0.1 只有 2.6px，手指对不准。键盘 ←→ 0.1、PageUp/Down 1、Home/End 两端。
   * 拖动 / 按键只改本地草稿：拖动松手提交，按键停 600ms 再提交（每次提交页面都 invalidateAll + disabled）
   */
  let { value = null, disabled = false, onset } = $props();

  const MIN = 1, MAX = 10, STAR = 26, GAP = 4, TOUCH_PX = 8;
  const clamp = (v) => Math.min(MAX, Math.max(MIN, Math.round(v * 10) / 10));
  let draft = $state(null);
  const shown = $derived(draft ?? value);
  /** 实心层的宽度：整颗星连同间距，再加最后一颗的一部分 */
  const fillW = $derived(shown == null ? 0 : Math.floor(shown) * (STAR + GAP) + (shown % 1) * STAR);

  // 草稿等新值回来再清（提交时就清，invalidateAll 回来之前会先闪回旧值）
  $effect(() => { value; draft = null; });

  let timer;
  function commit(v) {
    clearTimeout(timer);
    if (v === value) { draft = null; return; }
    draft = v;
    onset(v);
  }

  let box;
  let drag = $state(null);  // { touch, x0, v0 }；拖动中不显示「清除」
  /** 指针在第几颗星的哪个位置；落在两颗星的间距里算前一颗满 */
  function atX(clientX) {
    const x = clientX - box.getBoundingClientRect().left;
    const i = Math.floor(x / (STAR + GAP));
    return clamp(i + Math.min(1, Math.max(0, (x - i * (STAR + GAP)) / STAR)));
  }
  function down(e) {
    if (disabled) return;
    clearTimeout(timer);
    box.setPointerCapture(e.pointerId);
    draft = atX(e.clientX);
    drag = { touch: e.pointerType === 'touch', x0: e.clientX, v0: draft };
  }
  function move(e) {
    if (!drag) return;
    draft = drag.touch ? clamp(drag.v0 + (e.clientX - drag.x0) / TOUCH_PX / 10) : atX(e.clientX);
  }
  function up() {
    if (!drag) return;
    drag = null;
    commit(draft);
  }
  const KEYS = { ArrowRight: 0.1, ArrowUp: 0.1, ArrowLeft: -0.1, ArrowDown: -0.1, PageUp: 1, PageDown: -1 };
  function key(e) {
    if (disabled) return;
    const d = KEYS[e.key];
    const v = d != null ? clamp((shown ?? 5 - d) + d) : e.key === 'Home' ? MIN : e.key === 'End' ? MAX : null;
    if (v == null) return;
    e.preventDefault();
    draft = v;
    clearTimeout(timer);
    timer = setTimeout(() => commit(draft), 600);
  }
</script>

{#snippet stars(cls)}
  {#each Array(MAX) as _, i (i)}
    <svg viewBox="0 0 24 24" width={STAR} height={STAR} class="shrink-0 {cls}" aria-hidden="true">
      <path d="M12 2.3l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.1l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z" />
    </svg>
  {/each}
{/snippet}

<div>
  <div class="flex items-baseline gap-2 text-sm">
    <span class="text-ink-400">评分</span>
    {#if shown == null}
      <span class="text-ink-400">未评</span>
    {:else}
      <b class="tabular-nums text-warm">{shown.toFixed(1)}</b><span class="text-ink-400">/ 10</span>
      {#if value != null && !drag}
        <button onclick={() => commit(null)} {disabled}
                class="ml-1 text-[12px] text-ink-400 hover:text-danger">清除</button>
      {/if}
    {/if}
  </div>
  <div bind:this={box} role="slider" tabindex="0" aria-label="我的评分"
       aria-valuemin={MIN} aria-valuemax={MAX} aria-valuenow={shown ?? undefined}
       aria-valuetext={shown == null ? '未评' : shown.toFixed(1)} aria-disabled={disabled}
       onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onkeydown={key}
       class="relative mt-1.5 inline-flex cursor-pointer touch-none select-none rounded py-0.5 outline-none
              focus-visible:ring-2 focus-visible:ring-accent" style="gap:{GAP}px">
    {@render stars('fill-ink-700')}
    <div class="pointer-events-none absolute left-0 top-0.5 flex overflow-hidden" style="gap:{GAP}px;width:{fillW}px">
      {@render stars('fill-warm-fill')}
    </div>
  </div>
</div>
