import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { COVER_DIR } from '$lib/server/paths.js';
import { isPlaceholderUrl, isPlaceholderBuf } from '$lib/server/coverPlaceholder.js';
import { rememberHue } from '$lib/server/coverHue.js';

/**
 * 封面代理 + 按需磁盘缓存。
 *
 * 为什么不批量下载：41,537 张 × 约 50KB ≈ 2GB，绝大多数你永远不会看到。
 * 改成第一次请求时抓取并落盘，之后直接读本地 —— 只缓存你真正看过的。
 *
 * ⚠️ cover_dead 只能在【确定这个链接坏了】的时候置 1（404/403/410、返回的不是图片、
 * 内容过小）。原来是「抓取失败一律置 1」—— 断网时翻一页目录就把那一屏全标成死链，
 * 恢复联网后服务端直接 404，怎么刷新都不会再试，只能手动清标记。
 * 实测正式库里有 225 条被这样误标。网络类错误（DNS/连接/超时/5xx）返回 503 +
 * no-store，让浏览器和服务端下次都还会重试。
 *
 * 来源按顺序试：picture → thumbnail → Bangumi 封面（有 bgm_id 时）。
 * 各站的「无图」占位图（见 coverPlaceholder.js）不算封面：URL 认得出的直接跳过，
 * 抓回来才认出的丢掉换下一个；都没有真图才标 cover_dead，前端显示自己的占位样式。
 */
const ROOT = COVER_DIR;   // 生产构建后不能用相对路径推算，见 paths.js
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const CACHE = 'public, max-age=31536000, immutable';

export async function GET({ params, fetch, url }) {
  const id = +params.id;
  if (!Number.isInteger(id)) throw error(400, 'bad id');
  const db = getDb();
  const row = db.prepare('SELECT picture, thumbnail, bgm_id, cover_local_path, cover_dead FROM anime WHERE id=?').get(id);
  if (!row) throw error(404, 'not found');
  if (url.searchParams.has('hd')) {
    if (row.bgm_id && !row.cover_dead) {
      const hd = await hdCover(id, row.bgm_id, fetch);
      if (hd) return hd;
    }
    // 没有清晰版就给普通那张，但别让浏览器把它当 ?hd=1 永久缓存（下次清晰版可能就有了）
    const r = await plain(id, row, db, fetch);
    if (r.ok) r.headers.set('Cache-Control', 'public, max-age=86400');
    return r;
  }
  return plain(id, row, db, fetch);
}

/**
 * 清晰版封面（?hd=1，只给详情页头部用）。普通缓存多是 MAL 的 225×318，详情页头部
 * 封面 192px 宽、2 倍屏要 384px，糊。Bangumi 的 common 尺寸是 400px 宽（约 50KB）；
 * large 是原图（1500px+、600KB+），对这个尺寸是浪费。
 * 另存在 COVER_DIR/hd/ 下，不碰普通缓存和 cover_local_path。确定没有（4xx / 不是图 / 占位图）
 * 时落一个 .none 标记，之后直接回退普通封面；网络类错误不留标记，下次再试。
 * 返回 null = 没有清晰版，调用方回退。
 */
const HD_SNIFF = [[[0xff, 0xd8], 'image/jpeg'], [[0x89, 0x50, 0x4e, 0x47], 'image/png'], [[0x52, 0x49, 0x46, 0x46], 'image/webp']];
async function hdCover(id, subjectId, fetch) {
  const base = join(ROOT, 'hd', String(id % 100).padStart(2, '0'), String(id));
  if (existsSync(base)) {
    const buf = await readFile(base);
    const ct = HD_SNIFF.find(([m]) => m.every((b, i) => buf[i] === b))?.[1] ?? 'image/jpeg';
    return new Response(buf, { headers: { 'Content-Type': ct, 'Cache-Control': CACHE } });
  }
  if (existsSync(base + '.none')) return null;
  const none = async () => {
    await mkdir(dirname(base), { recursive: true });
    await writeFile(base + '.none', '');
    return null;
  };
  let res;
  try {
    res = await fetch(`https://api.bgm.tv/v0/subjects/${subjectId}/image?type=common`,
      { headers: { 'User-Agent': 'j-anime/0.1' }, signal: AbortSignal.timeout(8000) });
  } catch { return null; }
  if (res.status >= 500) return null;
  const ct = res.headers.get('content-type') ?? '';
  // 条目没图时 Bangumi 跳到 /img/no_icon_subject.png
  if (!res.ok || !ct.startsWith('image/') || /no_icon/.test(res.url)) return none();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 200 || isPlaceholderBuf(buf)) return none();
  await mkdir(dirname(base), { recursive: true });
  await writeFile(base, buf);
  hueLater(id, buf, true);   // 清晰版是详情页头部实际显示的那张，以它为准
  return new Response(buf, { headers: { 'Content-Type': ct, 'Cache-Control': CACHE } });
}

/**
 * 封面第一次落盘时顺手算主色相（详情 / 观看页按封面换强调色用，见 coverHue.js）。
 * 放到响应发出之后再算：目录一屏几十张封面同时缓存时，不让解码拖慢图片本身
 */
function hueLater(id, buf, force = false) {
  setTimeout(() => { rememberHue(id, buf, force); }, 0);
}

async function plain(id, row, db, fetch) {

  // 已缓存
  if (row.cover_local_path) {
    const abs = join(ROOT, row.cover_local_path);
    if (existsSync(abs)) {
      const ext = row.cover_local_path.split('.').pop();
      return new Response(await readFile(abs), {
        headers: { 'Content-Type': TYPES[ext] ?? 'image/jpeg', 'Cache-Control': CACHE }
      });
    }
  }
  if (row.cover_dead) throw error(404, 'cover unavailable');   // 前端走标题占位，不再重试

  const sources = [...new Set([row.picture, row.thumbnail].filter((u) => u && !isPlaceholderUrl(u)))];
  if (row.bgm_id) sources.push(`https://api.bgm.tv/v0/subjects/${row.bgm_id}/image?type=large`);
  if (!sources.length) {
    db.prepare('UPDATE anime SET cover_dead=1 WHERE id=?').run(id);
    throw error(404, 'no source');
  }

  /** 网络不通/超时/对方 5xx —— 链接本身没坏，别留下永久标记 */
  const transient = (why) => new Response(`cover unavailable: ${why}`,
    { status: 503, headers: { 'Cache-Control': 'no-store' } });

  let lastWhy = 'unknown';
  let flaky = null;
  for (const src of sources) {
    let res;
    try {
      // 超时必须给：断网时 fetch 会挂很久，一屏 60 张就把服务端的连接占满
      res = await fetch(src, { headers: { 'User-Agent': 'j-anime/0.1' }, signal: AbortSignal.timeout(8000) });
    } catch (e) {
      flaky = e?.name === 'TimeoutError' ? 'timeout' : 'network';
      continue;
    }
    if (res.status >= 500) { flaky = `upstream ${res.status}`; continue; }

    // 走到这里才是「这个链接确实坏了」：4xx、返回的不是图片、内容过小、是占位图
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok) { lastWhy = `HTTP ${res.status}`; continue; }
    if (!ct.startsWith('image/')) { lastWhy = `not image: ${ct}`; continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) { lastWhy = 'too small'; continue; }
    if (isPlaceholderBuf(buf)) { lastWhy = 'placeholder'; continue; }

    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
    // 存正斜杠：path.join 在 Windows 上会存成 74\13274.jpg，搬回 Mac / Linux 读不到
    const rel = `${String(id % 100).padStart(2, '0')}/${id}.${ext}`;
    await mkdir(join(ROOT, dirname(rel)), { recursive: true });
    await writeFile(join(ROOT, rel), buf);
    db.prepare('UPDATE anime SET cover_local_path=?, cover_dead=0 WHERE id=?').run(rel, id);
    hueLater(id, buf);
    return new Response(buf, { headers: { 'Content-Type': ct, 'Cache-Control': CACHE } });
  }
  // 有来源只是暂时连不上 —— 不留永久标记，下次再试
  if (flaky) return transient(flaky);
  db.prepare('UPDATE anime SET cover_dead=1 WHERE id=?').run(id);
  throw error(404, `dead: ${lastWhy}`);
}
