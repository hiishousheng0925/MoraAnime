/**
 * Player.svelte 的纯工具（2026-10-21 从组件里拆出来：组件贴着 400 行上限）
 */

/** 倍速 / 音量 / 超分档位记在 localStorage（单人站的个人偏好，丢了也只是回到默认；隐私模式下读写都可能抛） */
export const store = {
  get: (k, d) => { try { const v = localStorage.getItem(`j-anime.player.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`j-anime.player.${k}`, JSON.stringify(v)); } catch { /* 隐私模式 */ } }
};

/** 秒 → 「m:ss」/「h:mm:ss」 */
export const fmt = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}`;
};

/**
 * 全屏开关：上一次切换没完成就不接新的。连续双击放大缩小几次，客户端整个卡死（2026-10-23 主人报）——
 * 全屏切换是异步的（Electron 里还要改整个窗口），等它的 Promise 落定再冷却 300ms 才放行下一次
 * @param {() => Element | null | undefined} target  要全屏的元素
 */
export function fullscreenToggle(target) {
  let busy = false;
  return () => {
    if (busy) return;
    busy = true;
    Promise.resolve(document.fullscreenElement ? document.exitFullscreen() : target()?.requestFullscreen?.())
      .catch(() => {}).finally(() => setTimeout(() => { busy = false; }, 300));
  };
}
