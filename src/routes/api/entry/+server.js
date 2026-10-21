import { json } from '@sveltejs/kit';
import { setEntry, bumpEpisode, clearEntry } from '$lib/server/queries.js';
// 写进来的值必须先校验（issue #11），规则和备份导入共用
import { ENTRY_CHECK as CHECK, isInt, isId, normScore } from '$lib/server/entryRules.js';

const bad = (msg) => json({ error: msg }, { status: 400 });

export async function POST({ request }) {
  const b = await request.json();
  if (!isId(b.id)) return bad('no id');
  if (b.op === 'clear') { clearEntry(b.id); return json({ ok: true, entry: null, cleared: true }); }
  if (b.op === 'bump') {
    const delta = b.delta ?? 1;
    if (!isInt(delta, -1000, 1000)) return bad('delta 必须是整数');
    return json({ ok: true, entry: bumpEpisode(b.id, delta) });
  }
  const patch = {};
  // is_vague 不收前端的：它只由服务端按「是不是快速标记建的、动没动过」判断
  for (const k of Object.keys(CHECK)) {
    if (b[k] === undefined) continue;
    if (!CHECK[k](b[k])) return bad(`${k} 取值不合法`);
    patch[k] = k === 'my_score' ? normScore(b[k]) : b[k];
  }
  return json({ ok: true, entry: setEntry(b.id, patch) });
}
