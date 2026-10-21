/**
 * 观看站 URL 模板 → 实际链接。纯字符串替换，不发任何请求。
 *
 * 占位符（详情页按钮和设置页预览共用这一份实现）：
 *   {cn}      中文名   —— 中文站用这个
 *   {ja}      日文原名 —— 日文站用这个
 *   {romaji}  罗马字/英文名 —— 国际站用这个
 *   {title}   界面上显示的那个名字（中文名 → 罗马字 → 日文名）
 *
 * ⚠️ 每个占位符都要能回退。库里可见日本番 26,293 条：罗马字 100%、日文名 98.9%、
 * 中文名只有 54.6% —— {cn} 不回退的话，那 45% 点过去是个空搜索。
 *
 * ⚠️ 值必须 encodeURIComponent。番名里的 ＆ ？ ！ ～ 空格 直接拼进 query string
 * 会把 URL 截断（「Re:ゼロから始める異世界生活」的冒号、「あの日見た花の名前を僕達はまだ知らない。」的句号）。
 */
const PLACEHOLDER_G = /\{(cn|ja|romaji|title)\}/g;

/** 模板是否合法。只允许 http(s) —— 否则 href 里能塞 javascript: */
export const isValidTemplate = (url) => /^https?:\/\/\S+$/i.test(String(url ?? '').trim());

/**
 * @param {string} tpl 模板
 * @param {{title?:string,title_ja?:string,title_cn?:string}} a 番剧
 * @returns {string|null} 链接；模板非法或一个名字都取不到时返回 null（按钮不渲染）
 */
export function watchUrl(tpl, a) {
  if (!isValidTemplate(tpl)) return null;
  const pick = {
    cn: a?.title_cn || a?.title || a?.title_ja,
    ja: a?.title_ja || a?.title || a?.title_cn,
    romaji: a?.title || a?.title_ja || a?.title_cn,
    title: a?.title_cn || a?.title || a?.title_ja
  };
  let ok = true;
  const url = String(tpl).trim().replace(PLACEHOLDER_G, (_, k) => {
    const v = pick[k];
    if (!v) { ok = false; return ''; }
    return encodeURIComponent(v);
  });
  return ok ? url : null;
}
