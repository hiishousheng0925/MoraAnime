#!/usr/bin/env node
/**
 * 导出番剧库数据包（给 MoraAnime 客户端首次启动 / 每日更新用）。
 *
 *   node tools/export-catalog.js [--src <j-anime.db>] [--out <目录>] [--publish] [--keep 7]
 *
 * 数据来源：上游网站（j-anime）每天同步好的 SQLite 库。
 *   --src  缺省 = 环境变量 / ~/.j-anime.env 里的 J_ANIME_DATA 下的 j-anime.db
 *   --out  缺省 = %LOCALAPPDATA%\MoraAnime-export（非 Windows：~/.cache/moraanime-export）
 *
 * ⛔ 源库是正在跑的网站的正式库：只用 readOnly 连接做一次 VACUUM INTO 拷出副本，
 *    之后所有操作都在副本上。不 checkpoint、不写源库（只读连接本身也写不了）。
 *
 * 副本上：清空账号 / 会话 / 个人数据 / 站点设置 / 白名单 / 观看站（清单见 desktop/catalog-tables.js），
 * 抹掉同步日志里的错误信息（可能带本机路径）和封面本地缓存路径，VACUUM，brotli 压缩，
 * 生成 catalog.json（版本 = 日期、sha256、大小、上游同步时间）。
 *
 * 发布到 GitHub Releases（--publish）缺省不执行，需要：
 *   MORA_GITHUB_REPO    owner/repo
 *   MORA_GITHUB_TOKEN   有 contents:write 权限的 token；不设时向 git 凭据管理器要 repo 所属账号（owner）的授权
 *                       （git push 登录过一次就有；计划任务以同一个 Windows 用户运行，取得到）
 * 发布到一个固定的 tag「catalog」（预发布版，免得占掉应用自动更新用的 latest），
 * 资产：catalog.json + catalog-<版本>.db.br，旧版本的数据包只留 --keep 份。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { createBrotliCompress, constants as Z } from 'node:zlib';
import { CLEAR_ON_EXPORT, PERSONAL_ALL, ACCOUNT_TABLES, LOCAL_CONFIG } from '../desktop/catalog-tables.js';
import { envValue } from '../src/lib/server/envFile.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(k);

const dataDir = envValue('J_ANIME_DATA');
const SRC = resolve(opt('--src', process.env.MORA_EXPORT_SRC || (dataDir ? join(dataDir, 'j-anime.db') : '')));
const OUT = resolve(opt('--out', process.env.MORA_EXPORT_OUT
  || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'MoraAnime-export') : join(homedir(), '.cache', 'moraanime-export'))));
const KEEP = Math.max(1, Number(opt('--keep', 7)) || 7);
const PUBLISH = flag('--publish');
const QUALITY = Number(opt('--quality', 9));   // brotli 9 + 16MB 窗口：压缩率接近 11，压缩快一个数量级，解压都很快

if (!SRC || !existsSync(SRC)) { console.error(`❌ 找不到源库：${SRC || '（没给 --src，也没有 J_ANIME_DATA）'}`); process.exit(1); }

const t0 = Date.now();
const ms = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

const work = join(tmpdir(), `mora-export-${process.pid}-${Date.now()}`);
mkdirSync(work, { recursive: true });
const COPY = join(work, 'catalog.db');

try {
  // ── 1. 只读拷出副本 ────────────────────────────────────────
  {
    const src = new DatabaseSync(SRC, { readOnly: true });
    try { src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`); } finally { src.close(); }
  }
  console.log(`📋 只读副本 ${mb(statSync(COPY).size)}（${ms()}）`);

  // ── 2. 副本上清个人数据 ─────────────────────────────────────
  const db = new DatabaseSync(COPY);
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const count = (t) => db.prepare(`SELECT count(*) c FROM "${t}"`).get().c;
  const cleared = {};
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  for (const t of CLEAR_ON_EXPORT) {
    if (!has(t)) { cleared[t] = '（无此表）'; continue; }
    cleared[t] = count(t);
    db.exec(`DELETE FROM "${t}"`);
  }
  // 同步日志：留着「上次同步是什么时候」（设置页要显示），错误文本可能带本机路径 → 抹掉
  if (has('sync_log')) db.exec('UPDATE sync_log SET error = NULL');
  // 封面本地缓存路径指的是站主机器上的文件，客户端没有 —— 置空，客户端按需重新拉
  db.exec('UPDATE anime SET cover_local_path = NULL WHERE cover_local_path IS NOT NULL');
  // meta 里只属于那台机器的键（测试副本标记等）
  if (has('meta')) db.exec("DELETE FROM meta WHERE key IN ('test_copy')");
  const syncedAt = has('sync_log')
    ? db.prepare("SELECT max(finished_at) t FROM sync_log WHERE status IS NULL OR status IN ('ok','done','success')").get().t
      ?? db.prepare('SELECT max(finished_at) t FROM sync_log').get().t
    : null;
  db.exec('COMMIT');

  // 自检：清单里的表必须都空（防清单和库对不上）
  const leftover = CLEAR_ON_EXPORT.filter((t) => has(t) && count(t) > 0);
  if (leftover.length) throw new Error(`个人表没清干净：${leftover.join(', ')}`);
  const animeN = db.prepare('SELECT count(*) c FROM anime WHERE is_stub = 0').get().c;
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('VACUUM');
  db.close();
  const dbSize = statSync(COPY).size;
  console.log(`🧹 已清空：${Object.entries(cleared).map(([t, n]) => `${t}=${n}`).join(' ')}`);
  console.log(`   VACUUM 后 ${mb(dbSize)}，可见番剧 ${animeN} 部（${ms()}）`);

  // ── 3. 压缩 + 哈希 ────────────────────────────────────────
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const version = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}`;
  const file = `catalog-${version}.db.br`;
  const tc = Date.now();
  await pipeline(createReadStream(COPY), createBrotliCompress({ params: {
    [Z.BROTLI_PARAM_QUALITY]: QUALITY, [Z.BROTLI_PARAM_LGWIN]: 24, [Z.BROTLI_PARAM_SIZE_HINT]: dbSize } }),
    createWriteStream(join(work, file)));
  const brSize = statSync(join(work, file)).size;
  const sha256 = await hashFile(join(work, file));
  const dbSha256 = await hashFile(COPY);
  console.log(`🗜  brotli q${QUALITY}：${mb(dbSize)} → ${mb(brSize)}（${(brSize / dbSize * 100).toFixed(1)}%，压缩 ${((Date.now() - tc) / 1000).toFixed(1)}s）`);

  const manifest = {
    format: 1, version, file, compression: 'br', sha256, size: brSize,
    db: { sha256: dbSha256, size: dbSize, anime: animeN },
    syncedAt, exportedAt: now.toISOString()
  };

  // ── 4. 输出到本机目录 ──────────────────────────────────────
  mkdirSync(OUT, { recursive: true });
  // 临时目录可能在另一块盘上（rename 跨盘会 EXDEV）：先拷到目标目录的临时名，再同盘改名
  copyFileSync(join(work, file), join(OUT, file + '.part'));
  renameSync(join(OUT, file + '.part'), join(OUT, file));
  writeFileSync(join(OUT, 'catalog.json'), JSON.stringify(manifest, null, 2) + '\n');
  // 本地只留最近 KEEP 份数据包
  const packs = readdirSync(OUT).filter((f) => /^catalog-[\d.]+\.db\.br$/.test(f)).sort().reverse();
  for (const f of packs.slice(KEEP)) rmSync(join(OUT, f), { force: true });
  console.log(`📦 ${join(OUT, file)}\n   ${join(OUT, 'catalog.json')}`);
  console.log(`✔ 导出完成，总耗时 ${ms()}`);
  console.log(JSON.stringify({ ...manifest, personalTablesChecked: [...PERSONAL_ALL, ...ACCOUNT_TABLES, ...LOCAL_CONFIG] }));

  // ── 5. 发布（缺省不跑）────────────────────────────────────
  if (PUBLISH) await publish(OUT, file, manifest);
  else console.log('ℹ 未发布（加 --publish 并配置 MORA_GITHUB_TOKEN / MORA_GITHUB_REPO 才会上传到 GitHub Releases）');
} finally {
  rmSync(work, { recursive: true, force: true });
}

async function hashFile(f) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(f)) h.update(chunk);
  return h.digest('hex');
}

/** 向 git 凭据管理器要 github.com 上某个账号的授权（不弹窗：GCM_INTERACTIVE=never）；拿不到返回 null */
function credentialToken(user) {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=github.com\nusername=${user}\n\n`, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' }
  });
  return r.status === 0 ? (r.stdout.match(/^password=(.+)$/m)?.[1] ?? null) : null;
}

/** 上传到 GitHub Releases 固定 tag「catalog」（预发布，不影响应用自动更新读的 latest） */
async function publish(dir, file, manifest) {
  const repo = process.env.MORA_GITHUB_REPO;
  if (!repo) throw new Error('--publish 需要 MORA_GITHUB_REPO（owner/repo）');
  const token = process.env.MORA_GITHUB_TOKEN || credentialToken(repo.split('/')[0]);
  if (!token) throw new Error(`--publish 需要 MORA_GITHUB_TOKEN，或者先用 ${repo.split('/')[0]} 账号 git push 登录一次`);
  const TAG = process.env.MORA_CATALOG_TAG || 'catalog';
  const api = (p, init = {}) => fetch(`https://api.github.com/repos/${repo}${p}`, { ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...init.headers } });
  let rel = await api(`/releases/tags/${TAG}`);
  if (rel.status === 404) {
    rel = await api('/releases', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag_name: TAG, name: '番剧库数据包', prerelease: true, body: '每日自动更新的番剧库（MoraAnime 客户端启动时自动下载）。' }) });
  }
  if (!rel.ok) throw new Error(`取 / 建 release 失败 HTTP ${rel.status} ${await rel.text()}`);
  const release = await rel.json();
  const assets = release.assets ?? [];
  const upload = async (name, body, type) => {
    for (const a of assets.filter((x) => x.name === name)) await api(`/releases/assets/${a.id}`, { method: 'DELETE' });
    const r = await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      { method: 'POST', body, duplex: 'half', headers: { authorization: `Bearer ${token}`, 'content-type': type, 'content-length': String(body.length ?? statSync(join(dir, name)).size) } });
    if (!r.ok) throw new Error(`上传 ${name} 失败 HTTP ${r.status} ${await r.text()}`);
  };
  const { readFileSync } = await import('node:fs');
  // 先传数据包、再传 manifest：客户端只会按 manifest 去找包，顺序反了会有一段时间指向不存在的文件
  await upload(file, readFileSync(join(dir, file)), 'application/octet-stream');
  await upload('catalog.json', Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json');
  // 旧数据包只留 KEEP 份
  const old = assets.filter((a) => /^catalog-[\d.]+\.db\.br$/.test(a.name) && a.name !== file)
    .sort((a, b) => b.name.localeCompare(a.name)).slice(KEEP - 1);
  for (const a of old) await api(`/releases/assets/${a.id}`, { method: 'DELETE' });
  console.log(`🚀 已发布到 ${repo} tag ${TAG}：${file}（删掉旧包 ${old.length} 个）`);
}
