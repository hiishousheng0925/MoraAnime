import { redirect } from '@sveltejs/kit';
import { safeNext } from '$lib/server/auth.js';

/**
 * 原来的独立登录页（2026-10-19 起登录改成弹窗）。旧书签 / 旧链接还会打到这里：
 * 送回原来要去的页面并自动弹出登录框（+layout.svelte 认 ?login）。
 */
export function GET({ url }) {
  const to = safeNext(url.searchParams.get('to'));
  redirect(303, `${to}${to.includes('?') ? '&' : '?'}login=1`);
}
