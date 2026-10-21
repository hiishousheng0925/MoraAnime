/**
 * 清掉 cover_dead 标记，让封面重新抓一次。
 *
 * 为什么需要：旧版的封面代理「抓取失败一律标死链」，断网时翻一页目录就把那一屏
 * 全标成死链，恢复联网后服务端直接 404，怎么刷新都不会再试（实测正式库 225 条）。
 * 代理已经改成只在 404/403/非图片/内容过小时才标死，但历史误标得手动清。
 *
 * 用法：node scripts/reset-cover-dead.js [--dry]
 */
import { getDb } from '../src/lib/server/db.js';

const dry = process.argv.includes('--dry');
const db = getDb();
const W = 'cover_dead = 1 AND (picture IS NOT NULL OR thumbnail IS NOT NULL)';
const n = db.prepare(`SELECT count(*) c FROM anime WHERE ${W}`).get().c;
console.log(`有图片地址却被标成死链的 ${n} 条${dry ? '（--dry，不写库）' : ''}`);
if (!dry && n) {
  db.prepare(`UPDATE anime SET cover_dead = 0 WHERE ${W}`).run();
  console.log(`✔ 已清掉标记，下次访问会重新抓一次`);
  console.log(`  剩余 cover_dead=1（确实没有图片地址的）${db.prepare('SELECT count(*) c FROM anime WHERE cover_dead=1').get().c} 条`);
}
