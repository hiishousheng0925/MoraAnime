/// <reference types="@sveltejs/kit" />
/**
 * 离线兜底（#53）：手机上断网 / 信号差时打开站点不再白屏。
 *
 * 缓存三样，名字都带构建版本号（发布后旧缓存整个作废，见 activate）：
 *   · 外壳：构建产物（/_app/immutable/… 带哈希）+ static/ 里的图标、manifest、离线页 —— 安装时一次性缓存
 *   · 页面：HTML 和 __data.json，【先走网络】，成功就存一份；断网时拿最近一次的。最多留 40 条
 *   · 封面：/cover/*，先用缓存，最多留 400 张
 * 都没有就给 /offline.html。
 *
 * ⚠️ 页面缓存为什么也要跟版本走：缓存里的旧 HTML 引用的是旧哈希的 chunk，新版本的外壳缓存里没有，
 *    断网时拿出来会水合失败 → 又是白屏（hooks.server.js 里那次「设置页空白」同一个成因）。
 * ⚠️ 不缓存：/api/*（个人数据、片源、视频流）、非 GET、别的域名。
 * ⚠️ 多账号：页面里有个人数据 —— 登录 / 登出时前端会清掉页面缓存（auth.svelte.js: clearPageCache），
 *    换个人用同一台设备，离线也看不到上一个人的番单。
 * service worker 只在 https 下生效（浏览器规定）：http://IP:3000 那个入口不受影响。
 */
import { build, files, version } from '$service-worker';

const SHELL = `shell-${version}`;
const PAGES = `pages-${version}`;
const COVERS = 'covers-v1';           // 封面和代码版本无关，发布不用作废
const OFFLINE = '/offline.html';
const MAX_PAGES = 40, MAX_COVERS = 400;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll([...build, ...files])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== PAGES && k !== COVERS) await caches.delete(k);
    await self.clients.claim();
  })());
});

/** 超出上限就删最早放进去的（Cache 的 keys() 按放入顺序） */
async function trim(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) await c.delete(k);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // 外壳：缓存里有就直接给（文件名带哈希，不会变）
  if (build.includes(url.pathname) || files.includes(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit ?? fetch(req)));
    return;
  }

  // 封面：先缓存
  if (url.pathname.startsWith('/cover/')) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { const c = await caches.open(COVERS); await c.put(req, res.clone()); trim(COVERS, MAX_COVERS); }
      return res;
    })());
    return;
  }

  // 页面（整页 HTML、客户端跳转用的 __data.json）：先网络，断网用最近一次
  const isPage = req.mode === 'navigate' || url.pathname.endsWith('/__data.json');
  if (!isPage) return;
  e.respondWith((async () => {
    const fallback = async () => {
      const hit = await caches.match(req, { cacheName: PAGES });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await caches.match(OFFLINE)) ?? new Response('离线', { status: 503 });
      return null;
    };
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const c = await caches.open(PAGES);
        await c.put(req, res.clone());
        trim(PAGES, MAX_PAGES);
      }
      // 网关错误也算「连不上」：家里那台电脑关机 / 站点在重启时，tailscale serve 回的是 502 而不是断网
      if (res.status >= 502 && res.status <= 504) return (await fallback()) ?? res;
      return res;
    } catch {
      const r = await fallback();
      if (r) return r;
      throw new Error('offline');
    }
  })());
});
