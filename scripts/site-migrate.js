/**
 * 一次性切换：把开发目录的 data\ 迁到 <站点>\data\，用仓库现有的 build\（正式站正在跑的那版）组装成
 * 第一个 release，建 current。只在切换那一次跑；之后发布一律 npm run release。
 *
 * 前提（主控手动做，本脚本只检查）：正式站已停 —— 放 hold、停计划任务、按 PID 杀掉 node。
 * 端口还有人在听就拒绝。测试站也要先停（npm run staging:stop）：它在写 dev.db，复制到一半会对不上。
 *
 * 数据只【复制 + 校验】，不删除原 data\（主控确认无误后自己改名为 data.migrated-<日期>）：
 *   · j-anime.db 先 PRAGMA wal_checkpoint(TRUNCATE) 再复制，比对 sha256
 *   · 全目录比对文件数、总字节、逐个文件大小
 *   · *.db-shm 不复制（共享内存索引，运行时重建）；app.hold 不复制（停旧站时放的，带过去新看门狗就起不来）
 *   · 遇到链接直接停（不跟进去也不复制）
 *
 * 顺序：先组装第一个版本并离线自检（用旧库的只读副本），过了才动数据 —— 前面失败时站点目录还是空的，修好直接重跑。
 *
 * 用法：
 *   node scripts/site-migrate.js [--from <旧 data 目录>] [--build <旧 build 目录>]
 *   站点目录取 J_ANIME_SITE（环境变量 → ~/.j-anime.env → 缺省 Desktop\dev\j-anime-site）
 *   正式站端口取 PORT，测试站端口取 STAGING_PORT（沙盒演练用环境变量覆盖）
 */
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envValue } from '../src/lib/server/envFile.js';
import { pidOnPort } from './platform.js';
import * as site from './site.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const FROM = resolve(arg('--from', join(ROOT, 'data')));   // lint-datapath-ok: 搬家的来源就是旧布局的仓库 data/
const BUILD = resolve(arg('--build', join(ROOT, 'build')));
const PORT = envValue('PORT') || '3000';
const STAGING_PORT = process.env.STAGING_PORT || '3001';
const SELFTEST_PORT = Number(arg('--selftest-port', 3099));
const P = site.sitePaths();

let n = 0;
const step = (t) => console.log(`\n\x1b[1m━━━ ${++n}. ${t}\x1b[0m`);
const ok = (t) => console.log(`   ✓ ${t}`);
const die = (msg) => { console.error(`\n❌ ${msg}\n   已停止。原 data\\ 没有被改动。\n`); process.exit(1); };

console.log('站点迁移');
console.log(`   旧数据   ${FROM}`);
console.log(`   旧产物   ${BUILD}`);
console.log(`   站点目录 ${P.site}`);

// ───────────────────────── 1. 前提 ─────────────────────────
step('检查前提');
if (!existsSync(join(FROM, 'j-anime.db'))) die(`${FROM} 里没有 j-anime.db`);
if (!existsSync(join(BUILD, 'index.js'))) die(`${BUILD} 不是完整产物（没有 index.js）`);
if (!existsSync(join(BUILD, '.sync', 'scripts', 'migrate.js')))
  die(`${BUILD} 里没有源码快照 .sync\\（新布局的启动脚本只跑快照里的 migrate.js）`);
const rel = relative(ROOT, P.site);
if (!rel.startsWith('..') && !isAbsolute(rel))
  die(`站点目录不能在仓库里面：${P.site}`);
if (pidOnPort(PORT).length) die(`端口 ${PORT} 还有进程在听（PID ${pidOnPort(PORT).join(',')}）—— 先停正式站`);
ok(`正式站端口 ${PORT} 没有监听`);
if (pidOnPort(STAGING_PORT).length) die(`测试站端口 ${STAGING_PORT} 还有进程在听 —— 先 npm run staging:stop（它在写 dev.db）`);
ok(`测试站端口 ${STAGING_PORT} 没有监听`);
if (existsSync(P.data) && readdirSync(P.data).length) die(`${P.data} 已存在且不为空，拒绝覆盖`);
if (existsSync(P.current) || site.isLink(P.current)) die(`${P.current} 已存在`);
if (site.listReleases(P).length) die(`${P.releases} 里已经有版本了`);
ok('站点目录是空的');

// ───────────────────────── 2. 组装第一个版本 ─────────────────────────
step(`用 ${BUILD} 组装第一个版本`);
const sha = site.gitSha(ROOT);
const name = site.releaseName(sha);
let dir;
try {
  dir = site.assembleRelease({ root: ROOT, buildDir: BUILD, P, name, sha, sourceHash: null });
} catch (e) { die(`组装失败（半成品已删）：${e.message}`); }
ok(name);

// ───────────────────────── 3. 离线自检 ─────────────────────────
step(`离线自检（旧库的只读副本 → :${SELFTEST_PORT}）`);
const st = await site.selfTest(dir, { dbSrc: join(FROM, 'j-anime.db'), port: SELFTEST_PORT });
if (!st.ok) { site.safeRmTree(dir, P.releases); die(`离线自检没过，已删掉 ${name}：\n${st.error}`); }

// ───────────────────────── 4. checkpoint ─────────────────────────
step('合并 WAL（PRAGMA wal_checkpoint(TRUNCATE)）');
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(FROM, 'j-anime.db'));
  const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  db.close();
  if (r.busy) die(`checkpoint 被挡住（busy=${r.busy}）—— 还有进程开着库`);
  const wal = join(FROM, 'j-anime.db-wal');
  if (existsSync(wal) && statSync(wal).size > 0) die(`checkpoint 后 WAL 仍有 ${statSync(wal).size} 字节`);
  ok(`checkpoint 完成（log=${r.log} checkpointed=${r.checkpointed}），WAL 为空`);
}

// ───────────────────────── 5. 复制 ─────────────────────────
step(`复制 ${FROM} → ${P.data}`);
const skip = (name) => /-shm$/.test(name) || name === 'app.hold';
/** 列出目录下所有文件 [相对路径, 大小]；遇到链接直接停 */
function listFiles(base) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) die(`遇到链接 ${p} —— 不跟进去，请手动处理后重跑`);
      if (st.isDirectory()) walk(p);
      else if (!skip(e)) out.push([relative(base, p), st.size]);
    }
  };
  walk(base);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
const src = listFiles(FROM);
const total = (l) => l.reduce((s, [, b]) => s + b, 0);
console.log(`   源：${src.length} 个文件，${(total(src) / 1048576).toFixed(1)} MB`);
mkdirSync(P.data, { recursive: true });
mkdirSync(P.releases, { recursive: true });
let done = 0;
for (const [rel] of src) {
  const to = join(P.data, rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(FROM, rel), to);
  if (++done % 2000 === 0) console.log(`   …${done}/${src.length}`);
}

// ───────────────────────── 6. 校验 ─────────────────────────
step('校验');
const dst = listFiles(P.data);
if (dst.length !== src.length) die(`文件数不一致：源 ${src.length}，目标 ${dst.length}`);
if (total(dst) !== total(src)) die(`总字节不一致：源 ${total(src)}，目标 ${total(dst)}`);
for (let i = 0; i < src.length; i++)
  if (src[i][0] !== dst[i][0] || src[i][1] !== dst[i][1]) die(`文件不一致：${src[i][0]}（${src[i][1]}）vs ${dst[i][0]}（${dst[i][1]}）`);
ok(`文件数 ${dst.length}、总字节 ${total(dst)}、逐个大小一致`);
const sha256 = (f) => new Promise((res, rej) => {
  const h = createHash('sha256');
  createReadStream(f).on('data', (b) => h.update(b)).on('end', () => res(h.digest('hex'))).on('error', rej);
});
const [a, b] = await Promise.all([sha256(join(FROM, 'j-anime.db')), sha256(join(P.data, 'j-anime.db'))]);
if (a !== b) die(`j-anime.db sha256 不一致：${a} vs ${b}`);
ok(`j-anime.db sha256 ${a}`);

// ───────────────────────── 7. current ─────────────────────────
step('建 current');
site.pointCurrent(P, name);
site.recordHistory(P, name, 'migrate');
ok(`${P.current} → ${site.currentRelease(P)}`);

console.log(`
✅ 迁移完成。原 ${FROM} 没动，确认站点正常后再改名为 data.migrated-<日期>。
   接下来（见 deploy/README-windows.md「切换到站点目录」）：
   1. ~/.j-anime.env 加两行：J_ANIME_DATA=${P.data}   J_ANIME_SITE=${P.site}
   2. powershell -File deploy\\install-site.ps1     （重新注册 j-anime-app / j-anime-sync 并拉起）
   3. 确认站点活着：这一版是原来的产物，还没有 /api/health（看门狗会退回打 /login）；
      下一次 npm run release 之后 /api/health 才可用
`);
