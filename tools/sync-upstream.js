#!/usr/bin/env node
/**
 * 把上游网站仓库（j-anime）的更新同步进来。
 *
 *   node tools/sync-upstream.js --upstream <上游仓库路径> [--to <提交/分支，缺省 main>] [--dry-run]
 *   （上游路径也可以用环境变量 MORA_UPSTREAM 给）
 *
 * 做法：读 UPSTREAM.json 的 commit（上次同步到哪），对上游算 `git diff <commit>..<目标>`，
 * 去掉 excluded 里的路径（网站部署 / 含个人信息的文档），用 `git apply --3way` 打进本仓库；
 * 成功就更新 UPSTREAM.json 的 commit，提交「同步 j-anime <旧>..<新>」，提交说明里列出这段范围内
 * 上游合并的 PR（取自 merge 提交的说明）。
 *
 * 冲突时停下：列出冲突文件，不提交（工作区里留着冲突标记，手动解决后自己提交，并记得改 UPSTREAM.json）。
 *
 * ⛔ 对上游仓库只读：只跑 git diff / log / rev-parse，不 fetch、不切分支、不写任何东西。
 *    要同步更新的上游提交，请先在上游仓库自己 pull。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DRY = argv.includes('--dry-run');
const UP = opt('--upstream', process.env.MORA_UPSTREAM);
const TO = opt('--to', 'main');
if (!UP) { console.error('用法：node tools/sync-upstream.js --upstream <上游仓库路径> [--to main] [--dry-run]'); process.exit(2); }

function git(cwd, args, { allowFail = false, input } = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', input, maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) { console.error(`❌ git ${args.join(' ')}\n${r.stderr}`); process.exit(1); }
  return r;
}

const upFile = join(ROOT, 'UPSTREAM.json');
const meta = JSON.parse(readFileSync(upFile, 'utf8'));
const from = git(UP, ['rev-parse', '--verify', `${meta.commit}^{commit}`]).stdout.trim();
const to = git(UP, ['rev-parse', '--verify', `${TO}^{commit}`]).stdout.trim();
const short = (c) => c.slice(0, 7);
if (from === to) { console.log(`✔ 已经是最新：${short(from)}`); process.exit(0); }
if (git(UP, ['merge-base', '--is-ancestor', from, to], { allowFail: true }).status !== 0) {
  console.error(`❌ ${short(to)} 不是 ${short(from)} 的后续提交（上游改写过历史？）`); process.exit(1);
}

// 排除的路径：目录写成 deploy/，文件写成 CLAUDE.md —— 都转成 git 的 exclude pathspec
const pathspec = ['--', '.', ...meta.excluded.map((p) => `:(exclude)${p.replace(/\/$/, '')}`)];

const changed = git(UP, ['diff', '--name-status', '--no-renames', `${from}..${to}`, ...pathspec]).stdout.trim();
const files = changed ? changed.split('\n') : [];

/** 这段范围内合并的 PR：merge 提交的标题是「Merge pull request #N from 账号/分支」，正文第一行是 PR 标题。
 *  只取编号和标题 —— 账号名、分支名不进本仓库的提交说明 */
function prTitles() {
  const out = git(UP, ['log', '--merges', '--first-parent', '--format=%s%x1f%b%x1e', `${from}..${to}`]).stdout;
  return out.split('\x1e').map((x) => x.trim()).filter(Boolean).map((rec) => {
    const [subject, body = ''] = rec.split('\x1f');
    const num = subject.match(/#(\d+)/)?.[1];
    const title = body.trim().split('\n')[0]?.trim() || '';
    // 没有 PR 编号的合并（本地 merge 分支）：标题里可能带分支名，只留说明正文
    return num ? `#${num} ${title}`.trim() : (title || '（未命名的合并）');
  }).reverse();
}
const prs = prTitles();

console.log(`上游 ${short(from)}..${short(to)}：${files.length} 个文件（已排除 ${meta.excluded.join(' ')}）`);
for (const f of files) console.log(`  ${f}`);
if (prs.length) { console.log('包含的 PR：'); for (const p of prs) console.log(`  ${p}`); }
if (DRY) { console.log('（--dry-run：不改任何文件）'); process.exit(0); }
if (!files.length) {
  // 只有被排除的路径变了：只挪 commit 指针
  meta.commit = to;
  writeFileSync(upFile, JSON.stringify(meta, null, 2) + '\n');
  git(ROOT, ['add', 'UPSTREAM.json']);
  git(ROOT, ['commit', '-q', '-m', `同步 j-anime ${short(from)}..${short(to)}（只有排除路径有变动）`]);
  console.log('✔ 只有排除路径有变动，已更新 UPSTREAM.json');
  process.exit(0);
}

// 本仓库工作区必须干净：冲突时要能分清哪些是同步带来的
const dirty = git(ROOT, ['status', '--porcelain']).stdout.trim();
if (dirty) { console.error(`❌ 工作区不干净，先提交或暂存：\n${dirty}`); process.exit(1); }

const tmp = mkdtempSync(join(tmpdir(), 'mora-sync-'));
const patch = join(tmp, 'upstream.patch');
try {
  // --full-index：--3way 要靠完整的 blob id 找到原版本做三方合并
  writeFileSync(patch, git(UP, ['diff', '--binary', '--full-index', '--no-renames', `${from}..${to}`, ...pathspec]).stdout);
  // 本仓库是全新历史，没有上游的 blob：先把每个改动文件在 from / to 两个版本的内容写进本仓库对象库
  // （hash-object -w，内容寻址、id 和上游一致），--3way 才找得到原版本做三方合并。对上游仍然只读（cat-file）
  let imported = 0;
  for (const line of files) {
    const path = line.split('\t').pop();
    for (const rev of [from, to]) {
      const blob = spawnSync('git', ['-C', UP, 'cat-file', 'blob', `${rev}:${path}`], { maxBuffer: 512 * 1024 * 1024 });
      if (blob.status !== 0) continue;   // 新增 / 删除的文件，那一侧本来就没有
      const w = spawnSync('git', ['-C', ROOT, 'hash-object', '-w', '--stdin'], { input: blob.stdout, encoding: 'utf8' });
      if (w.status !== 0) throw new Error(`写入 blob 失败：${path}@${rev} ${w.stderr}`);
      imported++;
    }
  }
  console.log(`   导入上游 blob ${imported} 个（三方合并用）`);
  const ap = spawnSync('git', ['-C', ROOT, 'apply', '--3way', '--index', '--whitespace=nowarn', patch], { encoding: 'utf8' });
  const conflicts = git(ROOT, ['diff', '--name-only', '--diff-filter=U']).stdout.trim();
  if (ap.status !== 0 || conflicts) {
    console.error(`\n⚠️ 有冲突，已停下（没有提交）。${ap.stderr.trim() ? '\n' + ap.stderr.trim() : ''}`);
    if (conflicts) { console.error('冲突文件：'); for (const f of conflicts.split('\n')) console.error(`  ${f}`); }
    console.error(`\n解决后：把 UPSTREAM.json 的 commit 改成 ${to}，git add 后自己提交。放弃：git reset --hard HEAD`);
    process.exit(3);
  }
  meta.commit = to;
  writeFileSync(upFile, JSON.stringify(meta, null, 2) + '\n');
  git(ROOT, ['add', 'UPSTREAM.json']);
  const msg = [`同步 j-anime ${short(from)}..${short(to)}`, '',
    ...(prs.length ? ['包含的 PR：', ...prs.map((p) => `- ${p}`), ''] : []),
    `改动 ${files.length} 个文件（排除 ${meta.excluded.join(' ')}）`].join('\n');
  git(ROOT, ['commit', '-q', '-F', '-'], { input: msg });
  console.log(`\n✔ 已提交：${git(ROOT, ['log', '-1', '--format=%h %s']).stdout.trim()}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
