/**
 * 按「库有没有变过」缓存的查询结果。
 *
 * 版本号取两样，都只要几微秒：
 *   · PRAGMA data_version —— 别的连接（每日同步、维护脚本）提交后会变
 *   · total_changes()     —— 本连接任何一次写入都会变（番单、快速标记、设置…）
 * 所以不需要在每个写入点手动失效：库一变，下次读就重算；没变就直接给上次的结果。
 * 代价是任意一次写入都会让全部缓存作废 —— 对单用户站点无所谓，写入远比读少。
 */
import { getDb } from './db.js';

const store = new Map();   // key → { v, value }

function version() {
  const db = getDb();
  return `${db.prepare('PRAGMA data_version').get().data_version}:${db.prepare('SELECT total_changes() c').get().c}`;
}

export function memoByDb(key, fn) {
  const v = version();
  const hit = store.get(key);
  if (hit && hit.v === v) return hit.value;
  const value = fn();
  store.set(key, { v, value });
  return value;
}
