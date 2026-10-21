/**
 * 预计算 anime.is_nsfw。判定口径与取舍的完整理由见 src/lib/genres.js 的 NSFW_TAGS 注释。
 * 一句话：只认 `hentai` 和 `18 restricted` —— 其余标签描述剧情内容而非分级，会误杀主流番。
 * 另加 Bangumi Archive 自带的 nsfw 标记（anime.bgm_nsfw，scripts/ingest-bgm.js 写入）。
 */
import { getDb, initSchema, tx } from '../src/lib/server/db.js';
import { NSFW_TAGS } from '../src/lib/genres.js';

const db = getDb();
initSchema(db);
const ph = NSFW_TAGS.map(() => '?').join(',');
let n = 0;
tx(db, () => {
  db.exec('UPDATE anime SET is_nsfw = 0');
  // AOD 标签 OR Bangumi 的 nsfw 标记（#2：bgm 新建的条目没有 AOD 标签，只有 bgm_nsfw）
  n = db.prepare(`UPDATE anime SET is_nsfw = 1 WHERE bgm_nsfw = 1 OR id IN
    (SELECT anime_id FROM anime_tag WHERE tag IN (${ph}))`).run(...NSFW_TAGS).changes;
});
const c = (s) => db.prepare(s).get().c;
console.log(`🔞 标记 NSFW：${n} 条 / 全库 ${c('SELECT count(*) c FROM anime')}`);
console.log('   类型分布：', db.prepare(`SELECT group_concat(type||'='||c,'  ') g FROM
  (SELECT type, count(*) c FROM anime WHERE is_nsfw=1 GROUP BY type ORDER BY c DESC)`).get().g);
const wrong = c(`SELECT count(*) c FROM anime WHERE is_nsfw=1 AND type='TV' AND bgm_collection > 3000`);
console.log(`   误杀检查（高人气 TV 番被标记）：${wrong} 条 ${wrong ? '⚠️' : '✅'}`);
db.prepare(`INSERT INTO sync_log (kind,started_at,finished_at,items,status)
            VALUES ('mark_nsfw',datetime('now'),datetime('now'),?,'ok')`).run(n);
