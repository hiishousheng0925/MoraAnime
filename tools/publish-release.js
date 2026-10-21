#!/usr/bin/env node
/**
 * 发布客户端：建 GitHub release v<版本>（正式版、latest），上传安装包 / 便携版 / 自动更新文件 latest.yml，
 * 再传一份不带版本号的副本（releases/latest/download/MoraAnime-Setup.exe 永远是最新版）。
 * 正文顶部的「更新内容」和客户端更新弹窗是同一份（desktop/release-notes.json）。
 *
 *   node desktop/build.js --dist && node tools/publish-release.js
 *
 * 授权用 git credential（GCM 里 hiishousheng0925 的登录），不需要 token 环境变量。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = 'hiishousheng0925/MoraAnime';
const DESK = join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop');
const DIST = join(DESK, 'dist');
const VER = JSON.parse(readFileSync(join(DESK, 'package.json'), 'utf8')).version;
const NOTES = JSON.parse(readFileSync(join(DESK, 'release-notes.json'), 'utf8'))[VER];
if (!NOTES?.length) throw new Error(`desktop/release-notes.json 里没有 ${VER} 的更新内容`);
const r = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\nusername=hiishousheng0925\n\n',
  encoding: 'utf8', env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' } });
const token = r.stdout.match(/^password=(.+)$/m)?.[1];
if (!token) throw new Error('拿不到 hiishousheng0925 的授权');
const H = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
const api = (p, init = {}) => fetch(`https://api.github.com/repos/${REPO}${p}`, { ...init, headers: { ...H, ...init.headers } });

const body = [
  `## MoraAnime ${VER}`,
  '',
  'Windows 桌面追番客户端：番剧资料、搜索、放送表、排行、番单、快速标记、统计，以及**在本机**解析片源和播放。',
  '',
  '### 更新内容',
  ...NOTES.map((l) => l.replace(/^•\s*/, '- ')),
  '',
  '### 下载',
  '固定下载链接（永远是最新版）：https://github.com/hiishousheng0925/MoraAnime/releases/latest/download/MoraAnime-Setup.exe',
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

let rel = await api(`/releases/tags/v${VER}`);
if (rel.status === 404) {
  rel = await api('/releases', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag_name: `v${VER}`, target_commitish: 'main', name: `MoraAnime ${VER}`, body, prerelease: false, make_latest: 'true' }) });
}
if (!rel.ok) throw new Error(`建 release 失败 ${rel.status} ${await rel.text()}`);
const release = await rel.json();
// 固定文件名的副本：https://github.com/<repo>/releases/latest/download/MoraAnime-Setup.exe 永远指向最新版（latest.yml 仍指带版本号的那份，自动更新不受影响）
const files = [[`MoraAnime-Setup-${VER}.exe`], [`MoraAnime-Setup-${VER}.exe.blockmap`], ['latest.yml'], [`MoraAnime-${VER}-portable.exe`],
  [`MoraAnime-Setup-${VER}.exe`, 'MoraAnime-Setup.exe'], [`MoraAnime-${VER}-portable.exe`, 'MoraAnime-portable.exe']];
for (const [src, name = src] of files) {
  for (const a of (release.assets ?? []).filter((x) => x.name === name)) await api(`/releases/assets/${a.id}`, { method: 'DELETE' });
  const buf = readFileSync(join(DIST, src));
  const t0 = Date.now();
  const up = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    { method: 'POST', body: buf, headers: { ...H, 'content-type': 'application/octet-stream', 'content-length': String(buf.length) } });
  if (!up.ok) throw new Error(`上传 ${name} 失败 ${up.status} ${await up.text()}`);
  console.log(`⬆ ${name}  ${(buf.length / 1048576).toFixed(1)} MB  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
console.log('✅', release.html_url);
