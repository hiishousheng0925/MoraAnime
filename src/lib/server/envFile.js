/**
 * 读 ~/.j-anime.env 进 process.env（已有的环境变量不覆盖）。
 *
 * ⚠️ 为什么需要：只有 run-app 会读这个文件，定时同步（launchd plist / 任务计划程序）不读。
 * 于是写在里面的 J_ANIME_BACKUP_MIRROR 对每天的备份从来没生效过 ——
 * open-question.md 里「离机副本」那次修复其实一直是空转（issue #9）。
 * 定时任务入口（sync-all.js、backup.js）开头调一次，子脚本经 spawnSync 继承。
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ENV_FILE = join(homedir(), '.j-anime.env');

/** 解析成 [键, 值] 列表（同步、只读，不碰 process.env） */
function parseEnvFile(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    out.push([m[1], m[2].replace(/^(['"])(.*)\1$/, '$2')]);
  }
  return out;
}

export function loadEnvFile(file = ENV_FILE) {
  const loaded = [];
  for (const [k, v] of parseEnvFile(file)) {
    if (process.env[k] !== undefined) continue;
    process.env[k] = v;
    loaded.push(k);
  }
  return loaded;
}

/**
 * 只取一个键（环境变量优先，其次 ~/.j-anime.env），不把整份文件读进环境。
 * paths.js 用它找 J_ANIME_DATA，site.js 用它找 J_ANIME_SITE：
 * 正式数据搬出开发目录后，开发 / 测试 / 测试站都靠这一行找到 <站点>\data。
 */
export function envValue(key, file = ENV_FILE) {
  if (process.env[key]) return process.env[key];
  const hit = parseEnvFile(file).find(([k]) => k === key);
  return hit && hit[1] ? hit[1] : undefined;
}
