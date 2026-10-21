/**
 * 全局 toast。右下角，从右侧滑入，自动消失，同屏最多 5 条。
 *
 * 重构前有三套并存：SaveFilter 把「已保存」直接印在面板里
 * （命名成「已保存」时出现「已保存「已保存」」）、triage 和 settings
 * 各写了一份居中的 flash、另有三处裸 alert()。
 * 反馈信息只有一个出口，才不会各处乱长。
 */
import { pushCapped } from './toastQueue.js';

let items = $state([]);
let seq = 0;

function push(text, tone) {
  const id = ++seq;
  // 挤掉最旧的：同一条提示连点会一直堆，实测堆到 9 条时从右下角铺到了页面顶部
  items = pushCapped(items, { id, text, tone });
  setTimeout(() => dismiss(id), tone === 'error' ? 6000 : 3200);
}

export const toast = {
  get items() { return items; },
  ok: (text) => push(text, 'ok'),
  // 用户自己关掉了登录框（api.js: LoginCancelled）不算出错，不弹
  error: (text) => { if (!text?.cancelled) push(String(text?.message ?? text), 'error'); }
};
export const dismiss = (id) => { items = items.filter((x) => x.id !== id); };
