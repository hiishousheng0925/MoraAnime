import { json } from '@sveltejs/kit';
import { searchAll, getEpisodes, resolveEpisode } from '$lib/server/sources/index.js';
import { scoreHit, searchKeywords } from '$lib/server/sources/rank.js';
import { watchNames, setWatchPick, recordResolve, embedRates } from '$lib/server/queries.js';
import { currentUid } from '$lib/server/userCtx.js';

/**
 * GET /api/sources?op=search&q=关键词[&id=番剧 id][&expand=1]   带 id 时每条结果附 score（见 rank.js），
 *                                                    每个站附 embed（站内可播比例，没记录为 null）
 *     /api/sources?op=episodes&site=…&url=…
 *     /api/sources?op=resolve&site=…&url=…[&fresh=1]   fresh：跳过解析缓存（「重新加载」）
 */
export async function GET({ url, request }) {
  const q = url.searchParams;
  const op = q.get('op');
  if (op === 'search') {
    // 全角字母数字转半角：「ＣＬＡＮＮＡＤ」→「CLANNAD」，片源站的搜索是字面匹配（#95）。
    // 不用整串 NFKC：它把中文标点「，」也变成「,」，7sefun / DM84 / MXdm / aafun / moonci 就搜不到
    // 「『你们先走我断后』，于是10年后我成为了传说」了
    const kw = (q.get('q') ?? '').replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => c.normalize('NFKC')).trim().slice(0, 100);
    if (!kw) return json({ error: '请输入片名' }, { status: 400 });
    const id = +q.get('id');
    const wants = Number.isInteger(id) && id > 0 ? watchNames(id) : null;
    // expand=1（观看页的自动搜索）：多个关键词并发搜，按站合并、同一链接只留一条（见 rank.js: searchKeywords）
    const kws = wants && q.get('expand') === '1' ? searchKeywords(kw, wants) : [kw];
    const runs = await Promise.all(kws.map((k) => searchAll(k)));
    const results = runs[0].map((r, i) => {
      const seen = new Set();
      const hits = runs.flatMap((run) => run[i].hits).filter((h) => !seen.has(h.url) && seen.add(h.url));
      return { ...r, hits, error: hits.length ? undefined : r.error };
    });
    if (wants) {
      for (const r of results) {
        r.hits = r.hits.map((h) => ({ ...h, score: scoreHit(h.name, wants) }))
          .sort((x, y) => y.score - x.score);
      }
    }
    const rates = embedRates();
    for (const r of results) r.embed = rates[r.site] ?? null;
    return json({ results });
  }
  const site = q.get('site') ?? '', target = q.get('url') ?? '';
  if (op === 'episodes') return json(await getEpisodes(site, target));
  if (op === 'resolve') {
    // request.signal：浏览器换了一集 / 关了页，服务端的解析和排队中的嗅探跟着停（2026-10-21 审核）
    const r = await resolveEpisode(site, target, { fresh: q.get('fresh') === '1', signal: request.signal });
    // 「链接已过期」是我们自己的缓存问题，取消 / 繁忙（transient）也不是这个站的问题，都不算战绩。
    // 战绩是全站共用的排序依据，只认登录账号的解析：访客能随手刷接口把某个站刷成「只能跳转」（2026-10-21 审核）
    if (currentUid() > 0 && !r.transient && (r.url || !/过期/.test(r.error ?? ''))) recordResolve(site, !!r.url);
    return json(r);
  }
  return json({ error: '未知操作' }, { status: 400 });
}

/** POST { op: 'pick', id, site, name, road, manual } —— 记住这部番上次用的片源和线路（manual = 主人手动选的） */
export async function POST({ request }) {
  const b = await request.json();
  if (b.op !== 'pick') return json({ error: '未知操作' }, { status: 400 });
  const id = +b.id, road = +b.road;
  if (!Number.isInteger(id) || id <= 0 || typeof b.site !== 'string' || typeof b.name !== 'string'
      || !b.site || !b.name || b.site.length > 60 || b.name.length > 200
      || !Number.isInteger(road) || road < 0 || road > 50) {
    return json({ error: '参数不对' }, { status: 400 });
  }
  setWatchPick(id, { site: b.site, name: b.name, road, manual: b.manual === true });
  return json({ ok: true });
}
