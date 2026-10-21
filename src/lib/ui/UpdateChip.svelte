<script>
  /**
   * 桌面客户端（MoraAnime）顶栏右上角的「有新版本」提示（主人 2026-10-21）。
   * 尺寸和顶栏的 .chip 一样（那个样式只在 +layout.svelte 里生效，子组件用不上，所以这里写全）。
   * 只在 data.desktop 时由根布局渲染；更新状态来自客户端 preload 暴露的 window.mora
   * （网站没有 window.mora，这个组件什么也不显示）。点一下重新打开更新弹窗 —— 关掉弹窗后它一直留在这里提醒。
   */
  import { onMount } from 'svelte';
  import ArrowCircleUp from 'phosphor-svelte/lib/ArrowCircleUp';

  let version = $state(null);
  onMount(() => window.mora?.onUpdate?.((v) => { version = v; }));
</script>

{#if version}
  <button type="button" onclick={() => window.mora?.openUpdate?.()} title="新版本 {version}"
          class="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg bg-accent/15 px-2.5 text-[12.5px] text-accent-ink transition hover:bg-accent/25 active:scale-[.97]">
    <ArrowCircleUp size={15} weight="fill" class="text-accent" /><span class="max-sm:hidden">有新版本</span><b class="font-semibold tabular-nums">{version}</b>
  </button>
{/if}
