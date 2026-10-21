/**
 * 把「主标题不同但其实是同一部」的重复条目折叠掉。逻辑见 src/lib/server/dedup.js。
 * 幂等。用法：node scripts/fix-dup-alias.js [--dry]
 */
import { getDb } from '../src/lib/server/db.js';
import { findAliasDupes, applyAliasDupes, repairOrphans } from '../src/lib/server/dedup.js';
import { dedupKey } from '../src/lib/server/text.js';

const dry = process.argv.includes('--dry');
const db = getDb();
const pairs = findAliasDupes(db);

console.log(`找到 ${pairs.length} 条重复${dry ? '（--dry，不写库）' : ''}`);
const t = db.prepare('SELECT title, title_cn, year, type FROM anime WHERE id = ?');
for (const p of pairs.slice(0, 15)) {
  const w = t.get(p.winner), l = t.get(p.loser);
  console.log(`  留 ${String(p.winner).padStart(6)} ${(w.title_cn || w.title).slice(0, 26).padEnd(28)}`
    + `折 ${String(p.loser).padStart(6)} ${(l.title_cn || l.title).slice(0, 26).padEnd(28)}(${p.why})`);
}
if (pairs.length > 15) console.log(`  …另外 ${pairs.length - 15} 条`);

if (!dry) {
  if (pairs.length) {
    const r = applyAliasDupes(db, pairs);
    console.log(`✔ 已折叠 ${r.folded} 条，迁移个人记录 ${r.moved} 条`);
  }
  /**
   * 修孤儿要无条件跑，不能挂在 pairs.length 上。
   * 折叠会把某个组的组长折走，让挂在它下面的条目失去归属 —— 那要放回可见；
   * 但失去归属也可能是别的脚本改了 title_ja 造成的（隐藏条目认不出自己的归属者），
   * 而那时候这一轮往往一条新重复都找不到，于是修复被整段跳过，孤儿就一直挂着
   * （实测积压到 49 条，e2e「每条隐藏条目都有对应的可见条目」因此挂红）。
   */
  const back = repairOrphans(db, dedupKey);
  if (back.length) {
    console.log(`↩ ${back.length} 条失去归属，已放回可见：`);
    for (const x of back.slice(0, 8)) console.log(`    ${x.id} ${(x.title_cn || x.title).slice(0, 34)}`);
  }
  console.log(`  非重复条目 ${db.prepare('SELECT count(*) c FROM anime WHERE is_stub=0').get().c}`);
}
