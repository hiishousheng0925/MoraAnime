#!/usr/bin/env node
/**
 * 把 static/icon.svg 渲染成客户端图标：desktop/assets/icon.ico（16–256 多尺寸）+ icon.png（256，给安装包 / 窗口用）。
 * 用本机 Chrome / Edge（playwright-core，网站本来就依赖它）。图标改了才需要重跑，产物进仓库。
 *
 *   node tools/make-icon.js
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'desktop', 'assets');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
const exe = [process.env.J_ANIME_CHROME,
  ...pf.map((p) => join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')),
  ...pf.map((p) => join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))].find((p) => p && existsSync(p));
if (!exe) { console.error('找不到 Chrome / Edge'); process.exit(1); }

const svg = readFileSync(join(ROOT, 'static', 'icon.svg'), 'utf8');
const browser = await chromium.launch({ executablePath: exe, headless: true });
const pngs = [];
try {
  // 视口固定 300：太小的视口（16px）无头 Chrome 截图会卡住
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 300, height: 300 } });
  for (const s of SIZES) {
    await page.setContent(`<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', `<svg width="${s}" height="${s}" style="display:block" `)}</body></html>`);
    pngs.push(await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } }));
  }
} finally { await browser.close(); }

// ICO：6 字节头 + 每张 16 字节目录项 + PNG 数据（Vista 起支持 PNG 编码的图标项）
const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(SIZES.length, 4);
const dir = Buffer.alloc(16 * SIZES.length);
let off = 6 + dir.length;
SIZES.forEach((s, i) => {
  const e = i * 16;
  dir.writeUInt8(s >= 256 ? 0 : s, e); dir.writeUInt8(s >= 256 ? 0 : s, e + 1);
  dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(pngs[i].length, e + 8); dir.writeUInt32LE(off, e + 12);
  off += pngs[i].length;
});
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'icon.ico'), Buffer.concat([head, dir, ...pngs]));
writeFileSync(join(OUT, 'icon.png'), pngs[pngs.length - 1]);
console.log(`✔ ${join(OUT, 'icon.ico')}（${SIZES.join('/')}）\n✔ ${join(OUT, 'icon.png')}`);
