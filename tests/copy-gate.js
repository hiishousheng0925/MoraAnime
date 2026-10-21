/**
 * ⚠️ 安全闸门：e2e / stats-audit / prod-smoke 会 DELETE 番单、快速标记、观看日志。
 * 早先 e2e 直接跑在应用数据库上，把主人的番单清空过一次，不可恢复。
 *
 * 原来只看「J_ANIME_DB 路径里有没有 test/tmp」（#41）：项目一旦放在 D:\tmp\ 或 ~/test/ 下，
 * 正式库路径也满足条件，闸门形同虚设。现在由 scripts/test.js 在复制出来的副本里写一行
 * 随机标记（meta.test_copy），并把同一个值经 TEST_COPY_TOKEN 传进来 —— 两边对得上
 * 才说明打开的确实是 test.js 刚做的那份副本。直接 node tests/e2e.js 拿不到这个值，必然被拒。
 */
import { DatabaseSync } from 'node:sqlite';

export function assertTestCopy(hint = '请用  npm test   （它会自动复制数据库并另起服务器）') {
  const path = process.env.J_ANIME_DB ?? '';
  const token = process.env.TEST_COPY_TOKEN ?? '';
  let mark = null;
  try {
    const d = new DatabaseSync(path, { readOnly: true });
    mark = d.prepare("SELECT value FROM meta WHERE key = 'test_copy'").get()?.value ?? null;
    d.close();
  } catch {}
  if (!token || mark !== token) {
    console.error('\n❌ 拒绝运行：本测试会清空用户数据，必须在 scripts/test.js 做的数据库副本上跑。');
    console.error(`   ${hint}`);
    console.error(`   当前 J_ANIME_DB = ${path || '（未设置）'}\n`);
    process.exit(2);
  }
}
