import { getDb, tx } from './db.js';
import { BACKUP_DIR } from './paths.js';
import { writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isAdmin, currentUid, asUser } from './userCtx.js';
import { isUserSettingKey } from './multiUser.js';
import { ENTRY_CHECK, TRIAGE_VERDICTS, isInt, normScore } from './entryRules.js';

/**
 * 观看记录导出 / 导入。
 * 这是全库唯一不可再生的数据 —— 元数据挂了能重灌 4 万条，个人记录丢了就没了。
 * 导出用 anilist_id / mal_id / 标题三重定位，这样即使以后重灌库、内部 id 变了也能还原。
 */
export function exportData() {
  const db = getDb();
  // 个人数据经视图天然只有当前账号的（见 multiUser.js）；
  // 观看站 / 系列顺序 / 手动关联 / 站点设置是全站一份的公共修正，只有管理员的备份里带
  const admin = isAdmin();
  const entries = db.prepare(`
    SELECT a.anilist_id, a.mal_id, a.bgm_id, a.title, a.title_ja, a.title_cn,
           a.year, a.type, a.episodes,
           ue.status, ue.current_episode, ue.my_score, ue.my_note,
           ue.is_rewatching, ue.rewatch_count, ue.is_vague,
           ue.started_at, ue.finished_at, ue.created_at, ue.updated_at
    FROM user_entry ue JOIN anime a ON a.id = ue.anime_id
    ORDER BY ue.updated_at DESC`).all();
  const triage = db.prepare(`
    SELECT a.anilist_id, a.mal_id, a.bgm_id, a.title, a.year, a.type, a.episodes, t.verdict, t.batch_id, t.decided_at
    FROM triage t JOIN anime a ON a.id = t.anime_id ORDER BY t.decided_at`).all();
  const logs = db.prepare(`
    SELECT a.anilist_id, a.mal_id, a.bgm_id, a.title, a.year, a.type, a.episodes AS a_episodes,
           w.episode, w.action, w.detail, w.watched_at
    FROM watch_log w JOIN anime a ON a.id = w.anime_id ORDER BY w.watched_at`).all();
  const filters = db.prepare('SELECT name, filter_json, is_default, created_at FROM saved_filter').all();
  const mySettings = db.prepare('SELECT key, value FROM user_setting WHERE user_id = uid()').all();
  const site = admin ? exportSite(db) : { watchSites: [], seriesOrder: [], relations: [], siteSettings: [] };

  return {
    app: 'j-anime',
    version: 2,
    exported_at: new Date().toISOString(),
    // 「我的标签」2026-10-18 下线：不再导出 tags；旧备份里带着的导入时忽略
    counts: { entries: entries.length, triage: triage.length, logs: logs.length,
              watchSites: site.watchSites.length, seriesOrder: site.seriesOrder.length,
              relations: site.relations.length, settings: mySettings.length + site.siteSettings.length },
    entries, triage, logs, filters, settings: [...mySettings, ...site.siteSettings],
    watchSites: site.watchSites, seriesOrder: site.seriesOrder, relations: site.relations
  };
}

/** 全站一份的公共修正。v2 起补上的（issue #9）：原来备份里没有，删了就找不回来 */
function exportSite(db) {
  const watchSites = db.prepare('SELECT name, url, ord, enabled FROM watch_site ORDER BY ord, id').all();
  const seriesOrder = db.prepare(`
    SELECT a.anilist_id, a.mal_id, a.bgm_id, a.title, a.year, a.type, a.episodes, fm.user_order
    FROM franchise_member fm JOIN anime a ON a.id = fm.anime_id
    WHERE fm.user_order IS NOT NULL AND a.is_stub = 0`).all();
  // 折叠掉的重复卡（is_stub=1）不导出：它的外部 ID 和本体一样，导入时会解析到本体身上，
  // 把本体的顺序改成它的（正式库系列 1 里 4290 → 9 就是这样）
  const relations = db.prepare(`
    SELECT x.anilist_id a_anilist_id, x.mal_id a_mal_id, x.bgm_id a_bgm_id, x.title a_title, x.year a_year,
           y.anilist_id b_anilist_id, y.mal_id b_mal_id, y.bgm_id b_bgm_id, y.title b_title, y.year b_year
    FROM manual_relation m JOIN anime x ON x.id = m.a_id JOIN anime y ON y.id = m.b_id`).all();
  const siteSettings = db.prepare('SELECT key, value FROM setting').all();
  return { watchSites, seriesOrder, relations, siteSettings };
}

/**
 * 整站备份（每日同步 scripts/backup.js 用）：每个账号一份个人数据 + 公共修正。
 * 恢复时从 accounts 里取自己那份（见 importData）。
 */
export function exportAll() {
  const db = getDb();
  const accounts = db.prepare('SELECT id, username, email, role FROM account ORDER BY id').all()
    .map((a) => ({ ...a, data: asUser(a.id, () => exportData()) }));
  const site = exportSite(db);
  const sum = (k) => accounts.reduce((n, a) => n + a.data.counts[k], 0);
  return {
    app: 'j-anime', version: 3, kind: 'site', exported_at: new Date().toISOString(),
    counts: { accounts: accounts.length, entries: sum('entries'), triage: sum('triage'), logs: sum('logs'),
              watchSites: site.watchSites.length, seriesOrder: site.seriesOrder.length,
              relations: site.relations.length, settings: site.siteSettings.length },
    accounts, ...site
  };
}

/**
 * 写一份备份，返回文件路径。label 会拼进文件名（如 before-import）。
 * 文件名以时间戳开头，pruneBackups 按名字排序就是按时间排序。
 */
export function saveBackup(dir = BACKUP_DIR, data = exportData(), label = '') {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = join(dir, `j-anime-${stamp}${label ? '-' + label : ''}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}
/**
 * 保留最近 keep 份，返回删了几份。
 * ⚠️ 只认 j-anime-*.json：镜像目录可能是个共用的同步盘，原来按 *.json 删会误删别人的文件
 */
export function pruneBackups(dir, keep = 30) {
  const olds = readdirSync(dir).filter((f) => /^j-anime-.*\.json$/.test(f)).sort().reverse().slice(keep);
  for (const f of olds) rmSync(join(dir, f));
  return olds.length;
}

const CSV_COLS = ['title_cn', 'title_ja', 'title', 'year', 'type', 'episodes',
                  'status', 'current_episode', 'my_score', 'my_note',
                  'started_at', 'finished_at', 'anilist_id', 'mal_id', 'bgm_id'];
const HEADERS = ['中文名', '日文名', '罗马字', '年份', '类型', '总集数',
                 '我的状态', '看到第几集', '我的评分', '短评',
                 '开始时间', '看完时间', 'anilist_id', 'mal_id', 'bgm_id'];

export function exportCsv() {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const { entries } = exportData();
  const lines = [HEADERS.join(',')];
  for (const e of entries) lines.push(CSV_COLS.map((k) => esc(e[k])).join(','));
  return '﻿' + lines.join('\n');   // BOM，Excel 打开中文不乱码
}

/**
 * 按 anilist_id → mal_id → bgm_id → 标题+年份 依次定位条目。
 * ⚠️ 每一步都优先可见条目：去重会把外部 ID 复制给保留方，同一个 anilist_id 可能挂着
 * 一条可见的和一条被折叠的（is_stub=1），恢复到后者上番单里就看不到这条记录了
 */
// 同一个外部 ID 可能挂着两张可见的重复卡（#18：孤独摇滚 #3717 单站影子卡和 #3718 正片
// 同名、同 bgm_id，只差集数）。只按收录站数挑会把记录还原到另一张卡上，两条撞成一条。
// 所以候选里按 标题 → 年份 → 类型 → 集数 逐项比对导出时的值，都一样才看收录站数。
const PICK = `ORDER BY is_stub, (title = ?) DESC, (year IS ?) DESC, (type IS ?) DESC,
  (episodes IS ?) DESC, source_count DESC LIMIT 1`;
// 五条语句只 prepare 一次（2026-10-21 审核：原来每解析一行就重新 prepare 五遍，导入几千行日志全耗在这上面）。
// anilist_id / title 两列的索引在 schema.sql（idx_anime_anilist / idx_anime_title），原来这两步是全表扫描
function makeResolver(db) {
  const q = (sql) => db.prepare(`${sql} ${PICK}`);
  const st = { anilist: q('SELECT id FROM anime WHERE anilist_id=?'), mal: q('SELECT id FROM anime WHERE mal_id=?'),
               bangumi: q('SELECT id FROM anime WHERE bgm_id=?'),
               titleYear: q('SELECT id FROM anime WHERE title=? AND (year IS ? OR year=?)'),
               title: q('SELECT id FROM anime WHERE title=?') };
  return (row) => {
    const by = (s, ...p) => s.get(...p, row.title ?? null, row.year ?? null, row.type ?? null, row.episodes ?? null)?.id ?? null;
    return (row.anilist_id && by(st.anilist, row.anilist_id))
      ?? (row.mal_id && by(st.mal, row.mal_id))
      ?? (row.bgm_id && by(st.bangumi, row.bgm_id))
      ?? (row.title && by(st.titleYear, row.title, row.year ?? null, row.year ?? null))
      ?? (row.title && by(st.title, row.title));
  };
}
/** 关联是两条，导出时字段带 a_ / b_ 前缀 */
const side = (r, p) => ({ anilist_id: r[p + 'anilist_id'], mal_id: r[p + 'mal_id'], bgm_id: r[p + 'bgm_id'],
                          title: r[p + 'title'], year: r[p + 'year'] });

export function importData(payload, { replace = false } = {}) {
  if (payload?.app !== 'j-anime') throw new Error('不是 j-anime 的备份文件');
  // 整站备份（v3）：取自己那份个人数据；公共修正照样只有管理员能还原（下面按 admin 判断）
  let missingAccount = false;
  if (payload.version === 3) {
    // 先按用户名认（重建库后账号 id 可能变），认不到再按 id；都没有就标出来，别静默导入 0 条
    const me = getDb().prepare('SELECT username FROM account WHERE id = ?').get(currentUid());
    const acc = (me && payload.accounts?.find((a) => a.username === me.username))
      ?? payload.accounts?.find((a) => a.id === currentUid());
    const mine = acc?.data ?? {};
    if (!acc) missingAccount = true;
    payload = { ...mine, app: 'j-anime', watchSites: payload.watchSites, seriesOrder: payload.seriesOrder,
                relations: payload.relations, siteSettings: payload.siteSettings };
  }
  const db = getDb();
  const resolve = makeResolver(db);
  const admin = isAdmin();
  const stat = { entries: 0, triage: 0, logs: 0, filters: 0, watchSites: 0,
                 seriesOrder: 0, relations: 0, settings: 0, unresolved: [], safety: null, missingAccount };
  // 清空前必先留一份：原来选中文件就直接清四张表，选错文件就是全部番单没了
  if (replace) stat.safety = saveBackup(BACKUP_DIR, exportData(), `before-import-u${currentUid()}`);

  tx(db, () => {
    // 个人表是视图，DELETE 只删得到自己的（见 multiUser.js）
    if (replace) db.exec('DELETE FROM user_entry; DELETE FROM triage; DELETE FROM watch_log; DELETE FROM user_tag; DELETE FROM saved_filter;');
    if (replace && admin) db.exec('DELETE FROM manual_relation;');

    // upsert 只能写真表（视图不支持 ON CONFLICT）
    const insEntry = db.prepare(`
      INSERT INTO user_entry_all (user_id,anime_id,status,current_episode,my_score,my_note,
        is_rewatching,rewatch_count,is_vague,started_at,finished_at)
      VALUES (uid(),@id,@status,@ep,@score,@note,@rw,@rwc,@vague,@st,@fin)
      ON CONFLICT(user_id,anime_id) DO UPDATE SET status=excluded.status,
        current_episode=excluded.current_episode, my_score=excluded.my_score,
        my_note=excluded.my_note, is_vague=excluded.is_vague, updated_at=datetime('now')`);
    for (const e of payload.entries ?? []) {
      const id = resolve(e);
      if (!id) { stat.unresolved.push(e.title_cn || e.title); continue; }
      // 和 /api/entry 同一套规则；不合法的整条跳过（算进未匹配里报给用户），不写坏值
      const v = { status: e.status ?? 'plan', current_episode: e.current_episode ?? null, my_score: e.my_score ?? null, my_note: e.my_note ?? null };
      if (!Object.keys(ENTRY_CHECK).every((k) => ENTRY_CHECK[k](v[k]))) { stat.unresolved.push(e.title_cn || e.title); continue; }
      insEntry.run({ id, status: v.status, ep: v.current_episode,
        score: normScore(v.my_score), note: v.my_note, rw: e.is_rewatching ? 1 : 0,
        rwc: isInt(e.rewatch_count, 0, 1000) ? e.rewatch_count : 0, vague: e.is_vague ? 1 : 0,
        st: e.started_at ?? null, fin: e.finished_at ?? null });
      stat.entries++;
    }
    const insTri = db.prepare(`INSERT INTO triage_all (user_id,anime_id,verdict,batch_id,decided_at)
      VALUES (uid(),?,?,?,coalesce(?,datetime('now')))
      ON CONFLICT(user_id,anime_id) DO UPDATE SET verdict=excluded.verdict`);
    for (const t of payload.triage ?? []) {
      if (!TRIAGE_VERDICTS.includes(t.verdict)) continue;
      const id = resolve(t); if (!id) continue;
      insTri.run(id, t.verdict, t.batch_id ?? null, t.decided_at ?? null); stat.triage++;
    }
    const insLog = db.prepare(`INSERT INTO watch_log (anime_id,episode,action,detail,watched_at)
      VALUES (?,?,?,?,coalesce(?,datetime('now')))`);
    // 同一份备份导两次不出两份：带时间的日志按（番、集、动作、时间）认重复
    const hasLog = db.prepare(`SELECT 1 FROM watch_log WHERE anime_id = ? AND episode IS ? AND action = ? AND watched_at = ?`);
    for (const w of payload.logs ?? []) {
      // 日志行的 episode 是「看到第几集」，条目的总集数导出成 a_episodes，别混用
      const id = resolve({ ...w, episodes: w.a_episodes }); if (!id) continue;
      if (w.watched_at && hasLog.get(id, w.episode ?? null, w.action ?? 'import', w.watched_at)) continue;
      insLog.run(id, w.episode ?? null, w.action ?? 'import', w.detail ?? null, w.watched_at ?? null);
      stat.logs++;
    }
    const insF = db.prepare('INSERT INTO saved_filter (name,filter_json,is_default) VALUES (?,?,?)');
    const hasF = db.prepare('SELECT 1 FROM saved_filter WHERE name = ? AND filter_json = ?');
    const clearDefault = db.prepare('UPDATE saved_filter SET is_default = 0 WHERE is_default = 1');
    const setDefault = db.prepare('UPDATE saved_filter SET is_default = 1 WHERE name = ? AND filter_json = ?');
    for (const f of payload.filters ?? []) {
      if (!hasF.get(f.name, f.filter_json)) { insF.run(f.name, f.filter_json, 0); stat.filters++; }
      // 默认只能有一套（prefs.js 同样先清再标）
      if (f.is_default) { clearDefault.run(); setDefault.run(f.name, f.filter_json); }
    }

    // ── v2 起才有的四类；v1 备份里没有这些键，跳过即可 ──
    if (admin && payload.watchSites) {
      if (replace) db.exec('DELETE FROM watch_site');
      const has = db.prepare('SELECT 1 FROM watch_site WHERE url = ?');
      const ins = db.prepare('INSERT INTO watch_site (name,url,ord,enabled) VALUES (?,?,?,?)');
      for (const w of payload.watchSites) {
        if (!replace && has.get(w.url)) continue;
        ins.run(w.name, w.url, w.ord ?? 0, w.enabled ?? 1); stat.watchSites++;
      }
    }
    const setOrder = db.prepare('UPDATE franchise_member SET user_order = ? WHERE anime_id = ?');
    const ordered = new Set(); // 旧备份里还带着折叠卡：同一部只认第一次解析到的
    for (const o of admin ? payload.seriesOrder ?? [] : []) {
      const id = resolve(o); if (!id || ordered.has(id)) continue;
      ordered.add(id);
      stat.seriesOrder += setOrder.run(o.user_order, id).changes;
    }
    const insRel = db.prepare('INSERT OR IGNORE INTO manual_relation (a_id,b_id) VALUES (?,?)');
    for (const r of admin ? payload.relations ?? [] : []) {
      const a = resolve(side(r, 'a_')), b = resolve(side(r, 'b_'));
      if (!a || !b || a === b) continue;
      insRel.run(Math.min(a, b), Math.max(a, b)); stat.relations++;
    }
    // 个人设置进自己的 user_setting；站点设置（截图目录等）只有管理员能还原
    const setMine = db.prepare(`INSERT INTO user_setting (user_id,key,value) VALUES (uid(),?,?)
      ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value`);
    const setSite = db.prepare('INSERT INTO setting (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const s of [...(payload.settings ?? []), ...(payload.siteSettings ?? [])]) {
      // 分享令牌不还原：撤销过的泄露链接会被旧备份带回来，导入也成了任意指定令牌的口子（2026-10-21 审核）
      if (s.key === 'share_token') continue;
      if (isUserSettingKey(s.key)) setMine.run(s.key, s.value);
      else if (admin) setSite.run(s.key, s.value);
      else continue;
      stat.settings++;
    }
  });
  return stat;
}
