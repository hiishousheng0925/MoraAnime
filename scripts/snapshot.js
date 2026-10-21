/**
 * 把同步 / 迁移要用的源码拍一份快照进产物目录：<build>/.sync/{scripts,src/lib}。
 *
 * ⚠️ 为什么需要（#38）：定时同步和启动前的迁移原来直接跑【工作区】里的 scripts/ 和
 * src/lib/server/ —— 改到一半、还没发布的去重 / schema / 迁移代码，当晚 04:30 就作用到
 * 正式库上，发布闸门完全拦不住。快照跟着产物目录走：release 换 build/ 时它一起换，
 * 回滚时一起回滚；正式站的同步只跑「已发布」的那份。
 *
 * 快照里的脚本经 <build>/.sync/scripts → 上溯到项目根的 node_modules 解析依赖；
 * 数据目录由调用方显式给 J_ANIME_DATA（run-app / run-sync 都会设），不靠相对路径推算。
 */
import { cpSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function snapshotSync(root, buildDir) {
  const dst = join(buildDir, '.sync');
  rmSync(dst, { recursive: true, force: true });
  for (const d of ['scripts', 'src/lib'])
    cpSync(join(root, d), join(dst, d), { recursive: true });
  cpSync(join(root, 'package.json'), join(dst, 'package.json'));   // "type": "module"
  if (!existsSync(join(dst, 'scripts/sync-all.js'))) throw new Error('快照不完整');
  return dst;
}
