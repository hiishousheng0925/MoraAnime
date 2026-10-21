import { json } from '@sveltejs/kit';
import { setEntry, bumpEpisode, clearEntry } from '$lib/server/queries.js';
import { WATCH_STATUS } from '$lib/constants.js';

/**
 * 写进来的值必须先校验（issue #11）：这是全库唯一不可再生的数据。
 * 非法 status 会让记录同时从番单筛选和统计口径里静默消失；
 * 字符串 delta 曾被拼成 "0abc" 存进 current_episode。
 */
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
/** 评分 1.0–10.0，最多一位小数（8.4 可以，8.45 不行） */
const isScore = (v) => typeof v === 'number' && v >= 1 && v <= 10 && Math.abs(v * 10 - Math.round(v * 10)) < 1e-9;
const CHECK = {
  status: (v) => Object.hasOwn(WATCH_STATUS, v),
  current_episode: (v) => v === null || isInt(v, 0, 100000),
  my_score: (v) => v === null || isScore(v),
  my_note: (v) => v === null || (typeof v === 'string' && v.length <= 2000)
};
const bad = (msg) => json({ error: msg }, { status: 400 });

export async function POST({ request }) {
  const b = await request.json();
  if (!isInt(b.id, 1, Number.MAX_SAFE_INTEGER)) return bad('no id');
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
    // 8.4 进来可能是 8.399999…，存之前规整到一位小数
    patch[k] = k === 'my_score' && b[k] !== null ? Math.round(b[k] * 10) / 10 : b[k];
  }
  return json({ ok: true, entry: setEntry(b.id, patch) });
}
