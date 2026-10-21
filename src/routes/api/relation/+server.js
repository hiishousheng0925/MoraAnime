import { json } from '@sveltejs/kit';
import { linkAnime, unlinkAnime, listAnime } from '$lib/server/queries.js';

export async function POST({ request }) {
  const b = await request.json();
  try {
    switch (b.op) {
      case 'link':   linkAnime(+b.id, +b.other); break;
      case 'unlink': unlinkAnime(+b.id, +b.other); break;
      case 'search': {
        const { rows } = listAnime({ q: b.q, requireYear: false }, { limit: 8, sort: 'popular' });
        return json({ ok: true, rows: rows.filter((r) => r.id !== +b.id) });
      }
      default: return json({ error: 'unknown op' }, { status: 400 });
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e.message ?? e) }, { status: 400 });
  }
}
