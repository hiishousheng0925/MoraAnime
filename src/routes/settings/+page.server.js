import { listFilters, getSetting, yearWindow, listWatchSites }
  from '$lib/server/queries.js';
import { YEAR_HARD_MIN, YEAR_HARD_MAX } from '$lib/constants.js';
import { hideNsfw } from '$lib/server/loaderUtil.js';
import { getDb } from '$lib/server/db.js';
import { shotDir, DEFAULT_SHOT_DIR } from '$lib/server/screenshot.js';
import { listAllow, sessionCount } from '$lib/server/auth.js';

export function load({ locals }) {
  const db = getDb();
  const c = (s) => db.prepare(s).get().c;
  const u = locals.user, admin = u?.role === 'admin';
  return {
    // 账号区：登录中的设备数（「下线其他设备」旁边显示）；白名单只给管理员
    sessions: u ? sessionCount(u.id) : 0,
    allow: admin ? listAllow() : [],
    filters: listFilters(),
    hideNsfw: hideNsfw(),
    yearWin: yearWindow(),
    yearHard: { min: YEAR_HARD_MIN, max: YEAR_HARD_MAX },
    shareToken: getSetting('share_token', ''),
    shotDir: admin ? shotDir() : '', shotDefault: admin ? DEFAULT_SHOT_DIR : '',
    watchSites: listWatchSites(),
    // id 要取出来当 {#each} 的 key —— kind+finished_at 不唯一，见 +page.svelte 那段注释
    // 存的是 UTC（datetime('now')），显示要转本机时间，否则比本地慢 8 小时
    syncs: db.prepare(`SELECT id, kind, datetime(finished_at, 'localtime') finished_at, items, status, error
                       FROM sync_log ORDER BY id DESC LIMIT 60`).all(),
    counts: {
      anime: c('SELECT count(*) c FROM anime'),
      cn: c('SELECT count(*) c FROM anime WHERE title_cn IS NOT NULL'),
      cnPending: c('SELECT count(*) c FROM anime WHERE is_jp=1 AND is_stub=0 AND title_ja IS NOT NULL AND bgm_matched_at IS NULL'),
      covers: c('SELECT count(*) c FROM anime WHERE cover_local_path IS NOT NULL'),
      dead: c('SELECT count(*) c FROM anime WHERE cover_dead=1'),
      nsfw: c('SELECT count(*) c FROM anime WHERE is_nsfw=1'),
      // 窗口外被隐藏了多少条，设置页要给出这个数字
      outside: c(`SELECT count(*) c FROM anime WHERE is_stub=0 AND year IS NOT NULL
        AND (year < ${yearWindow().min} OR year > ${yearWindow().max})`),
      weekday: c('SELECT count(*) c FROM anime WHERE bgm_weekday IS NOT NULL'),
      entries: c('SELECT count(*) c FROM user_entry'),
      logs: c('SELECT count(*) c FROM watch_log')
    },
    aodUpdate: db.prepare("SELECT value FROM meta WHERE key='aod_last_update'").get()?.value,
    // 主数据源是 Bangumi 周导出（#2）：新鲜度看它；超过 14 天标红
    bangumiDump: (db.prepare("SELECT value FROM meta WHERE key='bgm_archive'").get()?.value ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null,
    // 上游停更时这里是唯一能看出来的地方（#1）：超过 30 天标红
    aodAgeDays: db.prepare(`SELECT CAST(julianday('now') - julianday(value) AS INTEGER) d
                            FROM meta WHERE key='aod_last_update'`).get()?.d ?? null,
    bangumiAgeDays: db.prepare(`SELECT CAST(julianday('now') - julianday(substr(value, 6, 10)) AS INTEGER) d
                            FROM meta WHERE key='bgm_archive' AND value LIKE 'dump-%'`).get()?.d ?? null
  };
}
