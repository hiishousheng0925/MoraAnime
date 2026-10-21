<script>
  /** 设置页「备份与恢复」：导出 JSON / CSV、从备份恢复（清空模式先确认）。备份的是当前账号自己的数据 */
  import { PRIMARY, SECONDARY } from './btn.js';
  import Confirm from '$lib/ui/Confirm.svelte';
  import { toast } from '$lib/toast.svelte.js';
  import { post } from '$lib/api.js';
  import { invalidateAll } from '$app/navigation';
  let { total = 0 } = $props();

  let busy = $state(false);
  let replaceMode = $state(false);
  let fileInput;
  let fileName = $state('');

  /**
   * 「导入前清空」原来选中文件就直接清掉四张表、不确认，失败还用成功样式提示（issue #10）。
   * 现在：清空模式先弹确认；服务端清空前会自动留一份备份（结果里带回文件名）。
   */
  let pending = $state(null);   // 等确认的 { payload, name, count }
  const resetPicker = () => { busy = false; fileName = ''; if (fileInput) fileInput.value = ''; };

  async function doImport(e) {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    fileName = file.name;
    let payload;
    try { payload = JSON.parse(await file.text()); }
    catch (err) { toast.error('文件解析失败：' + err.message); resetPicker(); return; }
    const count = payload?.entries?.length ?? 0;
    if (replaceMode) { pending = { payload, name: file.name, count }; return; }
    await runImport(payload);
  }

  async function runImport(payload) {
    pending = null;
    busy = true;
    try {
      // 走 post()：413（文件太大）/ 500 这类非 JSON 响应原来直接 x.json() 炸成「Unexpected token …」（2026-10-22 审查）
      const r = await post('/api/import', { payload, replace: replaceMode });
      // 整站备份里认不出当前账号（用户名、id 都对不上）：原来静默恢复 0 条
      if (r.missingAccount && !r.entries && !r.triage) toast.error('备份里没有这个账号的记录');
      else toast.ok(`已恢复 ${r.entries} 条番单 · ${r.triage} 条标记` +
               (r.unresolved?.length ? ` · ${r.unresolved.length} 条未匹配` : '') +
               (r.safety ? ` · 原记录已备份为 ${r.safety.split(/[\\/]/).pop()}` : ''));
      await invalidateAll();
    } catch (err) { toast.error('导入失败：' + err.message); }
    finally { resetPicker(); }
  }

</script>

<!-- 设置页「备份与恢复」组的两行（外层卡片 + 分隔线由 SettingsGroup 提供） -->
<div class="flex flex-wrap items-center gap-2 px-4 py-3">
  <span class="mr-auto text-[13px] text-ink-200">导出</span>
  <a href="/api/export" download class={PRIMARY}>备份 JSON</a>
  <a href="/api/export?format=csv" download class={SECONDARY}>CSV</a>
</div>

<div class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
  <span class="text-[13px] text-ink-200">恢复</span>
  <label class="flex items-center gap-1.5 text-[12px] text-ink-400">
    <input type="checkbox" bind:checked={replaceMode} class="accent-[var(--c-accent)]" />
    导入前清空现有记录
  </label>
  {#if fileName}<span class="min-w-0 truncate text-[12px] text-ink-400">{fileName}</span>{/if}
  <!-- 原生 file input 的按钮文字由系统语言决定（会显示 Choose file），
       所以隐藏它，用自己的中文按钮触发 -->
  <input bind:this={fileInput} type="file" accept=".json,application/json"
         onchange={doImport} disabled={busy} class="sr-only" id="import-file" />
  <label for="import-file"
         class="ml-auto cursor-pointer {SECONDARY} {busy ? 'pointer-events-none text-ink-400' : ''}">选择备份文件</label>
</div>
<Confirm open={!!pending} danger confirmLabel="清空并导入"
         title="清空现有 {total} 条番单"
         body="改为导入 {pending?.name} 里的 {pending?.count} 条，原记录先自动备份"
         onconfirm={() => runImport(pending.payload)}
         oncancel={() => { pending = null; resetPicker(); }} />
