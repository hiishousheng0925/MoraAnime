/**
 * 封面主色相（方案 C 按封面取色，配色见 $lib/coverTint.js）。
 *
 * 存在 anime.cover_hue：NULL = 还没算；-1 = 算过、没有可用的颜色（近黑白封面 / 解不开的格式），别再算；0–359 = 色相。
 * 什么时候算：
 *   · 封面第一次缓存时（cover/[id]/+server.js 抓回来落盘那一刻，顺手算）
 *   · 详情 / 观看页加载时还是 NULL（4 万张存量封面不批量补）→ 读已缓存的封面文件算一次、存起来
 * 都是服务端算好随 SSR 下发，首屏直接是封面色，不会先蓝后变。
 *
 * 解码借 playwright-core 自带的 jpeg-js / pngjs（它本来就是生产依赖，不新增包）。
 * WebP（缓存里约 3%）解不开 → 记 -1，用默认蓝。
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from './db.js';
import { COVER_DIR } from './paths.js';

const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const LIN = Float64Array.from({ length: 256 }, (_, i) => toLin(i));

/** sRGB 0–255 → [L, C, H°]（OKLCH） */
export function okLch(r, g, b) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return [L, Math.hypot(a, bb), (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360];
}

/** 肤色：OKLCH 色相 20–80°（橙红到浅黄之间）、彩度不高、偏亮。人物封面里脸和手臂面积很大，不能让它决定主色 */
export const isSkin = (L, C, H) => H >= 20 && H <= 80 && C < 0.14 && L >= 0.55 && L <= 0.95;

const MIN_C = 0.05;          // 彩度低于这个算灰（白底、黑线、灰阶画面）
const MIN_SHARE = 0.06;      // 有效彩色像素不到 6%：整体是黑白 / 灰的封面 → 不取色
const BINS = 72;             // 5° 一桶

/**
 * 像素 → 主色相（整数度）或 null。
 * 排除灰色（低彩度）、过暗 / 过亮、肤色；剩下的按彩度² 加权进 5° 一桶的色相直方图，
 * 环形平滑后取最重的那桶，再在它 ±20° 内做加权环形平均。
 *   data      RGB(A) 字节    channels 每像素几个字节（RGBA 4 / RGB 3）
 *   power     权重 = 彩度^power（2；试过 3–4、面积打折、去掉浅色高光，31 张高分番封面上结果几乎不变）
 * 最多采样约 8000 个点，原图多大都一样快。
 */
export function dominantHue(data, width, height, channels = 4, { power = 2, minC = MIN_C } = {}) {
  const n = width * height;
  if (!n) return null;
  const step = Math.max(1, Math.floor(Math.sqrt(n / 8000)));
  const hist = new Float64Array(BINS);
  const pts = [];
  let total = 0, kept = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * channels;
      if (channels === 4 && data[i + 3] < 128) continue;   // 透明像素不算
      total++;
      const [L, C, H] = okLch(data[i], data[i + 1], data[i + 2]);
      if (C < minC || L < 0.25 || L > 0.97 || isSkin(L, C, H)) continue;
      kept++;
      const w = C ** power;
      hist[Math.floor(H / (360 / BINS)) % BINS] += w;
      pts.push(H, w);
    }
  }
  if (!total || kept / total < MIN_SHARE) return null;
  let best = 0, bestW = -1;
  for (let k = 0; k < BINS; k++) {
    const w = hist[(k + BINS - 1) % BINS] + 2 * hist[k] + hist[(k + 1) % BINS];
    if (w > bestW) { bestW = w; best = k; }
  }
  const center = (best + 0.5) * (360 / BINS);
  let sx = 0, sy = 0;
  for (let j = 0; j < pts.length; j += 2) {
    const d = Math.abs(((pts[j] - center + 540) % 360) - 180);
    if (d > 20) continue;
    const rad = pts[j] * Math.PI / 180;
    sx += Math.cos(rad) * pts[j + 1]; sy += Math.sin(rad) * pts[j + 1];
  }
  return Math.round((Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360) % 360;
}

let codecs;
/** jpeg-js / pngjs（playwright-core 打包在 utilsBundle 里）；加载失败返回 null，调用方当「这次算不了」 */
async function loadCodecs() {
  if (codecs !== undefined) return codecs;
  try {
    const m = await import('playwright-core/lib/utilsBundle');
    const mod = m.default ?? m;
    codecs = mod.jpegjs && mod.PNG ? { jpeg: mod.jpegjs, PNG: mod.PNG } : null;
  } catch { codecs = null; }
  return codecs;
}

/**
 * 图片字节 → 主色相 / null（灰图、解不开的格式）/ undefined（解码器加载不了：这次算不了，别记 -1）
 */
export async function hueFromBuffer(buf, opts) {
  const c = await loadCodecs();
  if (!c) return undefined;
  try {
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      const img = c.jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 256 });
      return dominantHue(img.data, img.width, img.height, 4, opts);
    }
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      const img = c.PNG.sync.read(buf);
      return dominantHue(img.data, img.width, img.height, 4, opts);
    }
  } catch { /* 坏图 → 当没有颜色 */ }
  return null;
}

/** 算好的结果写回库：null → -1（「无」，不再算）；undefined（这次算不了）不写 */
function store(id, hue) {
  if (hue === undefined) return;
  getDb().prepare('UPDATE anime SET cover_hue = ? WHERE id = ?').run(hue ?? -1, id);
}

/**
 * 封面缓存时调用：还没算过才算。force = 清晰版（详情页头部实际显示的那张）落盘时：
 * 普通封面常是另一张图（MAL 版），以清晰版为准覆盖（孤独摇滚：MAL 版黄字标题 → 104°，清晰版粉发 → 19°）
 */
export async function rememberHue(id, buf, force = false) {
  try {
    const row = getDb().prepare('SELECT cover_hue FROM anime WHERE id = ?').get(id);
    if (!row || (row.cover_hue != null && !force)) return;
    store(id, await hueFromBuffer(buf));
  } catch { /* 取色失败不影响封面本身 */ }
}

/**
 * 详情 / 观看页用：返回色相（0–359）或 null（没有可用颜色 / 封面还没缓存）。
 * 库里还是 NULL 时读已缓存的封面（清晰版，没有就普通那张）现算、存起来；封面还没缓存就先不算 ——
 * 页面这次用默认蓝，封面一抓回来（cover/[id]/+server.js）就补上了。
 */
export async function coverHueFor(id) {
  try {
    const row = getDb().prepare('SELECT cover_hue, cover_local_path FROM anime WHERE id = ?').get(id);
    if (!row) return null;
    if (row.cover_hue != null) return row.cover_hue >= 0 ? row.cover_hue : null;
    // 清晰版优先（详情页头部显示的就是它），没有再用普通那张
    const files = [join(COVER_DIR, 'hd', String(id % 100).padStart(2, '0'), String(id)),
                   row.cover_local_path && join(COVER_DIR, row.cover_local_path)].filter(Boolean);
    const f = files.find((p) => existsSync(p));
    if (!f) return null;
    const hue = await hueFromBuffer(await readFile(f));
    store(id, hue);
    return hue ?? null;
  } catch { return null; }
}
