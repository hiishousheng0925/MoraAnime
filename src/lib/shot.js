/**
 * 观看页截图（浏览器端）。
 *   · 浏览器给得出 PNG（m3u8 片源 / 开着超分）—— 直接用
 *   · 给不了（直连 mp4 跨站，canvas 被污染）—— 把中转令牌交给服务端用 ffmpeg 截
 * 多账号后（2026-10-19）：只有管理员的截图存到服务器那台电脑（设置页配的目录）；
 * 其他人（含访客）下载到自己的设备 —— 存到主人电脑上对他们没有意义。
 */
import { toast } from './toast.svelte.js';

/** 和服务端存盘同一个命名：「番名 第N集 05-12.png」（见 lib/server/screenshot.js） */
export function shotName(title, ep, t) {
  const s = Math.max(0, Math.floor(t || 0));
  const mm = String(Math.floor(s / 60)).padStart(2, '0'), ss = String(s % 60).padStart(2, '0');
  const name = String(title ?? '').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').trim().slice(0, 80) || 'j-anime';
  return `${name}${ep ? ` 第${ep}集` : ''} ${mm}-${ss}.png`;
}

/**
 * @param {{ blob: Blob|null, t: number, animeId: number, ep: number|null, title: string,
 *           mp4Src: string|null, admin: boolean }} o
 * @returns {Promise<boolean>} 成没成 —— 播放器据此在画面里提示（全屏时全局 toast 看不见）
 */
export async function takeShot({ blob, t, animeId, ep, title, mp4Src, admin }) {
  const token = mp4Src?.match(/\/api\/stream\/([\w-]+)\.mp4$/)?.[1];
  if (!blob && !token) { toast.error('这个片源截不了图'); return false; }
  const download = (b) => {
    const name = shotName(title, ep, t);
    const url = URL.createObjectURL(b);
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast.ok(`截图已下载：${name}`);
    return true;
  };
  try {
    if (!admin && blob) return download(blob);
    const qs = new URLSearchParams({ id: String(animeId), ep: ep ?? '', t: t.toFixed(1) });
    const res = await fetch(`/api/screenshot?${qs}`, blob
      ? { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    // 非管理员：服务端 ffmpeg 截到的 PNG 原样回来
    if ((res.headers.get('content-type') ?? '').startsWith('image/png')) return download(await res.blob());
    const r = await res.json();
    if (r.error) throw new Error(r.error);
    toast.ok(`截图已保存：${r.file.split(/[\\/]/).pop()}`);
    return true;
  } catch (e) { toast.error(e); return false; }
}
