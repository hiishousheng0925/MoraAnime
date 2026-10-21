import { json } from '@sveltejs/kit';
import { addWatchSite, updateWatchSite, delWatchSite, toggleWatchSite, moveWatchSite, listWatchSites }
  from '$lib/server/queries.js';

export async function POST({ request }) {
  const b = await request.json();
  const r = b.op === 'edit' ? updateWatchSite(b.id, b.name, b.url)
    : b.op === 'del' ? delWatchSite(b.id)
    : b.op === 'toggle' ? toggleWatchSite(b.id, b.enabled)
    : b.op === 'move' ? moveWatchSite(b.id, b.dir)
    : addWatchSite(b.name, b.url);
  if (r.error) return json(r, { status: 400 });
  return json({ ok: true, sites: listWatchSites() });
}
