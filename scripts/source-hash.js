/**
 * 源码指纹。用来判断「测试站产物是不是当前代码构建的」。
 *
 * 存在的理由：主人的规则是「测试站修好、测试通过，才更新正式站」。
 * 靠人记住会漏 —— 实测漏过一次：时间线分页改完直接发了正式站，
 * 测试站还跑着 11 分钟前的旧产物。所以把规则写进发布闸门。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 会进版本的目录与文件。scripts/（启动时跑的 migrate、每日同步）、deploy/、锁文件也会被组装进版本、
 * 作用到正式库 —— 原来不在指纹里，测试站验过后再改迁移脚本，门禁拦不住（2026-10-21 审核）
 */
const WATCH = ['src', 'static', 'scripts', 'deploy', 'svelte.config.js', 'vite.config.js', 'package.json', 'package-lock.json'];

const walk = (p) => {
  if (!existsSync(p)) return [];
  return statSync(p).isDirectory()
    ? readdirSync(p).flatMap((n) => walk(join(p, n)))
    : [p];
};

/** @returns {{hash: string, files: Map<string,string>}} */
export function sourceFingerprint() {
  const files = new Map();
  for (const w of WATCH)
    for (const f of walk(join(ROOT, w)).sort())
      files.set(relative(ROOT, f), createHash('sha1').update(readFileSync(f)).digest('hex'));
  const h = createHash('sha256');
  for (const [k, v] of [...files].sort(([a], [b]) => a.localeCompare(b))) h.update(`${k}:${v}\n`);
  return { hash: h.digest('hex').slice(0, 16), files };
}

/** 两份指纹的差异文件列表 */
export function diffFiles(a, b) {
  const out = [];
  for (const [k, v] of a) if (b.get(k) !== v) out.push(k);
  for (const k of b.keys()) if (!a.has(k)) out.push(k);
  return out;
}
