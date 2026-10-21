<script>
  /**
   * 多选 chip 组：一个「全部」+ N 个可切换项。
   *
   * 抽出来的理由：目录页 / 番单页 / 季度浏览各写过一份，番单页还把 toggleIn
   * 的逻辑内联成了一长串三元表达式，三边的空值处理各不相同
   * （`f.types.length` vs `(f.types ?? []).length`）——
   * 改一处筛选行为要找三个文件，且很容易只改到两个。
   *
   * opts 每项是 [值, 显示名] 或 [值, 显示名, 数量]；给了数量就显示在标签后面。
   */
  import Chip from './Chip.svelte';
  import { toggleIn } from '$lib/urlBuild.js';

  let { param, opts, selected = null, isDefault = true, href,
        allLabel = '全部',
        /** 「全部」要写进 URL 的值。缺省 null（去掉该参数）；
         *  当「去掉参数」本身就是某个默认筛选时，传显式值（如 'all'）才能表达「全部」 */
        allValue = null } = $props();

  const cur = $derived(isDefault ? [] : (selected ?? []));
</script>

<div class="flex flex-wrap gap-1.5">
  <Chip on={isDefault} href={href({ [param]: allValue })}>{allLabel}</Chip>
  {#each opts as [v, l, c]}
    {@const only = cur.length === 1 && cur[0] === v}
    <!--
      取消唯一选中的那项 → 直接切到「全部」（allValue）。
      不能让它变成「空选择」：参数从 URL 里消失后，loader 见到没参数就回落到自己的
      默认值（目录页类型默认 TV·剧场版·OVA、完结状态默认三档），
      于是点一下反而多选上两三项。之前是拦住并弹 toast，主人要求改成自动回「全部」。
    -->
    <Chip on={cur.includes(v)}
          href={href({ [param]: only ? allValue : toggleIn(cur, v) })}>
      {l}{#if c != null}<span class="ml-1 text-[11px] text-ink-400">{c}</span>{/if}
    </Chip>
  {/each}
</div>
