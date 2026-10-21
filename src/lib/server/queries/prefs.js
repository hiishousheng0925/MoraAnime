/** 设置项与保存的筛选组合。就是两张 key-value 表，和番剧数据无关。 */
import { getDb } from '../db.js';
import { YEAR_FLOOR, YEAR_HARD_MIN, YEAR_HARD_MAX, yearCeil } from '../../constants.js';
import { isUserSettingKey } from '../multiUser.js';
import { currentUid, currentCtx } from '../userCtx.js';

/**
 * 设置项。多账号后分两种（键名决定，见 multiUser.js: isUserSettingKey）：
 *   · 个人设置（隐藏 NSFW、年份窗口、分享链接、片源记忆…）—— 登录了存 user_setting；
 *     访客存在 cookie 里（hooks.server.js 读进 ctx.prefs，/api/settings 写回去），不进库
 *   · 站点设置（截图目录等）—— 全站一份，在 setting 表
 */
export function getSetting(key, dflt = null) {
  if (isUserSettingKey(key)) {
    const uid = currentUid();
    if (!uid) return currentCtx()?.prefs?.[key] ?? dflt;
    const r = getDb().prepare('SELECT value FROM user_setting WHERE user_id = ? AND key = ?').get(uid, key);
    return r ? r.value : dflt;
  }
  const r = getDb().prepare('SELECT value FROM setting WHERE key=?').get(key);
  return r ? r.value : dflt;
}
export function setSetting(key, value) {
  if (isUserSettingKey(key)) {
    const uid = currentUid();
    if (!uid) { const c = currentCtx(); if (c) (c.prefs ??= {})[key] = String(value); return; }
    getDb().prepare(`INSERT INTO user_setting (user_id,key,value) VALUES (?,?,?)
                     ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value`).run(uid, key, String(value));
    return;
  }
  getDb().prepare(`INSERT INTO setting (key,value) VALUES (?,?)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
}

/**
 * 显示用的年份窗口 —— 全站唯一来源。
 *
 * 库里存的是 1950–2050 的全部数据（上游有多少存多少，包括远期的未上映），
 * 但界面只显示这个窗口内的：主人在设置页拖两个滑块决定看哪一段。
 * 缺省是「1950 – 明年」，和以前的行为一致（实测 2028 年之后只有 8 条远期公告，
 * 默认就显示出来会让年份筛选栏拖很长）。
 *
 * ⚠️ 只作用于「发现」类页面（目录/季度浏览/排行榜/放送表/快速标记/首页推荐）。
 * 我的番单和我的统计不受它影响 —— 那是主人自己标过的记录，
 * 因为改了窗口就凭空消失、统计数字跟着变，比看到窗口外的番更糟。
 */
export function yearWindow() {
  const n = (k, d) => { const v = +getSetting(k, ''); return Number.isFinite(v) && v > 0 ? v : d; };
  const min = Math.max(YEAR_HARD_MIN, Math.min(YEAR_HARD_MAX, n('year_min', YEAR_FLOOR)));
  const max = Math.max(min, Math.min(YEAR_HARD_MAX, n('year_max', yearCeil())));
  return { min, max };
}
/**
 * 保存的筛选组合。其中一套可以标成「默认」——
 * 无参数进入目录时套用它，「重置」也回到它。
 * 存的是引用（is_default 标在那一行上），所以改那套组合默认跟着变。
 * 一套都没标时用「系统默认」（出厂筛选），界面上是列表第一项。
 */
export const listFilters = () =>
  // created_at 存的是 UTC，显示用本机时间（#28）
  getDb().prepare(`SELECT id, name, filter_json, is_default, datetime(created_at, 'localtime') AS created_at
                   FROM saved_filter ORDER BY id DESC`).all();
export const addFilter = (name, filter_json) =>
  getDb().prepare('INSERT INTO saved_filter (name,filter_json) VALUES (?,?)').run(name, filter_json);
export const delFilter = (id) =>
  getDb().prepare('DELETE FROM saved_filter WHERE id=?').run(id);

/** id 为 null / 0 表示回到系统默认。默认唯一，所以先清再设 */
export function setDefaultFilter(id) {
  const db = getDb();
  // 视图：只碰得到自己的那几套（见 multiUser.js）
  db.prepare('UPDATE saved_filter SET is_default = 0 WHERE is_default = 1').run();
  if (id) db.prepare('UPDATE saved_filter SET is_default = 1 WHERE id = ?').run(id);
}
/** 当前默认的那一套；没有就返回 null（= 系统默认） */
export const getDefaultFilter = () =>
  getDb().prepare('SELECT id, name, filter_json FROM saved_filter WHERE is_default = 1').get() ?? null;
