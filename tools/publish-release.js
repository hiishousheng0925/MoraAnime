#!/usr/bin/env node
/**
 * 发布客户端：GitHub release v<版本>，上传安装包 / 便携版 / 自动更新文件 latest.yml，
 * 再传一份不带版本号的副本（releases/latest/download/MoraAnime-Setup.exe 永远是最新版）。
 * 正文顶部的「更新内容」和客户端更新弹窗是同一份（desktop/release-notes.json）。
 *
 *   node desktop/build.js --dist && node tools/publish-release.js [--dry-run]
 *
 * 2026-10-22 审查：改成「草稿 → 全部资产传完 → 核对资产齐全 → 才转正式版并标 latest」（tools/github.js
 * publishReleaseAtomic）。原来先建正式版再传 ~400MB，传的几分钟里固定下载链接 404，中途失败则 latest 没有
 * latest.yml、所有客户端检查更新静默失败。中途失败直接重跑即可：草稿接着用，已传完的资产不重传。
 *
 * 仓库：MORA_GITHUB_REPO > git origin > tools/github.js 的 DEFAULT_REPO。
 * 授权：MORA_GITHUB_TOKEN，或 git 凭据管理器里 repo 所属账号的登录（git push 过一次就有）。
 * --dry-run：只核对本地文件、打印要传什么，不联网、不取授权。
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepo, resolveToken, createClient, publishReleaseAtomic } from './github.js';

const DRY = process.argv.includes('--dry-run');
const REPO = resolveRepo();
const DESK = join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop');
const DIST = join(DESK, 'dist');
const VER = JSON.parse(readFileSync(join(DESK, 'package.json'), 'utf8')).version;
const NOTES = JSON.parse(readFileSync(join(DESK, 'release-notes.json'), 'utf8'))[VER];
if (!NOTES?.length) throw new Error(`desktop/release-notes.json 里没有 ${VER} 的更新内容`);

const body = [
  `## MoraAnime ${VER}`,
  '',
  'Windows 桌面追番客户端：番剧资料、搜索、放送表、排行、番单、快速标记、统计，以及**在本机**解析片源和播放。',
  '',
  '### 更新内容',
  ...NOTES.map((l) => l.replace(/^•\s*/, '- ')),
  '',
  '### 下载',
  `固定下载链接（永远是最新版）：https://github.com/${REPO}/releases/latest/download/MoraAnime-Setup.exe`,
  '',
  `- **MoraAnime-Setup-${VER}.exe**（推荐）：安装版，双击安装，之后启动约 1 秒，支持自动更新`,
  `- **MoraAnime-${VER}-portable.exe**：便携版，免安装，每次启动约 20 秒，不自动更新`,
  '',
  '首次启动会自动下载番剧库（约 50MB）。安装包没有代码签名，Windows 可能提示「未知发布者」，点「更多信息 → 仍要运行」即可。',
  '',
  '### 说明',
  '- 本软件不提供、不托管任何视频内容；片源规则来自社区规则仓库，播放在用户本机完成。仅供个人学习交流。',
  '- 番剧资料来自 Bangumi 与 anime-offline-database（ODbL），详见应用内「设置 → 数据来源」。'
].join('\n');

// 固定文件名的副本：https://github.com/<repo>/releases/latest/download/MoraAnime-Setup.exe 永远指向最新版（latest.yml 仍指带版本号的那份，自动更新不受影响）
const plan = [[`MoraAnime-Setup-${VER}.exe`], [`MoraAnime-Setup-${VER}.exe.blockmap`], ['latest.yml'], [`MoraAnime-${VER}-portable.exe`],
  [`MoraAnime-Setup-${VER}.exe`, 'MoraAnime-Setup.exe'], [`MoraAnime-${VER}-portable.exe`, 'MoraAnime-portable.exe']];
// 先在本地核对齐全再联网：缺一个文件就别建草稿了
const lost = [...new Set(plan.map(([src]) => src))].filter((f) => !existsSync(join(DIST, f)));
if (lost.length) throw new Error(`desktop/dist 里缺文件（先 node desktop/build.js --dist）：${lost.join('、')}`);
const files = plan.map(([src, name = src]) => ({ name, size: statSync(join(DIST, src)).size, read: () => readFileSync(join(DIST, src)) }));

if (DRY) {
  console.log(`（--dry-run）${REPO} v${VER}：草稿 → 上传 → 核对 → 发布为 latest`);
  for (const f of files) console.log(`  ${f.name}  ${(f.size / 1048576).toFixed(1)} MB`);
  console.log('\n' + body);
  process.exit(0);
}

const gh = createClient({ repo: REPO, token: resolveToken(REPO) });
const { release, already } = await publishReleaseAtomic(gh, {
  tag: `v${VER}`, name: `MoraAnime ${VER}`, body, target: 'main', files, log: (s) => console.log(s)
});
console.log(already ? 'ℹ' : '✅', release.html_url);
