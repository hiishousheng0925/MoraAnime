/**
 * 本地开发入口。
 *
 * ⚠️ 为什么不直接 `vite dev`：那样开发环境和正式站读写同一个
 * data/j-anime.db —— 在 dev 里点两下标记，改的是你正式站的番单。
 * 这里让 dev 用 data/dev.db（首次自动从正式库复制一份），
 * 正式站的库全程只读一次（复制那一下）。
 *
 * 用法：
 *   node scripts/dev.js              # 用 dev.db，不存在就复制
 *   node scripts/dev.js --fresh      # 重新复制，丢掉 dev.db 里的改动
 *   node scripts/dev.js --live       # 明确要连正式库（排查线上数据时才用）
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../src/lib/server/paths.js';
import { VITE_BIN } from './platform.js';
import { copyDbSnapshot } from './site.js';

const PROD_DB = join(DATA_DIR, 'j-anime.db');
const DEV_DB = join(DATA_DIR, 'dev.db');
const fresh = process.argv.includes('--fresh');
const live = process.argv.includes('--live');
const rest = process.argv.slice(2).filter((a) => !['--fresh', '--live'].includes(a));

if (live) {
  console.log('⚠️  --live：直连正式库，改动会影响正式站');
} else {
  if (!existsSync(PROD_DB)) { console.error(`❌ 找不到正式库 ${PROD_DB}`); process.exit(1); }
  if (fresh && existsSync(DEV_DB)) {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = DEV_DB + suffix;
      if (existsSync(f)) unlinkSync(f);
    }
    console.log('🧹 已删除旧的 dev.db');
  }
  if (!existsSync(DEV_DB)) {
    // 只读连接 + VACUUM INTO（和 npm test、发布自检同一个 copyDbSnapshot）：原来先 checkpoint 再复制文件 ——
    // checkpoint 本身是对正式库的一次写，正式站同时在写时复制出来的文件还可能是撕裂的（2026-10-21 审核）
    await copyDbSnapshot(PROD_DB, DEV_DB);
    console.log(`📋 已从正式库复制 dev.db (${(statSync(DEV_DB).size / 1048576).toFixed(0)} MB)`);
  } else {
    console.log(`📦 用现有 dev.db（想拿正式库最新数据跑 npm run dev:fresh）`);
  }
}

const env = { ...process.env };
if (!live) env.J_ANIME_DB = DEV_DB;
console.log(`🚀 dev  库=${live ? 'j-anime.db（正式）' : 'dev.db'}\n`);

const p = spawn(process.execPath, [VITE_BIN, 'dev', ...rest], { stdio: 'inherit', env });
p.on('exit', (c) => process.exit(c ?? 0));
