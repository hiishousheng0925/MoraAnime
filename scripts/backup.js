/**
 * 备份我的观看记录到 data/backups/。
 * 元数据能重灌，个人记录不能 —— 所以任何破坏性操作前都该先跑一次。
 * sync-all 里也挂了这个。写文件和清理的逻辑在 src/lib/server/backup.js（导入前的自动备份也用它）。
 */
import { loadEnvFile } from '../src/lib/server/envFile.js';
loadEnvFile();   // 单独跑时也要读到 J_ANIME_BACKUP_MIRROR（见 envFile.js）
const { exportAll, saveBackup, pruneBackups } = await import('../src/lib/server/backup.js');
const { BACKUP_DIR } = await import('../src/lib/server/paths.js');

const KEEP = 30;
const data = exportAll();   // 所有账号 + 公共修正（多账号起，2026-10-19）
const file = saveBackup(BACKUP_DIR, data);
const c = data.counts;
console.log(`💾 已备份 → ${file}`);
console.log(`   账号 ${c.accounts} · 番单 ${c.entries} · 标记 ${c.triage} · 日志 ${c.logs}` +
            ` · 观看站 ${c.watchSites} · 手排顺序 ${c.seriesOrder} · 手动关联 ${c.relations} · 设置 ${c.settings}`);

const n = pruneBackups(BACKUP_DIR, KEEP);
if (n) console.log(`   清理了 ${n} 份旧备份（保留最近 ${KEEP} 份）`);

/**
 * 离机副本。
 *
 * ⚠️ 为什么加这个：data/backups/ 里那 30 份和它要保护的 j-anime.db 在同一块盘上。
 * 盘挂了就是番单、快速标记、观看日志一起没，而这是全库唯一不可再生的数据。
 * 这台 Windows 的 C/D/E 是同一块物理 SSD，镜像到 D 盘等于没镜像。
 *
 * J_ANIME_BACKUP_MIRROR 指到任何一个【不在这块盘上】的目录即可：
 * 外置盘、NAS、同步盘目录（OneDrive 等），或者 tailnet 上另一台机器的共享目录。
 * 写在 ~/.j-anime.env 里（上面的 loadEnvFile 会读到，定时同步也一样）：
 *     J_ANIME_BACKUP_MIRROR=D:\backup\j-anime
 *
 * 镜像失败【不让备份这一步失败】—— 外置盘没插上是常态，
 * 本地那份已经写成功了，没有理由因此让整轮同步挂掉。
 */
const mirror = process.env.J_ANIME_BACKUP_MIRROR;
if (!mirror) {
  console.warn('⚠️  没有离机副本：备份全在 data/backups/，和数据库同一块盘');
  console.warn('    在 ~/.j-anime.env 里设 J_ANIME_BACKUP_MIRROR=<另一块盘上的目录> 即可');
} else {
  try {
    saveBackup(mirror, data);
    const m = pruneBackups(mirror, KEEP);
    console.log(`🛟 离机副本 → ${mirror}${m ? `（清理 ${m} 份）` : ''}`);
  } catch (e) {
    // 只警告不抛：本地备份已经成功，外置盘没插不该拖垮整轮同步
    console.warn(`⚠️  离机副本写失败（本地那份已写好）：${e.message}`);
  }
}
