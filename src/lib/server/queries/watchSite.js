/**
 * 观看站的增删改查。表结构见 schema.sql 的 watch_site。
 * 只管模板本身；模板→链接的替换在 src/lib/watchSite.js（客户端也要用）。
 */
import { getDb } from '../db.js';
import { isValidTemplate } from '../../watchSite.js';
import { getSetting, setSetting } from './prefs.js';
import { currentUid } from '../userCtx.js';

/**
 * @param {boolean} onlyEnabled 详情页只要开着的，设置页要全部
 * 观看站全站一份（管理员配），但只给登录的人看 —— 访客那里「去原站搜索」整块不出现（主人 2026-10-19）
 */
export function listWatchSites(onlyEnabled = false) {
  if (!currentUid()) return [];
  return getDb().prepare(`SELECT id, name, url, ord, enabled FROM watch_site
    ${onlyEnabled ? 'WHERE enabled = 1' : ''} ORDER BY ord, id`).all();
}

export function addWatchSite(name, url) {
  const n = String(name ?? '').trim(), u = String(url ?? '').trim();
  if (!n) return { error: '请填站点名字' };
  if (!isValidTemplate(u)) return { error: '网址要以 http:// 或 https:// 开头' };
  const db = getDb();
  // 新加的排到最后
  const next = (db.prepare('SELECT max(ord) m FROM watch_site').get().m ?? 0) + 1;
  db.prepare('INSERT INTO watch_site (name, url, ord) VALUES (?, ?, ?)').run(n, u, next);
  return { ok: true };
}

/** 改名字 / 改网址。校验和 add 同一套 —— 编辑不该比添加宽松 */
export function updateWatchSite(id, name, url) {
  const n = String(name ?? '').trim(), u = String(url ?? '').trim();
  if (!n) return { error: '请填站点名字' };
  if (!isValidTemplate(u)) return { error: '网址要以 http:// 或 https:// 开头' };
  getDb().prepare('UPDATE watch_site SET name = ?, url = ? WHERE id = ?').run(n, u, +id);
  return { ok: true };
}

export function delWatchSite(id) {
  getDb().prepare('DELETE FROM watch_site WHERE id = ?').run(+id);
  return { ok: true };
}

export function toggleWatchSite(id, enabled) {
  getDb().prepare('UPDATE watch_site SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, +id);
  return { ok: true };
}

/**
 * 上移 / 下移一位。和相邻那条交换 ord —— 不用「重排全表」是因为
 * ord 可能有空洞（删过行），交换对空洞免疫。
 */
export function moveWatchSite(id, dir) {
  const db = getDb();
  const rows = listWatchSites();
  const i = rows.findIndex((r) => r.id === +id);
  const j = i + (dir === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= rows.length) return { ok: true };
  const a = rows[i], b = rows[j];
  db.prepare('UPDATE watch_site SET ord = ? WHERE id = ?').run(b.ord, a.id);
  db.prepare('UPDATE watch_site SET ord = ? WHERE id = ?').run(a.ord, b.id);
  return { ok: true };
}

/**
 * 观看页记住的片源：每部番上次用的站、那一条结果的名字、线路序号。
 * 存在 setting 表里（键 watch_pick:<id>），跟着备份走，不另建表。
 * 只存名字不存链接：片源接口只认本进程发出去过的链接（见 sources/index.js），
 * 重启后旧链接就失效了，下次进页面按名字在新的搜索结果里找回来。
 */
export function getWatchPick(animeId) {
  const v = getSetting(`watch_pick:${animeId}`);   // 个人设置：每个账号记自己的（访客不记）
  try { return v ? JSON.parse(v) : null; } catch { return null; }
}
export function setWatchPick(animeId, pick) {
  if (!currentUid()) return;
  setSetting(`watch_pick:${animeId}`, JSON.stringify(pick));
}

/** 片源打分用的「这部番叫什么」：中文名、日文名、罗马字，加上各处来的中文别名（片源站多用中文名） */
export function watchNames(animeId) {
  const db = getDb();
  const a = db.prepare('SELECT title, title_ja, title_cn FROM anime WHERE id = ?').get(animeId);
  if (!a) return [];
  const al = db.prepare(`SELECT alias FROM anime_alias WHERE anime_id = ? AND is_cjk = 1 AND has_kana = 0`).all(animeId).map((r) => r.alias);
  return [...new Set([a.title_cn, a.title_ja, a.title, ...al].filter(Boolean))];
}

/**
 * 片源站的直链解析战绩：每解析一次记一笔成功 / 失败。观看页同分时先试成功率高的站，
 * 选片源时给只能跳转的站标「跳转」。存 meta 表（不是个人记录，不进备份）。
 */
/**
 * 键名带版本：2026-10-19 加了无头浏览器嗅探，7sefun / DM84 从「永远解析失败」变成能播，
 * 旧的战绩全是失败，会让它们一直排在后面、标着「跳转」—— 换个前缀从零重新记
 */
const STAT = 'src_stat2:';
export function recordResolve(site, ok) {
  const db = getDb(), key = `${STAT}${site}`;
  let s = { ok: 0, fail: 0 };
  try { s = { ...s, ...JSON.parse(db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? '{}') }; } catch { /* 坏了就从零记 */ }
  s[ok ? 'ok' : 'fail']++;
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, JSON.stringify(s));
}
/** @returns {Record<string, number>} 站名 → 站内可播的比例（0–1）；没记录的站不在里面 */
export function embedRates() {
  const out = {};
  for (const r of getDb().prepare(`SELECT key, value FROM meta WHERE key LIKE '${STAT}%'`).all()) {
    try { const s = JSON.parse(r.value); if (s.ok + s.fail > 0) out[r.key.slice(STAT.length)] = s.ok / (s.ok + s.fail); } catch { /* 跳过 */ }
  }
  return out;
}
