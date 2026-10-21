<script>
  /** 手动补关联。AOD 有 43.8% 的条目没有任何关系数据，靠这个补。 */
  import { dispTitle } from '$lib/format.js';
  import { invalidateAll } from '$app/navigation';
  let { animeId, links = [] } = $props();

  let open = $state(false);
  let kw = $state('');
  let rows = $state([]);
  let busy = $state(false);

  async function api(body) {
    busy = true;
    try {
      return await fetch('/api/relation', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: animeId, ...body }) }).then((r) => r.json());
    } finally { busy = false; }
  }
  async function search() {
    if (!kw.trim()) { rows = []; return; }
    const r = await api({ op: 'search', q: kw.trim() });
    rows = r.rows ?? [];
  }
  const link = async (id) => { await api({ op: 'link', other: id }); kw = ''; rows = []; await invalidateAll(); };
  const unlink = async (id) => { await api({ op: 'unlink', other: id }); await invalidateAll(); };
</script>

<div class="text-[12px]">
  <button onclick={() => (open = !open)} class="text-accent">
    {open ? '收起' : '手动关联'}{#if links.length}（{links.length}）{/if}
  </button>

  {#if open}
    <div class="mt-2 card rounded-lg p-3">
      {#if links.length}
        <div class="mt-2 space-y-1">
          {#each links as l (l.id)}
            <div class="flex items-center gap-2">
              <a href="/anime/{l.id}" class="min-w-0 flex-1 truncate text-[13px] hover:text-accent">
                {dispTitle(l)} <span class="text-ink-400">{l.year ?? ''}</span>
              </a>
              <button onclick={() => unlink(l.id)} disabled={busy}
                      class="shrink-0 text-[11px] text-ink-400 hover:text-danger">移除</button>
            </div>
          {/each}
        </div>
      {/if}
      <form onsubmit={(e) => { e.preventDefault(); search(); }} class="mt-2 flex gap-2">
        <input bind:value={kw} placeholder="搜要关联的番…"
               class="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-800 px-2 py-1.5 text-[13px]
                      outline-none placeholder:text-ink-400 focus:border-accent" />
        <button class="rounded-md border border-ink-600 bg-ink-900 px-3 py-1.5 text-[12px] text-ink-200" disabled={busy}>搜</button>
      </form>
      {#if rows.length}
        <div class="mt-2 space-y-1">
          {#each rows as r (r.id)}
            <button onclick={() => link(r.id)} disabled={busy}
                    class="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-ink-800">
              <span class="min-w-0 flex-1 truncate text-[13px]">{dispTitle(r)}</span>
              <span class="shrink-0 text-[11px] text-ink-400">{r.year ?? ''} {r.type}</span>
              <span class="shrink-0 text-[11px] text-accent">＋关联</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
