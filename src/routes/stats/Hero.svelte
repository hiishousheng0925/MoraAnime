<script>
  /**
   * 统计页首屏「回顾 hero」：原来是 4 张同款 KPI 小卡，数字再大也没有情绪。
   * 改成一块通栏：左边一个主数字（看了多少小时）+ 一句换算 + 一排次要指标；
   * 右边评分最高的 5 部封面扇形叠放；背景是倾斜的封面墙 + 页面底色遮罩。
   * 都是标签，不写说明句（CLAUDE.md 第 4 条）。
   *
   * 数字上的 data-stat 是给 tests/stats-audit.js 对账用的：页面印出来的数必须和 stats() 一致。
   */
  import { fmtNum } from './fmt.js';
  let { data } = $props();

  const days = $derived((data.hours / 24).toFixed(1));
  const since = $derived(data.since ? data.since.replaceAll('-', '.') : null);
  /** 扇形 5 个槽位从左到右放第 4、2、1、3、5 名：最高分在正中、压在最上面 */
  const SLOTS = [3, 1, 0, 2, 4];
  const fan = $derived(SLOTS.map((i, slot) => ({ a: data.top[i], slot })).filter((x) => x.a));
  /** 背景墙：用评分最高的那批封面铺满（不够就循环）。没有可用封面就不铺，只留渐变 */
  const wall = $derived.by(() => {
    const ids = data.top.filter((a) => !a.cover_dead && (a.picture || a.thumbnail)).map((a) => a.id);
    return ids.length ? Array.from({ length: 24 }, (_, i) => ids[(i * 5) % ids.length]) : [];
  });
  const kpis = $derived([
    { stat: 'total', v: fmtNum(data.total), unit: null, label: '番单总数' },
    { stat: 'avg', v: data.avgScore == null ? '—' : data.avgScore.toFixed(1), unit: data.avgScore == null ? null : '/10', label: '我的平均分' },
    data.topGenre && { stat: 'genre', v: data.topGenre.name, unit: null, label: `最多的题材 · ${data.topGenre.c} 部` },
    data.peakYear && { stat: 'year', v: data.peakYear.year, unit: null, label: `最多的年份 · ${data.peakYear.c} 部` }
  ].filter(Boolean));
</script>

<section class="hero relative isolate overflow-hidden rounded-3xl border border-ink-700 shadow-hero">
  {#if wall.length}
    <div class="wall" aria-hidden="true">
      {#each wall as id, i (i)}<img src="/cover/{id}" alt="" loading="lazy" decoding="async" />{/each}
    </div>
  {/if}
  <div class="veil" aria-hidden="true"></div>

  <div class="flex flex-col-reverse gap-5 px-5 pb-5 pt-6 sm:flex-row sm:items-end sm:gap-8 sm:px-8 sm:pb-7 sm:pt-7">
    <div class="min-w-0 flex-1">
      <div class="text-[12px] tracking-wide text-ink-200">
        {#if since}{since} 起{' · '}{/if}看过 {data.watchedCount} 部
      </div>
      <div class="mt-1.5 flex items-baseline gap-2">
        <b class="big" data-stat="hours">{fmtNum(data.hours)}</b>
        <span class="text-[18px] font-semibold text-ink-200 sm:text-[20px]">小时</span>
      </div>
      <div class="mt-2 text-[14px] text-ink-200">
        ≈ 连续看 <em class="font-semibold not-italic text-accent-ink">{days} 天</em>
        · <em class="font-semibold not-italic text-accent-ink" data-stat="episodes">{fmtNum(data.episodes)}</em> 集
      </div>

      <div class="mt-5 grid grid-cols-2 gap-x-3 gap-y-3.5 sm:mt-6 sm:flex sm:flex-wrap sm:gap-y-3">
        {#each kpis as k (k.stat)}
          <div class="kpi min-w-0 border-l border-ink-600 pl-3 sm:pr-7">
            <div class="truncate text-[21px] font-bold leading-tight tracking-tight text-ink-100 sm:text-[24px]">
              <span data-stat={k.stat}>{k.v}</span>{#if k.unit}<small class="ml-0.5 text-[13px] font-medium text-ink-400">{k.unit}</small>{/if}
            </div>
            <div class="mt-0.5 truncate text-[12px] text-ink-400">{k.label}</div>
          </div>
        {/each}
      </div>
    </div>

    {#if fan.length}
      <div class="fan mx-auto shrink-0 sm:mx-0" aria-label="评分最高">
        {#each fan as f (f.a.id)}
          <a href="/anime/{f.a.id}" class="fig s{f.slot} cover" title={f.a.title_cn || f.a.title}>
            {#if !f.a.cover_dead && (f.a.picture || f.a.thumbnail)}
              <img src="/cover/{f.a.id}" alt={f.a.title_cn || f.a.title} loading="eager" decoding="async" />
            {/if}
            <!-- 左边两张的右上角被右边那张压住，角标放左上 -->
            <span class="absolute {f.slot < 2 ? 'left-1.5' : 'right-1.5'} top-1.5 rounded-full bg-warm-fill px-1.5 py-0.5 text-[11px] font-bold leading-none text-on-fill">
              ★ {Number(f.a.my_score).toFixed(1)}
            </span>
          </a>
        {/each}
      </div>
    {/if}
  </div>
</section>

<style>
  .hero { --hero-base: var(--c-bg); }
  :global(:root[data-theme='light']) .hero { --hero-base: var(--c-surface); }

  /* 倾斜的封面墙：放大一点再转，四角不露底 */
  .wall {
    position: absolute; inset: -40px; z-index: -2;
    display: grid; grid-template-columns: repeat(8, 1fr); gap: 6px;
    transform: rotate(-6deg) scale(1.12);
  }
  .wall img { width: 100%; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 8px; }
  /* 遮罩：左侧几乎实色保证文字对比度，往右渐透出封面；左下再垫一点主题色的光 */
  .veil {
    position: absolute; inset: 0; z-index: -1;
    background:
      radial-gradient(120% 90% at 0% 100%, color-mix(in srgb, var(--c-accent) 20%, transparent), transparent 60%),
      linear-gradient(100deg,
        color-mix(in srgb, var(--hero-base) 96%, transparent) 30%,
        color-mix(in srgb, var(--hero-base) 74%, transparent) 60%,
        color-mix(in srgb, var(--hero-base) 50%, transparent));
  }
  /* 主数字：正文色 → 强调色的渐变字 */
  .big {
    font-size: 60px; line-height: 0.95; font-weight: 750; letter-spacing: -0.035em;
    background: linear-gradient(120deg, var(--c-text) 35%, var(--c-accent) 115%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }

  /* 扇形封面：容器定宽，5 个槽位按百分比摆，手机上整体缩小 */
  .fan { position: relative; width: 264px; height: 168px; }
  .fig {
    position: absolute; bottom: 0; width: 34%; aspect-ratio: 2 / 3; overflow: hidden; border-radius: 10px;
    box-shadow: 0 14px 30px -10px rgb(0 0 0 / 60%), 0 0 0 1px rgb(255 255 255 / 8%);
    transition: transform 200ms ease-out;
  }
  .fig img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .s0 { left: 0;   transform: rotate(-10deg) translateY(10px); }
  .s1 { left: 16%; transform: rotate(-4deg) translateY(2px); z-index: 1; }
  .s2 { left: 31%; width: 38%; z-index: 3; }
  .s3 { left: 50%; transform: rotate(5deg) translateY(4px); z-index: 2; }
  .s4 { left: 66%; transform: rotate(10deg) translateY(12px); }
  .fig:hover, .fig:focus-visible { transform: translateY(-8px) rotate(0); z-index: 4; }

  @media (max-width: 639px) {
    .wall { grid-template-columns: repeat(5, 1fr); }
    /* 手机上下排版：封面在上、数字在下，遮罩改成上透下实 */
    .veil {
      background:
        radial-gradient(130% 70% at 0% 100%, color-mix(in srgb, var(--c-accent) 20%, transparent), transparent 60%),
        linear-gradient(180deg,
          color-mix(in srgb, var(--hero-base) 50%, transparent) 0%,
          color-mix(in srgb, var(--hero-base) 88%, transparent) 42%,
          color-mix(in srgb, var(--hero-base) 97%, transparent) 62%);
    }
  }
  @media (min-width: 640px) {
    .big { font-size: 76px; }
    .fan { width: 340px; height: 212px; }
    .kpi:first-child { border-left: 0; padding-left: 0; }
  }
</style>
