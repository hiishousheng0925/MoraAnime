import { error } from '@sveltejs/kit';
import { listAnime, myStats } from '$lib/server/queries.js';
import { num, pickPer } from '$lib/server/loaderUtil.js';
import { getDb } from '$lib/server/db.js';
import { asUser } from '$lib/server/userCtx.js';

/** 多账号后每个人有自己的分享链接：按令牌找到分享人，以他的身份读番单（只读） */
export function load({ params, url }) {
  const owner = params.token && params.token.length >= 8 && getDb().prepare(
    "SELECT user_id FROM user_setting WHERE key = 'share_token' AND value = ?").get(params.token)?.user_id;
  if (!owner) throw error(404, '链接无效或已撤销');
  return asUser(owner, () => read(url));
}

function read(url) {
  const s = url.searchParams;
  const status = s.get('status') || 'completed';
  /**
   * 分享的是番单，和「我的番单」一样不受显示年份窗口约束 —— 否则窗口外的番会从分享页消失。
   * 原来一次取 300 条不分页，番单已超过 300 部，多出来的看不到。
   */
  const { per, perIsDefault } = pickPer(s, 24);
  const f = { watch: status, skipYearWindow: true };
  let page = Math.max(1, num(s.get('p')) || 1);
  let { rows, total } = listAnime(f, { limit: per, offset: (page - 1) * per, sort: 'mine' });
  const pages = Math.max(1, Math.ceil(total / per));
  if (page > pages) {
    page = pages;
    ({ rows, total } = listAnime(f, { limit: per, offset: (page - 1) * per, sort: 'mine' }));
  }
  return { rows, total, status, stats: myStats(), page, pages, per, perIsDefault };
}
