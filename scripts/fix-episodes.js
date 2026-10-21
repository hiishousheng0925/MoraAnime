/**
 * 用 bangumi 的集数补上 AOD 缺的 episodes。
 *
 * AOD 对当季新番常常写 episodes=0（还没定/没同步），而 bgm 已经知道是 12 集。
 * 卡片上的「N集」角标、进度条、统计的累计集数、「集数 ≤」筛选、
 * 标「看完」时自动补满 —— 全都读 episodes，写 0 等于这些功能都失效。
 * 实测「相反的你和我」（正反対な君と僕）的 2026 夏季那条就是 episodes=0 / bgm_eps=12。
 *
 * 只补 episodes 为 0 或空、且 bgm 给了正数的那些。幂等。
 * 用法：node scripts/fix-episodes.js [--dry]
 */
import { getDb } from '../src/lib/server/db.js';

const dry = process.argv.includes('--dry');
const db = getDb();
/**
 * ⚠️ 剧场版不接受 3 集以上。
 * bgm 的 subject 是整部作品，剧场版常常匹配到 TV 本篇那一条，
 * 于是本篇的集数被灌到剧场版头上（《战姬绝唱SYMPHOGEAR》剧场版显示 13 集）。
 * 门槛是 >3（1-3 集放行）而不是 >1 —— 确实有分成 2-3 部上映的剧场版，
 * 按一条记 2-3 集是对的。主人定的这个数。
 *
 * 边界上有两条 4 部曲会被判成灌错、清回未知：
 * 《玉响～毕业写真～》和《宇宙战舰大和号2202 爱的战士们「天命篇」》。
 * 要保住它们就把门槛提到 >4。
 */
const W = `coalesce(episodes, 0) = 0 AND bgm_eps > 0
  AND NOT (type = 'MOVIE' AND bgm_eps > 3)`;

const rows = db.prepare(`SELECT id, title, title_cn, year, bgm_eps FROM anime WHERE ${W}
  ORDER BY year DESC, source_count DESC`).all();
console.log(`可补集数的 ${rows.length} 条${dry ? '（--dry，不写库）' : ''}`);
for (const r of rows.slice(0, 10))
  console.log(`  ${String(r.id).padStart(6)} ${r.year} ${(r.title_cn || r.title).slice(0, 34).padEnd(36)} → ${r.bgm_eps} 集`);
if (rows.length > 10) console.log(`  …另外 ${rows.length - 10} 条`);

if (!dry && rows.length) {
  db.prepare(`UPDATE anime SET episodes = bgm_eps WHERE ${W}`).run();
  console.log(`✔ 已补 ${rows.length} 条`);
}

/**
 * 回滚这条脚本早期版本灌错的：没有 >3 这道门槛之前，剧场版拿到了 TV 本篇的集数。
 * 判据是 episodes 恰好等于 bgm_eps —— 那个值就是这条脚本写进去的。
 * 清回 0（未知）比留一个错数字好：卡片角标、进度条、「集数 ≤」筛选都读它。
 */
const BAD = `type = 'MOVIE' AND episodes = bgm_eps AND bgm_eps > 3`;
const bad = db.prepare(`SELECT id, year, title_cn, title_ja, title, episodes FROM anime WHERE ${BAD}`).all();
if (bad.length) {
  console.log(`\n剧场版集数明显灌错、清回未知的 ${bad.length} 条${dry ? '（--dry，不写库）' : ''}：`);
  for (const r of bad)
    console.log(`  ${String(r.id).padStart(6)} ${String(r.year ?? '?').padEnd(5)} `
      + `${String(r.title_cn || r.title_ja || r.title).slice(0, 34).padEnd(36)} ${r.episodes} 集 → 未知`);
  if (!dry) {
    db.prepare(`UPDATE anime SET episodes = 0 WHERE ${BAD}`).run();
    console.log(`✔ 已清 ${bad.length} 条`);
  }
}
