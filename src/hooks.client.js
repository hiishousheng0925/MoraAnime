/**
 * 把浏览器里的异常送到服务端日志，见 routes/api/client-error/+server.js。
 * 只观测、不干预：任何一步失败都静默放过，绝不让上报本身影响页面。
 */
const send = (kind, message, stack) => {
  try {
    const body = JSON.stringify({
      kind, message: String(message ?? ''), stack: stack ? String(stack) : '',
      url: location.pathname + location.search
    });
    // sendBeacon 不阻塞、页面卸载时也能发出去；不可用时退回 fetch
    if (navigator.sendBeacon?.('/api/client-error', new Blob([body], { type: 'application/json' }))) return;
    fetch('/api/client-error', { method: 'POST', body, keepalive: true,
      headers: { 'Content-Type': 'application/json' } }).catch(() => {});
  } catch { /* 上报失败就算了 */ }
};

/** SvelteKit 自己捕获的（load 出错、渲染出错、水合出错） */
export function handleError({ error, event }) {
  send('kit', error?.message ?? error, error?.stack);
  return { message: '页面出错了' };
}

if (typeof window !== 'undefined') {
  // SvelteKit 捕不到的：事件处理器里抛的、Promise 没接的
  addEventListener('error', (e) => send('window', e.message, e.error?.stack));
  addEventListener('unhandledrejection', (e) => send('rejection', e.reason?.message ?? e.reason, e.reason?.stack));
}
