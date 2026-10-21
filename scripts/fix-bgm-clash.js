/**
 * 清掉「粒度不符」的 bangumi 放送日期和集数。
 *
 * bgm 的 subject 是整部作品，粒度和 AOD 对不上：AOD 把剧场版、特别篇、OVA 各拆一条，
 * bgm 常常只有 TV 本篇那一个条目。于是 enrich-bgm 会把本篇的放送日期挂到剧场版头上 ——
 *   《幽☆遊☆白書 (映画)》 1 集 → bgm 幽游白书 112 集，air_start 1992-10-10
 *   《劇場版 NINKU ―忍空―》 1 集 → bgm 忍空 55 集，air_start 1995-01-14
 * 名字（幽游白书 / 忍空）用在剧场版上是对的，留着比留罗马音好；日期是错的，
 * 而 fix-status 拿 bgm 日期当事实数据，会把状态推歪：
 *   实测《ドリームログ》(2025 秋, 1 集) 匹到《Dreamland》(2026-10-17, 10 集)，
 *   于是一部 2025 年的番挂着「未上映」角标。
 *
 * 判据和 enrich-bgm 里的 epsClash 一致：两边集数都已知且相差 4 倍以上。
 * 只清 bgm_air_start / bgm_air_end / bgm_eps，不动 bgm_id / 中文名 / 评分。
 * 清空后 fix-status 会退回按季度推导，那条路径是对的。
 *
 * enrich-bgm 现在写库时就不会再存这类日期了，这个脚本是给历史数据兜底，幂等。
 * 用法：node scripts/fix-bgm-clash.js [--dry]
 */
import { getDb } from '../src/lib/server/db.js';

const dry = process.argv.includes('--dry');
const db = getDb();

const CLASH = `coalesce(episodes, 0) > 0 AND coalesce(bgm_eps, 0) > 0
  AND max(episodes, bgm_eps) >= 4 * min(episodes, bgm_eps)
  AND (bgm_air_start IS NOT NULL OR bgm_air_end IS NOT NULL OR bgm_eps IS NOT NULL)`;

const rows = db.prepare(`SELECT id, title, title_ja, title_cn, year, type, episodes, bgm_eps, bgm_air_start
  FROM anime WHERE ${CLASH} ORDER BY source_count DESC`).all();

console.log(`粒度不符、要清掉 bgm 日期的 ${rows.length} 条${dry ? '（--dry，不写库）' : ''}`);
for (const r of rows.slice(0, 10))
  console.log(`  ${String(r.year ?? '?').padEnd(5)} ${String(r.type).padEnd(8)}` +
    ` ${(r.title_cn || r.title_ja || r.title).slice(0, 26).padEnd(28)}` +
    ` ${String(r.episodes).padStart(3)}集 vs bgm ${String(r.bgm_eps).padStart(3)}集   ${r.bgm_air_start ?? ''}`);
if (rows.length > 10) console.log(`  …另外 ${rows.length - 10} 条`);

if (!dry && rows.length) {
  db.prepare(`UPDATE anime SET bgm_air_start = NULL, bgm_air_end = NULL, bgm_eps = NULL
    WHERE ${CLASH}`).run();
  console.log(`✔ 已清 ${rows.length} 条（bgm_id / 中文名 / 评分都留着）`);
}

// 幂等自检：再跑一次应该是 0 条
const left = db.prepare(`SELECT count(*) c FROM anime WHERE ${CLASH}`).get().c;
console.log(`自检：残留 ${left} 条 ${left === 0 || dry ? '✅' : '❌'}`);
