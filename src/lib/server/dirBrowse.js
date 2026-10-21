/**
 * 设置页「截图保存位置」的「浏览…」：列出服务器这台电脑上的文件夹（只给管理员，见 api/admin/dirs）。
 * 截图存在服务器上，浏览器自己的文件夹选择框选不了服务器的路径，所以由服务端列目录、站内弹窗选
 * （主人 2026-10-21：网站要和客户端一样有「浏览」）。只列文件夹，不碰文件内容。
 */
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const IS_WIN = process.platform === 'win32';
// 系统 / 隐藏目录不列：$Recycle.Bin、System Volume Information 这类点进去也没权限
const SKIP = /^(\$|\.|System Volume Information$|Recovery$|Config\.Msi$|PerfLogs$|node_modules$)/i;
const MAX = 500;

/** 上一级；已经是盘符根 / 根目录时回到「此电脑」（空串） */
const up = (abs) => { const d = dirname(abs); return d === abs ? '' : d; };

/** 常用位置：图片 / 桌面 / 用户目录（存在的才给） */
export function quickPlaces(home = homedir()) {
  return [['图片', join(home, 'Pictures')], ['桌面', join(home, 'Desktop')], ['用户目录', home]]
    .filter(([, p]) => existsSync(p)).map(([name, path]) => ({ name, path }));
}

/** 「此电脑」：Windows 列存在的盘符，其他系统就是根目录 */
function roots() {
  if (!IS_WIN) return [{ name: '/', path: '/' }];
  return 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((p) => existsSync(p))
    .map((p) => ({ name: p.slice(0, 2), path: p }));
}

/**
 * @param {string} p  要打开的文件夹；空串 = 「此电脑」
 * 还不存在的文件夹（比如没截过图的缺省位置）就打开最近的、存在的上级；没有权限的给 denied（不叫 error：
 * 前端的 post() 见到 error 就当请求失败抛出，弹窗就停在空白的「此电脑」上了 —— 实测踩过）
 * @returns {{ path: string, parent: string|null, dirs: {name, path}[], denied?: boolean }}
 */
export function listDirs(p) {
  if (!p) return { path: '', parent: null, dirs: roots() };
  let abs = resolve(String(p));
  while (!existsSync(abs) && up(abs)) abs = up(abs);
  if (!existsSync(abs)) return { path: '', parent: null, dirs: roots() };
  try {
    const dirs = readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP.test(e.name))
      .map((e) => e.name).sort((a, b) => a.localeCompare(b, 'zh'))
      .slice(0, MAX).map((name) => ({ name, path: join(abs, name) }));
    return { path: abs, parent: up(abs), dirs };
  } catch (e) {
    return { path: abs, parent: up(abs), dirs: [], denied: true };
  }
}
