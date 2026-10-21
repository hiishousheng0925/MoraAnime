/** 客户端 API 封装。重构前 fetch('/api/...') 散在三个页面里各写一遍。 */
import { requireLogin } from './auth.svelte.js';

/** 用户关掉登录框时抛的错：调用方照常 toast 会多一条噪音，所以单独认得出来（见 isCancelled） */
export class LoginCancelled extends Error { constructor() { super('需要登录'); this.cancelled = true; } }

/**
 * 401（没登录 / 会话过期）→ 弹登录框，登录成功后把这次请求原样再发一次（只重试一次）。
 * 于是「想看」「打分」这类按钮访客也能直接点：点 → 登录 → 当场生效。
 * 其他非 JSON 响应（如 500 纯文本）按 HTTP 状态报错。
 */
export async function post(url, body, retried = false) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).catch((e) => ({ error: String(e?.message ?? e) }));
  if ('error' in res) throw new Error(res.error);
  if (res.status === 401 && !retried) {
    if (await requireLogin()) return post(url, body, true);
    throw new LoginCancelled();
  }
  const r = (res.headers.get('content-type') || '').includes('json') ? await res.json() : { error: `HTTP ${res.status}` };
  if (r?.error) throw new Error(r.error);
  return r;
}

export const entry = {
  bump:   (id, delta = 1) => post('/api/entry', { id, op: 'bump', delta }),
  clear:  (id)            => post('/api/entry', { id, op: 'clear' }),
  patch:  (id, patch)     => post('/api/entry', { id, ...patch })
};

export const triage = {
  // scope 里带 yearMin/yearMax —— 返回的新队列要和当前年份筛选一致，
  // 否则提交完一批，画面会跳回「全部年份」那一堆
  submit:       (batch, scope) => post('/api/triage', { batch, limit: 24, ...scope }),
  undo:         (scope) => post('/api/triage', { op: 'undo', limit: 24, ...scope }),
  resetNotSeen: (scope) => post('/api/triage', { op: 'reset-not-seen', limit: 24, ...scope })
};
