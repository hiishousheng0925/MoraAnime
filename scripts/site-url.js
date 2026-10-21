/**
 * 定时任务用的「站点地址」。
 *
 * ⚠️ 为什么需要它：warm-covers 原来默认打 http://localhost:5173（dev server），
 * 而每天 04:30 的定时同步跑的时候根本没有 dev server ——
 * 封面预热每天都在静默失败。而且正式站只绑 tailnet 地址，
 * 连 localhost:3000 也不通（实测 HTTP 000）。
 *
 * 优先级：J_ANIME_URL 环境变量 > 正在跑的正式站 > dev server
 */
import { tailscaleIp } from './platform.js';

export function siteUrl() {
  if (process.env.J_ANIME_URL) return process.env.J_ANIME_URL.replace(/\/$/, '');
  const port = process.env.PORT || '3000';
  const ip = tailscaleIp();
  if (ip) return `http://${ip}:${port}`;
  return `http://127.0.0.1:${port}`;
}

/** 站点是否真的在跑 —— 打 /login 而不是 /，因为开了鉴权时 / 会 303 */
export async function siteUp(base) {
  try { return (await fetch(`${base}/login`, { signal: AbortSignal.timeout(5000) })).ok; }
  catch { return false; }
}
