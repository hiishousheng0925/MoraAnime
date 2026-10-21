<script>
  /**
   * 站内的文件夹选择框（设置页截图位置的「浏览…」，网站用；桌面客户端走系统的选择框）。
   * 列的是服务器上的文件夹（/api/admin/dirs）。桌面居中对话框、手机底部抽屉，和 Confirm.svelte 同一套写法。
   */
  import Sheet from './Sheet.svelte';
  import { media } from '$lib/media.svelte.js';
  import { post } from '$lib/api.js';
  import { toast } from '$lib/toast.svelte.js';
  import Folder from 'phosphor-svelte/lib/Folder';
  import HardDrive from 'phosphor-svelte/lib/HardDrive';
  import ArrowUp from 'phosphor-svelte/lib/ArrowUp';

  let { open = false, start = '', onpick, oncancel } = $props();
  const PLACE = 'rounded-full border border-ink-600 bg-ink-900 px-3 py-1 text-[12.5px] text-ink-200 transition hover:border-ink-400';

  let cur = $state({ path: '', parent: null, dirs: [], quick: [] });
  let busy = $state(false);
  async function go(path) {
    busy = true;
    try {
      const r = await post('/api/admin/dirs', { path });
      if (r.denied) toast.error('没有权限打开这个文件夹');
      cur = r;
    } catch (e) { toast.error(e.message); }
    finally { busy = false; }
  }
  // 每次打开从当前设置的位置开始
  $effect(() => { if (open) go(start); });
</script>

{#snippet content(mobile)}
  <div class="text-[15px] font-medium">选择文件夹</div>
  <div class="mt-3 flex items-center gap-2">
    <button type="button" onclick={() => go(cur.parent ?? '')} disabled={busy || cur.parent === null}
            aria-label="上一级" title="上一级"
            class="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-ink-600 bg-ink-900 text-ink-200 disabled:opacity-40">
      <ArrowUp size={15} />
    </button>
    <div class="min-w-0 flex-1 truncate rounded-lg bg-ink-900 px-3 py-2 font-mono text-[12.5px] text-ink-200" title={cur.path}>
      {cur.path || '此电脑'}
    </div>
  </div>
  {#if cur.quick?.length}
    <div class="mt-2 flex flex-wrap gap-1.5">
      {#each cur.quick as q (q.path)}
        <button type="button" onclick={() => go(q.path)} class={PLACE}>{q.name}</button>
      {/each}
      <button type="button" onclick={() => go('')} class={PLACE}>此电脑</button>
    </div>
  {/if}
  <div class="mt-3 overflow-y-auto rounded-lg border border-ink-700 bg-ink-900 {mobile ? 'max-h-[45dvh]' : 'h-72'}" aria-busy={busy}>
    {#each cur.dirs as d (d.path)}
      <button type="button" onclick={() => go(d.path)}
              class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-ink-200 hover:bg-ink-800">
        {#if cur.path}<Folder size={16} weight="fill" class="shrink-0 text-warm" />{:else}<HardDrive size={16} class="shrink-0 text-ink-400" />{/if}
        <span class="truncate">{d.name}</span>
      </button>
    {:else}
      <div class="px-3 py-6 text-center text-[13px] text-ink-400">{busy ? '…' : '没有子文件夹'}</div>
    {/each}
  </div>
  <div class={mobile ? 'mt-4 grid grid-cols-2 gap-2' : 'mt-4 flex justify-end gap-2'}>
    <button type="button" onclick={() => oncancel?.()}
            class="rounded-lg border border-ink-600 bg-ink-900 px-3.5 py-2 text-[13px] text-ink-200 {mobile ? 'h-11 text-[14px]' : ''}">取消</button>
    <button type="button" onclick={() => onpick?.(cur.path)} disabled={!cur.path || busy}
            class="rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-on-accent disabled:opacity-40 {mobile ? 'h-11 text-[14px]' : ''}">选择此文件夹</button>
  </div>
{/snippet}

<svelte:window onkeydown={(e) => open && !media.mobile && e.key === 'Escape' && oncancel?.()} />

{#if media.mobile}
  <Sheet {open} label="选择文件夹" onclose={() => oncancel?.()}>
    <div class="pt-1">{@render content(true)}</div>
  </Sheet>
{:else if open}
  <div class="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 p-4"
       role="presentation" onclick={() => oncancel?.()}>
    <div role="dialog" aria-modal="true" aria-label="选择文件夹" onclick={(e) => e.stopPropagation()}
         class="card w-full max-w-lg rounded-xl p-4">
      {@render content(false)}
    </div>
  </div>
{/if}
