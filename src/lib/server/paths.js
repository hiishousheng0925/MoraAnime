/**
 * 数据目录的唯一来源。
 *
 * ⚠️ 为什么不能靠 import.meta.url 推算：生产构建（adapter-node）会把
 * 这个文件打包到 build/server/chunks/chunks/ 下，相对路径全错 ——
 * 会指到 build/data/，而 node:sqlite 打不开时会「静默新建一个空库」，
 * 表现就是站点起来了但一条番都没有。
 *
 * 优先级：J_ANIME_DATA 环境变量 → ~/.j-anime.env 里的 J_ANIME_DATA → 开发目录 data/（兼容旧布局）。
 * 2026-10 起正式数据搬到站点目录（<站点>\data，见 scripts/site.js）：.j-anime.env 里写一行
 * J_ANIME_DATA=<站点>\data，开发 / 测试 / 测试站就都去那里找库，开发目录里不再有正式数据。
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envValue } from './envFile.js';

/** 开发时本文件在 src/lib/server/ 下，往上三层是项目根 */
const devFallback = () => join(dirname(fileURLToPath(import.meta.url)), '../../../data');

const fromEnv = envValue('J_ANIME_DATA');
export const DATA_DIR = fromEnv ? resolve(fromEnv) : devFallback();

export const DB_PATH    = process.env.J_ANIME_DB     || join(DATA_DIR, 'j-anime.db');
export const COVER_DIR  = process.env.J_ANIME_COVERS || join(DATA_DIR, 'covers');
export const CACHE_DIR  = join(DATA_DIR, 'cache');
// 测试 / 测试站必须指到别处：「导入前清空」会先自动备份，写进真目录就是拿测试数据
// 去挤占正式备份的 30 份名额（scripts/test.js、run-app 的测试站分支都会设它）
export const BACKUP_DIR = process.env.J_ANIME_BACKUPS || join(DATA_DIR, 'backups');
