import { json } from '@sveltejs/kit';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getDb } from '$lib/server/db.js';

/**
 * GET /api/health —— 看门狗（站点目录 bin/service.ps1）每 60 秒打一次，release.js 切换后也打它。
 *
 * 为什么不再打 /login：2026-10-21 jsdom 被误删，/login 照样 200，只有 /api/sources 500 了约 20 分钟。
 * 所以这里把「运行时必须在的东西」逐项真查一遍：
 *   · 库能查（打不开 / 被换成空库都会失败）
 *   · jsdom 能加载、而且文件此刻还在磁盘上 —— Node 会把 import 的结果（成功或失败）缓存在进程里，
 *     光 import 一次看不出依赖目录后来被删 / 被改名，所以每次再按解析出的路径确认一遍
 * 失败返回 503。只回检查项名和错误码，不回路径、账号之类的信息（访客可读）。
 */
const RELEASE = (() => {
  try { return JSON.parse(readFileSync(join(process.cwd(), 'RELEASE.json'), 'utf8')).name || 'dev'; }
  catch { return 'dev'; }
})();

const req = createRequire(import.meta.url);

async function check() {
  getDb().prepare('SELECT 1 FROM anime LIMIT 1').get();
  try { await import('jsdom'); }
  catch (e) { throw Object.assign(new Error('jsdom'), { code: e?.code || 'LOAD_FAILED' }); }
  // 片源抓取模块（/api/sources 用的那条链，静态 import 了 jsdom）。它在依赖缺失时加载失败，
  // Node 会把这个失败缓存在进程里 —— 依赖装回来它也不会好，只能重启；这里如实反映出来，看门狗才会去重启
  try { await import('$lib/server/sources/scrape.js'); }
  catch (e) { throw Object.assign(new Error('jsdom'), { code: `SOURCES_${e?.code || 'LOAD_FAILED'}` }); }
  let main;
  try { main = req.resolve('jsdom'); }
  catch (e) { throw Object.assign(new Error('jsdom'), { code: e?.code || 'RESOLVE_FAILED' }); }
  if (!existsSync(main)) throw Object.assign(new Error('jsdom'), { code: 'MISSING_ON_DISK' });
}

export async function GET() {
  const at = new Date().toISOString();
  try {
    await check();
    return json({ ok: true, release: RELEASE, at }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    const what = e?.message === 'jsdom' ? 'jsdom' : 'db';
    return json({ ok: false, release: RELEASE, error: `${what}: ${e?.code || 'ERROR'}`, at },
      { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
