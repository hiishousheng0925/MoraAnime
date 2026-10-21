/**
 * 并发闸：同时最多 max 个在跑，多的排队；队列也有上限，满了直接拒绝（err.code = 'BUSY'）。
 * 嗅探（sniff.js，一次开一个浏览器页）和截图（screenshot.js，一次一个 ffmpeg）共用。
 *
 * 为什么队列要有上限（2026-10-21 审核）：原来只限并发不限排队，一屏连点十几集、或者被人刷接口，
 * 队列只增不减，排在后面的早就没人等了还会一个个跑完。
 * 排队中的请求被取消（signal，浏览器断开 / 换了一集）就直接出队，不占后面的位置。
 */
export const busyError = (msg = '解析繁忙，请稍后再试') => Object.assign(new Error(msg), { code: 'BUSY' });

export function limiter(max, maxQueue, { busyMsg, onIdle } = {}) {
  let running = 0;
  const queue = [];
  async function run(fn, signal) {
    signal?.throwIfAborted();
    if (running >= max) {
      if (queue.length >= maxQueue) throw busyError(busyMsg);
      await new Promise((ok, no) => {
        const w = () => { signal?.removeEventListener('abort', drop); ok(); };
        const drop = () => { const i = queue.indexOf(w); if (i >= 0) queue.splice(i, 1); no(signal.reason); };
        signal?.addEventListener('abort', drop, { once: true });
        queue.push(w);
      });
    }
    running++;
    try { return await fn(); } finally { running--; queue.shift()?.(); if (!running) onIdle?.(); }
  }
  return Object.assign(run, { stats: () => ({ running, queued: queue.length }) });
}
