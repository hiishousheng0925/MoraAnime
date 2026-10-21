/**
 * 同步 bgm 每日放送表 → anime.bgm_weekday
 *
 * AOD 离线库差约 2 个月，做不了「本周更新」。
 * bgm 的 /calendar 是实时的，而且原生带中文名。
 * 这也是「按更新时间筛选」的数据来源。
 */
import { getDb, initSchema, tx } from '../src/lib/server/db.js';
import { normTitle } from '../src/lib/server/text.js';

const UA = 'j-anime/0.1 (personal anime tracker)';
const clean = (s) => (s || '').replace(/[（(\[【][^)）\]】]*[)）\]】]/g, ' ')
  .replace(/[「」『』~〜～:：\-—_.,!?！？·・]/g, ' ').replace(/\s+/g, ' ').trim();

const db = getDb();
initSchema(db);

const res = await fetch('https://api.bgm.tv/calendar', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
if (!res.ok) { console.error('❌ bgm calendar HTTP', res.status); process.exit(1); }
const days = await res.json();

/**
 * ⚠️ 必须落到可见条目上（#27）：同一个 bgm_id 可能挂着被折叠的条目（is_stub=1），
 * 原来不加条件取第一条，9 部在播番的星期写到了隐藏条目上，放送表里就没了。
 * 优先可见的；只命中被折叠的那条时，顺着 dup_of 落到它的保留方。
 */
const byBgmId = db.prepare(`SELECT CASE WHEN is_stub = 1 AND dup_of IS NOT NULL THEN dup_of ELSE id END id
  FROM anime WHERE bgm_id = ? ORDER BY is_stub, source_count DESC LIMIT 1`);
const byName = db.prepare(`
  SELECT a.id FROM anime a
  WHERE a.is_stub = 0 AND (a.title_cn = ? OR a.title_ja = ?
        OR EXISTS (SELECT 1 FROM anime_alias al WHERE al.anime_id = a.id AND al.alias = ?))
  LIMIT 1`);
const upd = db.prepare('UPDATE anime SET bgm_weekday = ? WHERE id = ?');
const setBgm = db.prepare('UPDATE anime SET bgm_id = coalesce(bgm_id, ?) WHERE id = ?');

let matched = 0, missed = 0, total = 0;
const misses = [];
tx(db, () => {
  // 清空和重建在同一个事务里：原来清空在事务外，重建中途出错放送表就整个空掉
  db.exec('UPDATE anime SET bgm_weekday = NULL');   // 每次重建，番剧会换档
  for (const day of days) {
    const wd = day.weekday?.id;                    // bgm: 1=周一 … 7=周日
    for (const it of day.items || []) {
      total++;
      let row = byBgmId.get(it.id);
      if (!row) {
        row = byName.get(it.name_cn || '', it.name || '', clean(it.name || ''));
        if (row) setBgm.run(it.id, row.id);
      }
      if (row && wd) { upd.run(wd, row.id); matched++; }
      else { missed++; if (misses.length < 8) misses.push(it.name_cn || it.name); }
    }
  }
});

const WD = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
console.log(`📅 bgm 放送表：${total} 部，匹配上 ${matched}，未匹配 ${missed}`);
if (misses.length) console.log('   未匹配样例:', misses.join(' / '));
console.log('\n各天分布：');
for (const r of db.prepare('SELECT bgm_weekday w, count(*) c FROM anime WHERE bgm_weekday IS NOT NULL GROUP BY w ORDER BY w').all())
  console.log(`   ${WD[r.w]}  ${r.c} 部`);
db.prepare(`INSERT INTO sync_log (kind,started_at,finished_at,items,status)
            VALUES ('bgm_calendar',datetime('now'),datetime('now'),?,'ok')`).run(matched);
