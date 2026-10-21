<script>
  /**
   * 品牌标：圆角方块 + 白色「j」，accent → 紫的渐变（2026-10 UI 大改）。
   * 用在顶栏、登录弹窗、未登录页、错误页；favicon（static/icon.svg）是同一个造型。
   * 测试站（test）换成暖色渐变，和 icon-test.svg 一致 —— 一眼区分两个站。
   *   size  边长 px（圆角按比例）   默认 24
   */
  let { size = 24, test = false } = $props();
</script>

<span aria-hidden="true" class="mark" class:test
      style:width="{size}px" style:height="{size}px" style:border-radius="{Math.round(size * 0.3)}px"
      style:font-size="{Math.round(size * 0.58)}px">j</span>

<style>
  .mark {
    display: inline-grid; place-items: center; flex-shrink: 0;
    font-weight: 800; line-height: 1; color: #fff; letter-spacing: -0.02em;
    text-shadow: 0 1px 2px rgb(0 0 0 / 25%);
    background: linear-gradient(135deg, var(--c-accent), var(--c-brand-2));
    box-shadow: 0 2px 10px -2px color-mix(in srgb, var(--c-accent) 60%, transparent),
                inset 0 1px 0 rgb(255 255 255 / 22%);
    /* 字形视觉居中：j 的下伸部让它看起来偏下 */
    padding-bottom: 0.06em;
  }
  .mark.test { background: linear-gradient(135deg, #f0a020, #e0603a);
    box-shadow: 0 2px 10px -2px rgb(240 160 32 / 55%), inset 0 1px 0 rgb(255 255 255 / 22%); }
</style>
