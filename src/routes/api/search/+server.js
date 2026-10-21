import { json } from '@sveltejs/kit';
import { quickSearch, quickDefaults, QUICK_LIMIT } from '$lib/server/queries.js';
import { clientIp } from '$lib/server/auth.js';
import { dispTitle, subTitle } from '$lib/format.js';

/**
 * GET /api/search?q=  —— 顶栏快速搜索面板（QuickSearch.svelte）。访客可读（hooks.server.js: OPEN_READ）。
 *   q 有内容   → { q, total, items }：最多 10 条，口径同目录搜索（见 queries/quicksearch.js）
 *   q 为空     → { q: '', kind: 'recent' | 'hot', items }：登录 = 在看 / 最近动过的，访客 = 本季热门
 * q 截到 100 字。按 IP 限流：10 秒 40 次（输入即搜、防抖 150ms，正常打字远到不了），超了 429。
 * 带「我的状态」→ 不让缓存。
 */
const WINDOW = 10_000;
const MAX_HITS = 40;
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now >= h.until) {
    hits.set(ip, { n: 1, until: now + WINDOW });
    if (hits.size > 2000) for (const [k, v] of hits) if (now >= v.until) hits.delete(k);
    return false;
  }
  return ++h.n > MAX_HITS;
}

const item = (a) => ({
  id: a.id,
  title: dispTitle(a),
  sub: subTitle(a),
  year: a.year,
  season: a.season,
  type: a.type,
  episodes: a.episodes,
  cover: !a.cover_dead && !!(a.picture || a.thumbnail),
  my_status: a.my_status ?? null,
  current_episode: a.current_episode ?? null
});

const NO_STORE = { 'cache-control': 'no-store' };

export function GET(event) {
  if (limited(clientIp(event))) return json({ error: '搜索太频繁，请稍后再试' }, { status: 429, headers: NO_STORE });
  const raw = event.url.searchParams.get('q') ?? '';
  const { q, rows, total } = quickSearch(raw, { limit: QUICK_LIMIT });
  if (!q) {
    const d = quickDefaults(event.locals.user?.id ?? null);
    return json({ q: '', kind: d.kind, items: d.rows.map(item) }, { headers: NO_STORE });
  }
  return json({ q, total, items: rows.map(item) }, { headers: NO_STORE });
}
