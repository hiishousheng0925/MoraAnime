<script>
  /**
   * 品牌标「追番猫」：圆角方块里一只极简猫头，一只眼睛是播放键（= 正在看）。主人 2026-10-21 从 5 个方案里选的 E，
   * 换掉原来的白色「j」（「一个 j 字感觉有点丑」）。用在顶栏、登录弹窗、未登录页、错误页；
   * favicon（static/icon.svg / icon-test.svg）和 MoraAnime 客户端的 .ico 是同一个造型。
   *
   * 配色三种，同形异色：
   *   网站        accent → 品牌紫（跟主题走，和以前的「j」一样）
   *   测试站      暖色（test）—— 一眼区分两个站，和 icon-test.svg 一致
   *   MoraAnime   紫 → 樱粉（桌面客户端：品牌名 J_ANIME_BRAND=MoraAnime）
   *   size  边长 px   默认 24
   */
  import { page } from '$app/state';
  let { size = 24, test = false } = $props();
  const tone = $derived(test ? 'test' : page.data?.brand === 'MoraAnime' ? 'mora' : 'site');
  // 一页里会有好几个品牌标（顶栏 + 抽屉 + 弹窗），渐变 id 不能重
  const uid = $props.id();
</script>

<svg aria-hidden="true" viewBox="0 0 192 192" width={size} height={size} class="mark {tone}"
     style:border-radius="{Math.round(size * 0.25)}px">
  <defs>
    <linearGradient id="g-{uid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" class="s0" /><stop offset="1" class="s1" />
    </linearGradient>
    <linearGradient id="h-{uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".22" /><stop offset=".5" stop-color="#fff" stop-opacity="0" />
    </linearGradient>
  </defs>
  <rect width="192" height="192" rx="48" fill="url(#g-{uid})" />
  <rect width="192" height="192" rx="48" fill="url(#h-{uid})" />
  <path d="M44 146C36 118 38 94 46 76L50 42Q51 34 58 38L84 58Q96 55 108 58L134 38Q141 34 142 42L146 76C154 94 156 118 148 146Q96 168 44 146Z"
        fill="#fff" />
  <ellipse cx="74" cy="108" rx="10" ry="14" fill="url(#g-{uid})" />
  <path d="M110 95 L110 121 L130 108Z" fill="url(#g-{uid})" stroke="url(#g-{uid})" stroke-width="7" stroke-linejoin="round" />
</svg>

<style>
  .mark { display: inline-block; flex-shrink: 0; }
  .site { box-shadow: 0 2px 10px -2px color-mix(in srgb, var(--c-accent) 60%, transparent); }
  .site .s0 { stop-color: var(--c-accent); }
  .site .s1 { stop-color: var(--c-brand-2); }
  .test { box-shadow: 0 2px 10px -2px rgb(240 160 32 / 55%); }
  .test .s0 { stop-color: #f0a020; }
  .test .s1 { stop-color: #e0603a; }
  .mora { box-shadow: 0 2px 10px -2px rgb(255 122 184 / 50%); }
  .mora .s0 { stop-color: #8a7dff; }
  .mora .s1 { stop-color: #ff7ab8; }
</style>
