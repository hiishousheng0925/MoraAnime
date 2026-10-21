import { json } from '@sveltejs/kit';
import { importData } from '$lib/server/backup.js';

export async function POST({ request }) {
  try {
    const body = await request.json();
    const stat = importData(body.payload ?? body, { replace: !!body.replace });
    return json({ ok: true, ...stat });
  } catch (e) {
    return json({ error: String(e.message ?? e) }, { status: 400 });
  }
}
