/**
 * 在播番的分集每天用 Bangumi API 刷一遍（#47 今天更新 / #49 分集列表）。
 *
 * 周导出（ingest-bgm.js）最多晚一周：新番临时改档、补录分集标题，「今天更新」等不起。
 * 只刷放送表上的番（bgm_weekday 有值，sync-calendar.js 每天重建）—— 一两百部，
 * 串行、每次间隔 300ms，一分钟内跑完。
 * 单部失败不算整步失败（Bangumi 偶尔 5xx）；失败过半才记失败，让同步汇总看得到。
 *
 *   node scripts/sync-episodes.js           # 正常跑
 *   node scripts/sync-episodes.js --dry     # 只看会刷哪些
 */
import { getDb, initSchema, tx } from '../src/lib/server/db.js';
import { upsertEpisodes } from '../src/lib/server/episodes.js';

const UA = 'j-anime/0.1 (personal anime tracker)';
const DRY = process.argv.includes('--dry');
const db = getDb();
initSchema(db);

const subjects = db.prepare(`SELECT DISTINCT bgm_id FROM anime
  WHERE bgm_weekday IS NOT NULL AND bgm_id IS NOT NULL AND is_stub = 0`).all().map((r) => r.bgm_id);
console.log(`🎞  在播 ${subjects.length} 部，刷分集${DRY ? '（--dry，不请求）' : ''}`);
if (DRY) process.exit(0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchAll(id) {
  const out = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const r = await fetch(`https://api.bgm.tv/v0/episodes?subject_id=${id}&type=0&limit=100&offset=${offset}`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    out.push(...(j.data ?? []).map((e) => ({ ...e, subject_id: id })));
    if (out.length >= (j.total ?? 0) || !(j.data ?? []).length) break;
  }
  return out;
}

let ok = 0, failed = 0, eps = 0;
for (const id of subjects) {
  try {
    const list = await fetchAll(id);
    tx(db, () => { eps += upsertEpisodes(db, list); });
    ok++;
  } catch (e) {
    failed++;
    if (failed <= 5) console.warn(`  ⚠️ ${id}: ${e.message}`);
  }
  await sleep(300);
}
console.log(`✅ 刷新 ${ok} 部 · ${eps} 集${failed ? ` · 失败 ${failed} 部` : ''}`);
const bad = subjects.length > 0 && failed > subjects.length / 2;
db.prepare(`INSERT INTO sync_log (kind,started_at,finished_at,items,status,error)
            VALUES ('bgm_episodes',datetime('now'),datetime('now'),?,?,?)`)
  .run(eps, bad ? 'error' : 'ok', failed ? `失败 ${failed} / ${subjects.length}` : null);
if (bad) process.exitCode = 1;
