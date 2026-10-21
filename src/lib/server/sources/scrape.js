/**
 * 按规则去目标站搜索、取剧集列表。只读，不登录、不提交任何表单。
 *
 * XPath 语义对齐 Kazumi：规则里以 // 开头的表达式，在某个节点上求值时是
 * 「该节点下面」而不是整篇文档 —— 所以要在前面补一个 .
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { JSDOM } from 'jsdom';
import { inOrder } from '../../episodeNo.js';

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = 9000;
const MAX_HTML = 3_000_000;           // 超过 3MB 的页面不是番剧站该有的东西
const MAX_HOPS = 5;

export const headersFor = (rule, referer) => ({
  'user-agent': rule.userAgent || UA,
  referer: referer || rule.referer || rule.baseURL,
  'accept-language': 'zh-CN,zh;q=0.9'
});

/** 别让规则或页面里的链接把服务器引到本机 / 内网（本机上还跑着正式站和数据库） */
const PRIVATE = /^(?:localhost|.*\.local|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|\[?::1?\]?$)/i;
/** IPv6 的回环 / 未指定 / ULA（fc00::/7）/ 链路本地（fe80::/10） */
const PRIVATE6 = /^(?:::1?|f[cd][0-9a-f]{0,2}:.*|fe[89ab][0-9a-f]?:.*)$/i;

/**
 * 解析出来的 IP 是否落在内网。IPv4 映射地址按 IPv4 判 ——
 * 注意 URL 会把 [::ffff:127.0.0.1] 规范化成 [::ffff:7f00:1]，两种写法都要认。
 */
export function privateAddr(ip) {
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  const v4 = hex
    ? [parseInt(hex[1], 16) >> 8, parseInt(hex[1], 16) & 255, parseInt(hex[2], 16) >> 8, parseInt(hex[2], 16) & 255].join('.')
    : ip.replace(/^::ffff:/i, '');
  return isIP(v4) === 4 ? PRIVATE.test(v4) : PRIVATE6.test(ip);
}

/**
 * 每一跳都要过：协议、主机名黑名单、DNS 解析后的 IP。
 * 只查主机名拦不住「解析到内网的域名」；只查第一跳拦不住 302 到 127.0.0.1 / 100.x。
 */
export async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol) || PRIVATE.test(u.hostname)) throw new Error('地址不允许');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(privateAddr)) throw new Error('地址不允许');
}

/** outer：调用方的取消信号（解析限时 / 浏览器断开），和超时合在一起（2026-10-21 审核） */
export async function fetchText(url, rule, referer, outer) {
  const timeout = AbortSignal.timeout(TIMEOUT);   // 整条重定向链共用一个超时
  const signal = outer ? AbortSignal.any([timeout, outer]) : timeout;
  let u = new URL(url);
  for (let hop = 0; ; hop++) {
    await assertPublic(u);
    const res = await fetch(u, { headers: headersFor(rule, referer), redirect: 'manual', signal });
    const loc = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (loc) {
      await res.body?.cancel();
      if (hop >= MAX_HOPS) throw new Error('重定向过多');
      u = new URL(loc, u);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_HTML) throw new Error('页面过大');
    return { text, url: u.href };
  }
}

/** 解析完就关窗口，不然每次请求都漏一个 window（常驻进程会越吃越多） */
function withDoc(html, fn) {
  const { window } = new JSDOM(html);
  try { return fn(window.document); } finally { window.close(); }
}

/** 规则表达式 → 可对某个上下文节点求值的写法 */
const scope1 = (x) => (x.startsWith('/') ? `.${x}` : x);
/**
 * 并集「a | b」每一段都要补：ezdmw 的选集是四段 /self::*… 的并集，原来只补了第一段，
 * 后三段成了从文档根求值，四条线路一集都取不到（#97）。方括号 / 引号里的 | 不算分隔
 */
const scoped = (x) => {
  const parts = []; let depth = 0, quote = null, from = 0;
  for (let i = 0; i < x.length; i++) {
    const c = x[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === '|' && depth === 0) { parts.push(x.slice(from, i)); from = i + 1; }
  }
  parts.push(x.slice(from));
  return parts.map((p) => scope1(p.trim())).join(' | ');
};

function nodes(doc, expr, ctx) {
  const x = expr.trim();
  if (x === '//') return ctx ? [ctx] : [doc.documentElement];   // 「整页就是一条线路」
  try {
    const it = doc.evaluate(ctx ? scoped(x) : x, ctx ?? doc, null, 7, null);   // ORDERED_NODE_SNAPSHOT
    return Array.from({ length: it.snapshotLength }, (_, i) => it.snapshotItem(i));
  } catch { return []; }
}

const textOf = (n) => (n?.nodeType === 2 ? n.value : n?.textContent ?? '').replace(/\s+/g, ' ').trim();
const hrefOf = (n) => (n?.nodeType === 2 ? n.value : n?.getAttribute?.('href')) ?? '';

const abs = (u, base) => { try { return new URL(u, base).href; } catch { return ''; } };
const isLink = (u) => u && !/^(javascript:|#)/i.test(u);

/** 同一部在搜索结果里常出现多次（海报链接 + 标题链接），按链接去重 */
const uniqBy = (list, key) => { const seen = new Set(); return list.filter((x) => !seen.has(x[key]) && seen.add(x[key])); };

/**
 * @returns {Promise<{name:string,url:string}[]>}
 */
export async function search(rule, keyword) {
  const url = rule.searchURL.replace('@keyword', encodeURIComponent(keyword));
  const { text, url: finalUrl } = await fetchText(url, rule);
  const out = withDoc(text, (doc) => nodes(doc, rule.searchList).flatMap((item) => {
    const name = textOf(nodes(doc, rule.searchName, item)[0]);
    const href = hrefOf(nodes(doc, rule.searchResult, item)[0]);
    return name && isLink(href) ? [{ name, url: abs(href, finalUrl) }] : [];
  }));
  return uniqBy(out, 'url').slice(0, 12);
}

/**
 * @returns {Promise<{name:string,eps:{name:string,url:string}[]}[]>} 线路 → 剧集
 */
export async function episodes(rule, detailUrl) {
  const { text, url: finalUrl } = await fetchText(detailUrl, rule);
  return parseEpisodes(rule, text, finalUrl);
}

/** 详情页 HTML → 线路 → 剧集（拆出来单测：#93 倒序、#97 并集 XPath、#99 线路编号） */
export function parseEpisodes(rule, html, pageUrl) {
  // 先去掉空线路再编号：原来先编号后过滤，界面上出现「线路2 / 线路4」（#99）
  return withDoc(html, (doc) => nodes(doc, rule.chapterRoads).map((road) =>
    uniqBy(nodes(doc, rule.chapterResult, road).flatMap((a) => {
      const href = hrefOf(a);
      return isLink(href) ? [{ name: textOf(a) || '播放', url: abs(href, pageUrl) }] : [];
    }), 'url')
  ).filter((eps) => eps.length).map((eps, i) => ({ name: `线路${i + 1}`, eps: inOrder(eps) })));
}

/** 站点主域名：去掉 www. / m. 这类前缀 */
const siteHost = (u) => { try { return new URL(u).hostname.replace(/^(?:www|m|wap)\./i, ''); } catch { return null; } };
/** 地址是不是规则所属站点自己的页面（http(s)、同一个主域名；#91 链接过期后放行用） */
export const sameSite = (rule, u) => /^https?:/i.test(String(u)) && siteHost(u) != null && siteHost(u) === siteHost(rule.baseURL);
