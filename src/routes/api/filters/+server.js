import { json } from '@sveltejs/kit';
import { addFilter, delFilter, listFilters, setDefaultFilter, getDefaultFilter }
  from '$lib/server/queries.js';

export async function POST({ request }) {
  const b = await request.json();

  // 设为默认 / 回到系统默认（id 为 null 或 0）
  if (b.op === 'default') {
    setDefaultFilter(b.id ? +b.id : null);
    return json({ ok: true, filters: listFilters() });
  }
  if (b.op === 'del') {
    // 删掉的正好是默认那套时，默认自动回落到系统默认 —— is_default 跟着行一起删就是这个效果
    delFilter(+b.id);
    return json({ ok: true, filters: listFilters(), fellBack: !getDefaultFilter() });
  }
  if (!b.name?.trim()) return json({ error: '请填名字' }, { status: 400 });
  addFilter(b.name.trim(), b.query ?? '');
  return json({ ok: true, filters: listFilters() });
}
