/**
 * 观看页截图（2026-10-19）：存到设置页配的目录，缺省 ~/Pictures/j-anime。
 *
 * 两条路：
 *   · 浏览器截好的 PNG（m3u8 片源 / 开着超分）—— 直接写盘
 *   · 浏览器截不了的（直连 mp4 跨站不带 CORS，canvas 被污染）—— 服务端用 ffmpeg 在同一时间点截一帧。
 *     只认片源代理发过的 mp4 令牌（stream.js），不接受任意地址；地址照样过 assertPublic
 *
 * 文件名：「番名 第N集 05-12.png」，重名加 (2)、(3)…
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { getSetting } from './queries.js';
import { mp4Target } from './sources/stream.js';
import { assertPublic } from './sources/scrape.js';

export const DEFAULT_SHOT_DIR = join(homedir(), 'Pictures', 'j-anime');
export const shotDir = () => {
  const d = getSetting('screenshot_dir', '');
  return d && isAbsolute(d) ? d : DEFAULT_SHOT_DIR;
};

const clean = (s) => String(s ?? '').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'j-anime';
const stamp = (t) => { const s = Math.max(0, Math.floor(+t || 0)); return `${String(Math.floor(s / 60)).padStart(2, '0')}-${String(s % 60).padStart(2, '0')}`; };

async function freeName(dir, base) {
  for (let i = 1; i < 1000; i++) {
    const f = join(dir, `${base}${i > 1 ? ` (${i})` : ''}.png`);
    try { await access(f); } catch { return f; }
  }
  throw new Error('同名截图太多');
}

/** @returns {Promise<string>} 保存的完整路径 */
export async function saveShot({ title, ep, t, png }) {
  if (!png?.length || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('不是 PNG');
  const dir = shotDir();
  await mkdir(dir, { recursive: true });
  const file = await freeName(dir, `${clean(title)}${ep ? ` 第${+ep}集` : ''} ${stamp(t)}`);
  await writeFile(file, png);
  return file;
}

/** 服务端截一帧并存盘（管理员） */
export async function grabShot({ token, title, ep, t }) {
  return saveShot({ title, ep, t, png: await grabPng({ token, t }) });
}

/** 服务端截一帧：ffmpeg -ss t -i <url> -frames:v 1 → PNG（不存盘，其他账号拿去浏览器下载） */
export async function grabPng({ token, t }) {
  const target = mp4Target(token);
  if (!target) throw new Error('链接已过期，请重新打开这一集');
  await assertPublic(new URL(target.url));
  const png = await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-user_agent', target.ua,
      '-ss', String(Math.max(0, +t || 0)), '-i', target.url, '-frames:v', '1', '-f', 'image2', '-vcodec', 'png', 'pipe:1'],
      { windowsHide: true });
    const chunks = []; let err = '';
    const timer = setTimeout(() => { ff.kill(); reject(new Error('截图超时')); }, 25_000);
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => { err += c; });
    ff.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? '本机没装 ffmpeg' : e.message)); });
    ff.on('close', (code) => { clearTimeout(timer); code === 0 && chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error(err.trim().split('\n').pop() || `ffmpeg 退出 ${code}`)); });
  });
  return png;
}
