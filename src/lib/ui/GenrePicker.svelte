<script>
  /**
   * 题材筛选：一份列表，点击循环三态。
   *
   * 原来是 51 个题材铺三遍（必须全部包含 / 至少包含一个 / 排除）= 153 枚胶囊，
   * 面板七百多像素还要滚，选完得滚回去才知道选了什么。
   * 现在一份列表：点一下「包含」（蓝）、再点「排除」（红）、再点取消，
   * 上面一个二选一决定包含方式是「全部满足」还是「任一满足」。
   *
   * URL 参数没变（g / any / ng），所以以前保存的筛选组合和分享链接仍然有效：
   *   包含方式=全部满足 → 写 g；=任一满足 → 写 any；排除一律写 ng。
   * ⚠️ 老链接里 g 和 any 同时有值（「必须有动作 且（爱情或喜剧）」那种组合）时，
   * 这个界面表达不出来 —— 会按「全部满足」把两边并成一份。那种组合极少用，
   * 换来的是面板高度降到 1/3。
   */
  import Chip from './Chip.svelte';

  let { genres = [], any = [], not = [], names = [], counts = null,
        limit = 16,
        /**
         * URL 上的 gm 参数（'or' = 任一满足）。
         * 为什么需要它：包含方式本来是从「值写在 g 还是 any 里」反推的，
         * 可是一个题材都没选时两边都是空 —— 切换模式生成的是同一个 URL，
         * 点了没反应。所以模式要有个独立的落脚点，就用早已存在的 gm。
         * 服务端的 pickGenres 认 gm=or（把 g 挪到 any），语义正好一致。
         */
        gm = null,
        to } = $props();

  let all = $state(false);
  const mode = $derived(gm === 'or' || (any.length && !genres.length) ? 'any' : 'g');
  const inc = $derived(mode === 'any' ? any : genres);
  /**
   * ⚠️ 这个函数一开始叫 state，和 $state 符号撞了 —— Svelte 把 `$state(false)`
   * 当成「订阅名为 state 的 store」，面板一渲染就抛错，表现是「点了没反应」。
   * 编译器只给 warning，构建照样过。别再用 state / derived / effect 当局部名字。
   */
  const pick = (g) => (inc.includes(g) ? 'in' : not.includes(g) ? 'out' : null);
  // gm 跟着模式一起写，选择清空后模式也留得住
  const patch = (i, n) => ({ g: mode === 'g' ? i : null, any: mode === 'any' ? i : null, ng: n,
                             gm: mode === 'any' ? 'or' : null });

  /** 未选 → 包含 → 排除 → 未选 */
  const cycle = (g) => {
    const s = pick(g);
    const i = inc.filter((x) => x !== g);
    const n = not.filter((x) => x !== g);
    return patch(s === null ? [...i, g] : i, s === 'in' ? [...n, g] : n);
  };
  /** 换包含方式：把已选的那一份从一个参数搬到另一个 */
  const switchMode = (m) => ({ g: m === 'g' ? inc : null, any: m === 'any' ? inc : null, ng: not,
                               gm: m === 'any' ? 'or' : null });

  const shown = $derived(all ? names : names.slice(0, limit));
  const active = $derived(inc.length + not.length);
</script>

<div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px]">
  <span class="text-ink-400">包含方式</span>
  <div class="flex gap-1.5">
    <Chip on={mode === 'g'} href={to(switchMode('g'))}>全部满足</Chip>
    <Chip on={mode === 'any'} href={to(switchMode('any'))}>任一满足</Chip>
  </div>
  {#if active}
    <a href={to({ g: null, any: null, ng: null, gm: null })}
       class="ml-auto text-ink-400 hover:text-ink-200">清空 {active} 项</a>
  {/if}
</div>

<div class="flex flex-wrap gap-1.5">
  {#each shown as g}
    {@const s = pick(g)}
    <!-- danger = 排除态（红），accent = 包含态（蓝）；两种态都靠 Chip 的 tone -->
    <Chip tone={s === 'out' ? 'danger' : 'accent'} on={!!s} href={to(cycle(g))}
          title={s === 'in' ? '再点一次改为排除' : s === 'out' ? '再点一次取消' : ''}>
      {#if s === 'in'}<span class="mr-0.5">✓</span>{:else if s === 'out'}<span class="mr-0.5">✕</span>{/if}{g}{#if counts?.[g] != null}<span
        class="ml-1 text-[11px] text-ink-400">{counts[g]}</span>{/if}
    </Chip>
  {/each}
  {#if names.length > limit}
    <button onclick={() => (all = !all)} class="px-1 text-[12px] text-accent">
      {all ? '收起' : `展开全部 ${names.length}`}
    </button>
  {/if}
</div>
