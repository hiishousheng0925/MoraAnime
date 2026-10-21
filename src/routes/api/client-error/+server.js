import { json } from '@sveltejs/kit';

/**
 * 客户端报错收口 —— 浏览器里的异常写进服务端日志（data/app.err.log）。
 *
 * 为什么需要：这个项目的排查盲区一直是「客户端响应式/水合出错」。
 * e2e 走 HTTP，只看得到 SSR 的结果；实测已经栽过三次：
 *   · 局部变量 state 撞 $state rune —— 题材面板点了没反应，编译只给 warning
 *   · $effect 裸同步 data —— 点「下一批」卡片不换
 *   · 设置页水合报错 —— SSR 完整（19KB）但浏览器里整页空白
 * 前两次都是主人反复报、我反复猜才定位。有了这个，报错直接进日志。
 *
 * 约束：
 *   · 只记录，绝不影响页面（前端用 sendBeacon，失败就算了）
 *   · 限流：同一条消息 60 秒内只记一次，避免死循环把日志刷爆
 *   · body 有大小上限，字段截断 —— 这是个能被浏览器随便调的入口
 *   · 鉴权由 hooks.server.js 统一管，这里不再单独判
 */
const RATE = new Map();
const WINDOW_MS = 60_000;
const MAX_BODY = 8 * 1024;
const cut = (v, n) => (v == null ? '' : String(v).slice(0, n));

export async function POST({ request }) {
  let b;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ ok: false }, { status: 413 });
    b = JSON.parse(raw);
  } catch { return json({ ok: false }, { status: 400 }); }

  const msg = cut(b?.message, 300);
  if (!msg) return json({ ok: true });

  const now = Date.now();
  for (const [k, t] of RATE) if (now - t > WINDOW_MS) RATE.delete(k);
  if (RATE.has(msg)) return json({ ok: true, deduped: true });
  RATE.set(msg, now);

  console.error(
    `\n[客户端报错] ${cut(b?.url, 200)}\n` +
    `  类型 ${cut(b?.kind, 40)}\n` +
    `  消息 ${msg}\n` +
    (b?.stack ? `  栈\n${cut(b.stack, 2000).split('\n').map((l) => '    ' + l).join('\n')}\n` : '')
  );
  return json({ ok: true });
}
