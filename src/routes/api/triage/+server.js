import { json } from '@sveltejs/kit';
import { setTriage, triageQueue, triageStats, triageYears, nextBatchId,
         undoLastBatch, resetNotSeen } from '$lib/server/queries.js';
import { getDb, tx } from '$lib/server/db.js';

const VALID = ['seen', 'not_seen', 'never_heard', 'skipped'];

/**
 * 每个写操作都把新的队列/计数一起返回 —— 前端就地替换，不走导航。
 * 范围（年份）必须原样带回去，否则提交完一批会跳回「全部年份」那一堆。
 */
const view = (b) => {
  const scope = { yearMin: b.yearMin, yearMax: b.yearMax };
  return {
    queue: triageQueue({ limit: b.limit ?? 24, ...scope }),
    stats: triageStats(scope),
    years: triageYears()
  };
};

export async function POST({ request }) {
  const b = await request.json();

  if (b.op === 'undo') {
    const r = undoLastBatch();
    return json({ ok: true, ...r, ...view(b) });
  }
  // 原来还有 op:'reset'（整库清空快速标记 + 删掉全部模糊番单），界面上早没入口了，
  // 接口却一直开着 —— 调一次就是 300 条记录。已下线，要放回「没看过」用 reset-not-seen
  // 只把「没看过」放回队列，「看过」的不动 —— 标记时漏掉的那些靠这个找回来
  if (b.op === 'reset-not-seen') {
    const n = resetNotSeen({ yearMin: b.yearMin, yearMax: b.yearMax });
    return json({ ok: true, restored: n, ...view(b) });
  }

  // 批量提交：一屏扫完一次性写入，共用一个 batch_id 以便整批撤销
  if (Array.isArray(b.batch)) {
    const db = getDb();
    const batchId = nextBatchId();
    try {
      tx(db, () => {
        for (const it of b.batch) {
          if (!it?.id || !VALID.includes(it.verdict)) continue;
          setTriage(it.id, it.verdict, batchId);
        }
      });
    } catch (e) {
      return json({ error: String(e.message) }, { status: 500 });
    }
    return json({ ok: true, batchId, ...view(b) });
  }

  if (!b.id || !VALID.includes(b.verdict)) return json({ error: 'bad request' }, { status: 400 });
  setTriage(b.id, b.verdict, nextBatchId());
  return json({ ok: true, stats: triageStats({ yearMin: b.yearMin, yearMax: b.yearMax }), years: triageYears() });
}
