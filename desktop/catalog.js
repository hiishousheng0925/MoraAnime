/**
 * 番剧库数据包：读 manifest（catalog.json）→ 下载压缩包 → 校验 sha256 → 解压 → 再校验解压后的 sha256。
 * 主进程里跑，只做文件操作，不打开数据库（换库在 db-tasks.js 里做）。
 *
 * 地址：缺省读 GitHub Releases 上固定 tag「catalog」里的 catalog.json；
 * 环境变量 MORA_CATALOG_URL 可以改成别的 http(s) 地址、file:// 地址或本地路径（开发 / 打包测试用）。
 * manifest 里的 file 按 manifest 自己的地址解析（同目录），也可以直接给 url。
 *
 * 所有写入先落到 .part 临时文件，校验通过才改名 —— 下载断了、包坏了，都不会留下半截文件被当成库用。
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip } from 'node:zlib';

export const DEFAULT_MANIFEST = 'https://github.com/hiishousheng0925/MoraAnime/releases/download/catalog/catalog.json';

export function manifestUrl() {
  const v = process.env.MORA_CATALOG_URL || DEFAULT_MANIFEST;
  if (/^(https?|file):/i.test(v)) return v;
  if (isAbsolute(v)) return pathToFileURL(v).href;
  throw new Error(`MORA_CATALOG_URL 不是 URL 也不是绝对路径：${v}`);
}

/** @param {(url: string) => Promise<Response>} fetchFn  主进程传 electron 的 net.fetch（走系统代理） */
async function openStream(url, fetchFn) {
  if (url.startsWith('file:')) {
    const p = fileURLToPath(url);
    if (!existsSync(p)) throw new Error(`找不到 ${p}`);
    const { statSync } = await import('node:fs');
    return { stream: createReadStream(p), size: statSync(p).size };
  }
  const res = await fetchFn(url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return { stream: Readable.fromWeb(res.body), size: Number(res.headers.get('content-length')) || 0 };
}

export async function fetchManifest(fetchFn) {
  const url = manifestUrl();
  let text;
  if (url.startsWith('file:')) text = readFileSync(fileURLToPath(url), 'utf8');
  else {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(20_000), cache: 'no-store' });
    if (!res.ok) throw new Error(`读 manifest 失败 HTTP ${res.status}`);
    text = await res.text();
  }
  const m = JSON.parse(text);
  if (m.format !== 1 || !m.version || !/^[0-9a-f]{64}$/.test(m.sha256 ?? '') || !(m.file || m.url))
    throw new Error('manifest 格式不对');
  return { ...m, packUrl: m.url || new URL(m.file, url).href };
}

/** 一边流过一边算 sha256 / 计字节 */
function tap(onChunk) {
  return new Transform({ transform(chunk, _enc, cb) { onChunk(chunk); cb(null, chunk); } });
}

/**
 * 下载 + 校验 + 解压到 dest（成功才出现 dest）。
 * @param {object} m manifest
 * @param {string} dest 解压后的库文件路径
 * @param {(p: {phase: string, done: number, total: number}) => void} [onProgress]
 */
export async function downloadCatalog(m, dest, fetchFn, onProgress = () => {}) {
  mkdirSync(dirname(dest), { recursive: true });
  const pack = dest + '.pack.part', part = dest + '.part';
  rmSync(pack, { force: true }); rmSync(part, { force: true });
  try {
    // 1. 下载压缩包，边下边算哈希
    const { stream, size } = await openStream(m.packUrl, fetchFn);
    const total = m.size || size;
    const h1 = createHash('sha256'); let got = 0, last = 0;
    await pipeline(stream, tap((c) => {
      h1.update(c); got += c.length;
      if (got - last > 512 * 1024) { last = got; onProgress({ phase: 'download', done: got, total }); }
    }), createWriteStream(pack));
    onProgress({ phase: 'download', done: got, total });
    if (m.size && got !== m.size) throw new Error(`数据包大小不对：${got} ≠ ${m.size}`);
    if (h1.digest('hex') !== m.sha256) throw new Error('数据包 sha256 校验失败');

    // 2. 解压，边解边算库文件的哈希
    const h2 = createHash('sha256'); let out = 0; last = 0;
    const dec = m.compression === 'gzip' ? createGunzip() : createBrotliDecompress();
    const dbTotal = m.db?.size || 0;
    await pipeline(createReadStream(pack), dec, tap((c) => {
      h2.update(c); out += c.length;
      if (out - last > 4 * 1024 * 1024) { last = out; onProgress({ phase: 'extract', done: out, total: dbTotal }); }
    }), createWriteStream(part));
    if (m.db?.sha256 && h2.digest('hex') !== m.db.sha256) throw new Error('解压后的库 sha256 校验失败');
    // SQLite 文件头
    const head = Buffer.alloc(16);
    const { openSync, readSync, closeSync } = await import('node:fs');
    const fd = openSync(part, 'r'); readSync(fd, head, 0, 16, 0); closeSync(fd);
    if (head.toString('latin1') !== 'SQLite format 3\0') throw new Error('解压出来的不是 SQLite 库');

    rmSync(dest, { force: true });
    renameSync(part, dest);
    return { bytes: got, dbBytes: out };
  } finally {
    rmSync(pack, { force: true }); rmSync(part, { force: true });
  }
}
