/**
 * 片源规则：Kazumi 的规则仓库（Predidit/KazumiRules，MIT）。
 * 一个站点一份 JSON，写的是「怎么搜、怎么取剧集列表」的 XPath，本身不含任何视频。
 *
 * 拉下来缓存在 CACHE_DIR/kazumi-rules/，超过 3 天才重拉；拉不到（断网、GitHub 抽风）
 * 就继续用缓存 —— 规则是辅助数据，不能因为它让详情页打不开。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR } from '../paths.js';

const RAW = 'https://raw.githubusercontent.com/Predidit/KazumiRules/main/';
const DIR = join(CACHE_DIR, 'kazumi-rules');
const MAX_AGE_MS = 3 * 24 * 3600 * 1000;

let mem = null;                       // { at, rules }
let inflight = null;

const fresh = (f) => existsSync(f) && Date.now() - statSync(f).mtimeMs < MAX_AGE_MS;

async function pull(name) {
  const res = await fetch(`${RAW}${name}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${name} ${res.status}`);
  const text = await res.text();
  JSON.parse(text);                   // 先验证再落盘，别把半截文件写进缓存
  writeFileSync(join(DIR, name), text);
  return text;
}

/** 只留得了的：HTML+XPath 模式，且没开人机验证（验证码在服务端过不去） */
const usable = (r) => r && r.type === 'anime' && !r.searchMode?.match(/^api$/)
  && r.searchURL && r.searchList && r.searchResult && r.chapterRoads && r.chapterResult;

async function load() {
  mkdirSync(DIR, { recursive: true });
  const indexFile = join(DIR, 'index.json');
  if (!fresh(indexFile)) {
    try {
      await pull('index.json');
      const idx = JSON.parse(readFileSync(indexFile, 'utf8'));
      await Promise.all(idx.map((x) => pull(`${x.name}.json`).catch(() => {})));
    } catch { /* 用旧缓存；没有缓存时下面会得到空列表 */ }
  }
  if (!existsSync(indexFile)) return [];
  const idx = JSON.parse(readFileSync(indexFile, 'utf8'));
  return idx.filter((x) => !x.antiCrawlerEnabled).flatMap((x) => {
    try {
      const r = JSON.parse(readFileSync(join(DIR, `${x.name}.json`), 'utf8'));
      return usable(r) ? [{ ...r, name: x.name }] : [];
    } catch { return []; }
  });
}

/** @returns {Promise<object[]>} 当前可用的规则 */
export async function loadRules() {
  if (mem && Date.now() - mem.at < 3600_000) return mem.rules;
  inflight ??= load().then((rules) => { mem = { at: Date.now(), rules }; return rules; })
    .finally(() => { inflight = null; });
  return inflight;
}

export async function getRule(name) {
  return (await loadRules()).find((r) => r.name === name) ?? null;
}
