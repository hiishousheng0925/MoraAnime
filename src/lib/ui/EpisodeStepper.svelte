<script>
  /** −/+1 进度控件。首页「在看」列表每行一个，是全站最高频的交互（详情页用的是 EpisodeSlider）。 */
  let { onbump, disabled = false, size = 'md' } = $props();
  const S = { md: ['h-9 w-9', 'h-11 w-14 text-base'], lg: ['h-10 w-10 text-lg', 'h-12 w-16 text-lg'] };
</script>

<div class="flex shrink-0 items-center gap-1.5">
  <button onclick={() => onbump(-1)} {disabled} aria-label="减一集"
          class="{S[size][0]} rounded-lg border border-ink-600 bg-ink-900 text-ink-400 active:scale-95 disabled:opacity-50">−</button>
  <button onclick={() => onbump(1)} {disabled} aria-label="加一集"
          class="{S[size][1]} rounded-lg bg-accent font-semibold text-on-accent active:scale-95 disabled:opacity-50">+1</button>
</div>
