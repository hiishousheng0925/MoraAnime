/**
 * 预热封面缓存。
 *
 * 平时靠 /cover/[id] 按需缓存就够（41,537 张全下要约 2GB，绝大多数永远不会看到）。
 * 这个脚本用来主动预热你最可能看到的那批：番单里的 + 主流番。
 *
 *   node scripts/warm-covers.js               # 我的番单 + 前 300 部主流番
 *   node scripts/warm-covers.js --limit 2000
 */
import { getDb, initSchema } from '../src/lib/server/db.js';
import { siteUrl, siteUp } from './site-url.js';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? +process.argv[i + 1] : d; };
const LIMIT = arg('--limit', 300);
// 走正在跑的站点，不是 dev server —— 见 site-url.js 里的说明
const BASE = siteUrl();
if (!(await siteUp(BASE))) {
  console.error(`⚠️  站点不可达 ${BASE} —— 跳过封面预热`);
  console.error('   （封面仍会在你浏览时按需缓存，只是少了主动预热）');
  process.exit(0);
}

const db = getDb();
initSchema(db);
const rows = db.prepare(`
  SELECT a.id FROM anime a
  LEFT JOIN (SELECT DISTINCT anime_id FROM user_entry_all) ue ON ue.anime_id = a.id   -- 任何账号番单里的先下
  WHERE a.cover_local_path IS NULL AND a.cover_dead = 0
    AND (a.picture IS NOT NULL OR a.thumbnail IS NOT NULL)
  ORDER BY (ue.anime_id IS NOT NULL) DESC, a.bgm_collection DESC NULLS LAST, a.source_count DESC
  LIMIT ?`).all(LIMIT);

console.log(`🖼  预热 ${rows.length} 张封面（经 ${BASE}/cover/…，命中即落盘）`);
let ok = 0, dead = 0;
for (let i = 0; i < rows.length; i++) {
  try {
    const r = await fetch(`${BASE}/cover/${rows[i].id}`);
    r.ok ? ok++ : dead++;
  } catch { dead++; }
  if ((i + 1) % 25 === 0) process.stdout.write(`\r   ${i + 1}/${rows.length}  成功 ${ok} 死链 ${dead}   `);
  await new Promise((r) => setTimeout(r, 60));
}
const c = (s) => db.prepare(s).get().c;
console.log(`\n✅ 完成：成功 ${ok}，死链 ${dead}`);
console.log(`   累计已缓存 ${c('SELECT count(*) c FROM anime WHERE cover_local_path IS NOT NULL')} 张，` +
            `已标死链 ${c('SELECT count(*) c FROM anime WHERE cover_dead=1')} 条`);
