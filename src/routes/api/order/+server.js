import { json } from '@sveltejs/kit';
import { moveInSeries, resetSeriesOrder } from '$lib/server/queries.js';

export async function POST({ request }) {
  const b = await request.json();
  try {
    if (b.op === 'reset') return json({ ok: true, changed: resetSeriesOrder(+b.id) });
    if (b.op === 'up' || b.op === 'down')
      return json({ ok: true, changed: moveInSeries(+b.id, b.op) });
    return json({ error: 'unknown op' }, { status: 400 });
  } catch (e) {
    return json({ error: String(e.message ?? e) }, { status: 400 });
  }
}
