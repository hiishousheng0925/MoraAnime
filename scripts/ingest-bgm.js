/**
 * 主数据源：Bangumi 官方周导出 bangumi/Archive（#1 #2 #3）。设计见 docs/DS2-bangumi-migration.md。
 *
 * AOD 2026-07-04 归档后目录就不再进新番，而 bgm 那一半又是拿 AOD 标题模糊匹配来的，
 * 续作大量挂在前作条目上（2,750 组共用 bgm_id）。这里换成以 Bangumi 为准：
 *   1. 取最新的 dump（每周二更新；和 meta.bgm_archive 一样就用缓存）
 *   2. 每个 AOD 条目重新匹配到对应的 bgm 条目（src/lib/server/bangumiMatch.js）
 *   3. 匹配上的：中文名、别名、评分、排名、简介、放送日期、集数、NSFW、日本番判定都以 bgm 为准
 *      对不上的：清掉原来错挂的 bgm 数据，保留中文名（「仅 AOD」条目，数据冻结在 2026-07-04）
 *   4. bgm 有、库里没有任何条目对上的日本番 → 新建条目（uid = 'bgm:<id>'）
 * 番单挂在 anime.id 上、id 不变 —— 「胆大党 第二季」那条番单一直挂着第二季的条目，
 * 只是那个条目原来错指到第一季；重新匹配后它自己就显示第二季的数据，记录一条都不用搬。
 *
 * 用法：
 *   node scripts/ingest-bgm.js                 # 日常（每日同步调用）：有新 dump 就下载，然后重新匹配并写库
 *   node scripts/ingest-bgm.js --file x.zip    # 用本地的 dump（测试 / 离线）
 *   node scripts/ingest-bgm.js --dry           # 只出报告不写库
 */
import { createReadStream, existsSync, mkdirSync, statSync, renameSync, rmSync, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { getDb, initSchema, tx, DB_PATH } from '../src/lib/server/db.js';
import { CACHE_DIR } from '../src/lib/server/paths.js';
import { parseSubject } from '../src/lib/server/bangumiArchive.js';
import { buildIndex, matchRow, normName } from '../src/lib/server/bangumiMatch.js';
import { hasKana, hasCjk } from '../src/lib/server/text.js';
import { applyAliasDupes } from '../src/lib/server/dedup.js';
import { applyCnManual } from '../src/lib/server/cnManual.js';
import { GENRES } from '../src/lib/genres.js';
import { upsertEpisodes } from '../src/lib/server/episodes.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FILE = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
const DIR = join(CACHE_DIR, 'bgm');
const UA = 'j-anime/0.1 (personal anime tracker)';
const log = (...a) => console.log(...a);

const db = getDb();
initSchema(db);
const metaGet = (k) => db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value ?? null;
const metaSet = (k, v) => db.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);

// ───────────────────────── 1. 取 dump ─────────────────────────
/** Windows 上必须用系统自带的 bsdtar（System32\tar.exe）：Git 带的 GNU tar 不认 zip */
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
// episode.jsonlines：分集（#49 / #47），2026-10-19 加
const NEED = ['subject.jsonlines', 'subject-relations.jsonlines', 'episode.jsonlines'];

async function latestDump() {
  const r = await fetch('https://api.github.com/repos/bangumi/Archive/releases/tags/archive',
    { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`GitHub releases HTTP ${r.status}`);
  const a = (await r.json()).assets.filter((x) => /^dump-.*\.zip$/.test(x.name)).sort((x, y) => (x.name < y.name ? 1 : -1))[0];
  if (!a) throw new Error('release 里没有 dump-*.zip');
  return { name: a.name, url: a.browser_download_url, size: a.size };
}

async function ensureArchive() {
  mkdirSync(DIR, { recursive: true });
  let zip = FILE, name = FILE ? FILE.split(/[\\/]/).pop() : null;
  if (!FILE) {
    const d = await latestDump();
    name = d.name;
    zip = join(DIR, 'dump.zip');
    const same = metaGet('bgm_archive') === d.name;
    if (same && NEED.every((f) => existsSync(join(DIR, f)))) { log(`📦 dump 没变（${d.name}），用缓存`); return name; }
    // dump 没变、只是缺了新加进 NEED 的文件：从已有的 zip 里补解压，别为此重下 400 多 MB
    if (same && existsSync(zip)) return extract(zip, name);
    log(`⬇️  下载 ${d.name}（${(d.size / 1048576).toFixed(0)} MB）`);
    const res = await fetch(d.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    // 先写 .tmp 再改名：中断留下半截文件，下次会被当成完整的
    const tmp = zip + '.tmp';
    try { await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp)); }
    catch (e) { rmSync(tmp, { force: true }); throw e; }
    renameSync(tmp, zip);
  }
  return extract(zip, name);
}

function extract(zip, name) {
  log(`📂 解压 ${NEED.join(' / ')}`);
  const x = spawnSync(TAR, ['-xf', zip, '-C', DIR, ...NEED], { encoding: 'utf8' });
  if (x.status !== 0) throw new Error(`解压失败：${x.stderr || x.error}`);
  for (const f of NEED) if (!existsSync(join(DIR, f)) || statSync(join(DIR, f)).size < 1000) throw new Error(`解压后缺 ${f}`);
  return name;
}

const dumpName = await ensureArchive();

// ───────────────────────── 2. 读入 + 建索引 ─────────────────────────
const lines = (f) => createInterface({ input: createReadStream(join(DIR, f)), crlfDelay: Infinity });
const subjects = new Map();
for await (const l of lines('subject.jsonlines')) {
  if (!l.includes('"type": 2') && !l.includes('"type":2')) continue;   // 先粗筛，94 万行里动画只有 3 万
  const o = JSON.parse(l);
  if (o.type === 2) subjects.set(o.id, parseSubject(o));
}
const relations = [];
for await (const l of lines('subject-relations.jsonlines')) {
  const o = JSON.parse(l);
  if (subjects.has(o.subject_id) && subjects.has(o.related_subject_id))
    relations.push({ a: o.subject_id, b: o.related_subject_id, type: o.relation_type });
}
const idx = buildIndex(subjects, relations);
log(`📚 ${dumpName}：动画 ${subjects.size} 部，动画间关系 ${relations.length} 条`);

// ───────────────────────── 3. 重新匹配每个 AOD 条目 ─────────────────────────
const aliasesOf = new Map();
// 只拿 AOD 自己的别名当匹配证据：bgm 来的（中文名 / infobox 别名）不能反过来证明自己 ——
// 那是「异世界舅舅」那次别名自我强化的老坑
for (const r of db.prepare("SELECT anime_id, alias FROM anime_alias WHERE coalesce(src,'') NOT IN ('bgm','bgm_alias')").all())
  (aliasesOf.get(r.anime_id) ?? aliasesOf.set(r.anime_id, []).get(r.anime_id)).push(r.alias);
const rows = db.prepare(`SELECT id, uid, title, title_ja, title_cn, type, year, episodes, bgm_id, is_stub, is_jp
                         FROM anime WHERE uid NOT LIKE 'bgm:%'`).all();
const results = new Map();
for (const r of rows) results.set(r.id, matchRow(idx, { ...r, aliases: aliasesOf.get(r.id) ?? [] }));

const tally = { 匹配上: 0, 改挂: 0, 新匹配: 0, 清掉错挂: 0, 未匹配: 0 };
for (const r of rows) {
  const m = results.get(r.id);
  if (m.id) { tally.匹配上++; if (r.bgm_id && r.bgm_id !== m.id) tally.改挂++; else if (!r.bgm_id) tally.新匹配++; }
  else { tally.未匹配++; if (r.bgm_id) tally.清掉错挂++; }
}
log('🔗 匹配', tally);

// ───────────────────────── 4. 新条目：bgm 有、库里没有任何条目对上的日本番 ─────────────────────────
const claimed = new Set([...results.values()].map((m) => m.id).filter(Boolean));
const fresh = [...subjects.values()].filter((s) => !claimed.has(s.id) && s.is_jp === 1 && s.type !== 'UNKNOWN');

/**
 * 「收录站数」是 AOD 独有的概念，目录 / 季度浏览 / 快速标记都拿它当「主流程度」（DS2 拍板第 3 条：
 * 改用 bgm 收藏人数）。新条目没有收录站数，这里按「已匹配条目里，同一收藏人数档位的收录站数中位数」
 * 折算一个，让现有的筛选门槛对新番照样成立，不用改所有查询。
 */
const bucket = (c) => Math.floor(Math.log2((c || 0) + 1));
const byBucket = new Map();
const srcOf = new Map(db.prepare('SELECT id, source_count FROM anime WHERE is_stub=0').all().map((x) => [x.id, x.source_count]));
for (const r of rows) {
  const m = results.get(r.id); if (!m.id) continue;
  const src = srcOf.get(r.id);
  if (!src) continue;
  const b = bucket(subjects.get(m.id).collection);
  (byBucket.get(b) ?? byBucket.set(b, []).get(b)).push(src);
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const srcFor = (collection) => {
  for (let b = bucket(collection); b >= 0; b--) if (byBucket.get(b)?.length >= 5) return median(byBucket.get(b));
  return 1;
};
log(`🆕 新条目 ${fresh.length} 部（2026-07 之后开播 ${fresh.filter((s) => (s.air_start ?? '') >= '2026-07').length} 部）`);

/**
 * 折叠重复卡（#18）：同一个 bgm 条目挂着好几条可见的 AOD 行 —— AOD 自己没合并成功的
 * （乱马1/2 第三季 3 张、幼女战记 第二季 2 张、孤独摇滚 #3717 单站影子卡）。
 * 保守：同类型、年份 ±1、外部 ID 不冲突、集数相容（都知道时差不超过 50%）才折；
 * 保留有番单的那条，其次收录站数最多的；番单 / 快速标记 / 日志用 applyAliasDupes 合并（不删）。
 * 实测（正式库副本）448 条可折，没有一组两边都有番单。
 */
const visRows = db.prepare(`SELECT a.id, a.type, a.year, a.episodes, a.source_count, a.mal_id, a.anilist_id, a.anidb_id,
    (SELECT count(*) FROM user_entry_all u WHERE u.anime_id = a.id) has_ue
  FROM anime a WHERE a.is_stub = 0 AND a.uid NOT LIKE 'bgm:%'`).all();
const byBgm = new Map();
for (const r of visRows) {
  const m = results.get(r.id);
  if (m?.id) (byBgm.get(m.id) ?? byBgm.set(m.id, []).get(m.id)).push(r);
}
const clash = (a, b) => ['mal_id', 'anilist_id', 'anidb_id'].some((k) => a[k] && b[k] && a[k] !== b[k]);
// TV 的 1 集多半是 AOD 给未播新番写的占位（桃源暗鬼 日光华严之泷篇 1 集 ↔ 24 集），当「未定」不比
const epsKnown = (r) => r.episodes > (r.type === 'TV' ? 1 : 0);
const epsOk = (a, b) => !(epsKnown(a) && epsKnown(b) && Math.max(a.episodes, b.episodes) / Math.min(a.episodes, b.episodes) > 1.5);
/**
 * 往年的 1–2 集、要折进 6 集以上的正篇 → 那是已经播过的特别篇，不是重复卡，不折
 * （「K-On! 番外篇：冬天的日子」→ 轻音少女、「Free! Dive to the Future: Ima kara」、「Towa no Yugure Episode 0」）。
 * 预告占位是今年以后（或没年份）的 0–1 集，照常折。两道折叠都要过这一关。
 */
const THIS_YEAR = new Date().getFullYear();
const airedSpecial = (r, win) => r.episodes >= 1 && r.episodes <= 2 && (win.episodes ?? 0) >= 6 && r.year && r.year < THIS_YEAR;
const folds = [];
for (const list of byBgm.values()) {
  if (list.length < 2) continue;
  const win = [...list].sort((a, b) => b.has_ue - a.has_ue || (b.source_count ?? 0) - (a.source_count ?? 0) || a.id - b.id)[0];
  // 两条都是「主标题精确」配到同一个 bgm 条目，本身就是强证据：在播新番各站记的集数进度不一样
  // （才女的侍从 12 集 / 4 集、二十世纪电气目录 2 / 13），集数差不再挡；类型记得不同的（进击的巨人
  // 完结篇 前篇：ANN 记 TV、AniDB 记特别篇）要同年同集数才折。已播特别篇的保护照旧
  const strong = (x) => /名/.test(results.get(x.id)?.rule ?? '');
  for (const r of list) {
    if (r === win || clash(r, win) || airedSpecial(r, win)) continue;
    const sure = strong(r) && strong(win);
    // 跨类型只折 2 集以上的：单集的特别篇本身常被错配到剧场版（咒术回战 新年特别篇 → 剧场版 0、
    // 超梦的起源 → 洛奇亚爆诞），跨类型再一折就把错误放大成「卡没了」
    const typeOk = r.type === win.type || (sure && r.year === win.year && r.episodes === win.episodes && r.episodes >= 2);
    // 「不看集数差」只给今年 / 去年的番（在播，集数还在涨）。老作品放开会把分章剧场版折成一张：
    // 人造人009 CALL OF JUSTICE 1/2/3、剑风传奇 黄金时代篇 三部 —— AOD 的日文名一样，都「名」配到同一个条目
    // 在播放宽只给连续播的：剧场版不「追进度」（少女乐队的呐喊 三部剧场版各 1 集 ↔ 总集篇 2 集）；
    // 差 3 倍以上只认少的那边是占位（≤2 集，二十世纪电气目录 2 ↔ 13），凡人修仙传 4 ↔ 52 不折
    const lo = Math.min(r.episodes ?? 0, win.episodes ?? 0), hi = Math.max(r.episodes ?? 0, win.episodes ?? 0);
    const airing = sure && win.type !== 'MOVIE' && (r.year ?? 0) >= THIS_YEAR - 1 && (win.year ?? 0) >= THIS_YEAR - 1
      && (lo <= 2 || hi <= lo * 3);
    if (!typeOk || (!airing && !epsOk(r, win))) continue;
    if (r.year && win.year && Math.abs(r.year - win.year) > 1) continue;
    folds.push({ winner: win.id, loser: r.id });
  }
}
/**
 * 影子卡（2026-10-18 主人在测试站上看到的）：对不上 Bangumi 的可见 AOD 行，其实是同一季的另一份 ——
 * 英文站收录的（「Classroom of the Elite」「Call of the Night」「Mission: Yozakura Family」）、
 * AniDB 的预告占位（「夜桜さんちの大作戦 (2026 2クール)」1 集）。它们标题里没季数、名字不在 bgm 里，
 * 匹配器配不上，就带着旧中文名留成第二张、第三张卡。
 * 折进已匹配的那张，条件全要满足：同类型、同年同季度（都明确）、中文名去掉季数后相同、外部 ID 不冲突、
 * 并且有名字证据 —— 它的标题在对方的名字 / 别名里，或两边日文名前 6 个字相同。
 * 名字证据挡的是「中文名本身就错了」的那种：Naoe-kun（直江くんは痩せさせたい。）中文名错成
 * 「精灵小姐瘦不了。」，和真正的精灵小姐同季同类型，没有名字证据就不能折。
 */
const SEASON_MARK = /\s*第\s*(?:[0-9]+|[一二三四五六七八九十])\s*(?:季|期|部分|部|幕|章)\s*/g;
const cnBase = (s) => normName(String(s ?? '').replace(SEASON_MARK, ''));
const vis2 = db.prepare(`SELECT id, title, title_ja, title_cn, type, year, season, episodes, mal_id, anilist_id, anidb_id
  FROM anime WHERE is_stub = 0 AND uid NOT LIKE 'bgm:%' AND title_cn IS NOT NULL`).all();
const folded = new Set(folds.map((f) => f.loser));
const anchors = new Map();   // cnBase|type|year|season → 已匹配的可见行
for (const r of vis2) {
  if (!results.get(r.id)?.id || folded.has(r.id) || !r.year || !['WINTER', 'SPRING', 'SUMMER', 'FALL'].includes(r.season)) continue;
  const k = `${cnBase(r.title_cn)}|${r.type}|${r.year}|${r.season}`;
  (anchors.get(k) ?? anchors.set(k, []).get(k)).push(r);
}
let shadows = 0;
for (const r of vis2) {
  if (results.get(r.id)?.id || folded.has(r.id)) continue;
  const list = anchors.get(`${cnBase(r.title_cn)}|${r.type}|${r.year}|${r.season}`);
  if (!list || list.length !== 1) continue;            // 对上不止一个就不猜
  const win = list[0];
  if (clash(r, win)) continue;
  if (airedSpecial(r, { episodes: db.prepare('SELECT episodes FROM anime WHERE id=?').get(win.id)?.episodes })) continue;
  const s = subjects.get(results.get(win.id).id);
  const names = new Set([win.title, win.title_ja, s.name, s.name_cn, ...s.aliases, ...(aliasesOf.get(win.id) ?? [])].filter(Boolean).map(normName));
  const pre = (x) => normName(x).slice(0, 6);
  const evidence = [r.title, r.title_ja].some((x) => x && names.has(normName(x)))
    || (r.title_ja && pre(r.title_ja).length === 6 && [win.title_ja, s.name].some((x) => x && pre(x) === pre(r.title_ja)));
  if (!evidence) continue;
  folds.push({ winner: win.id, loser: r.id });
  folded.add(r.id);
  shadows++;
}
log(`🗂  折叠重复卡 ${folds.length} 条（其中对不上 Bangumi 的影子卡 ${shadows}）`);

if (DRY) { log('\n--dry：不写库'); process.exit(0); }

// ───────────────────────── 5. 写库（一个事务） ─────────────────────────
/** 只写和题材对得上的 bgm 标签：bgm 标签混着年份、公司、「TV」「原创」这类，详情页不该被它们淹没 */
const GENRE_TAGS = new Set(GENRES.flatMap(([, tags]) => tags).filter((t) => hasCjk(t)));
const today = new Date().toISOString().slice(0, 10);
const RECENT = `${new Date().getFullYear() - 1}-01-01`;   // 「在播」：去年起开播、还没结束日
const statusOf = (s) => {
  if (s.air_end && s.air_end.length >= 7 && s.air_end <= today) return 'FINISHED';
  if (s.air_start && s.air_start > today) return 'UPCOMING';
  if (s.air_start) return 'ONGOING';   // 有没有播完交给 fix-status 按日期 + 集数推导
  return 'UNKNOWN';
};

const upMatched = db.prepare(`UPDATE anime SET
    bgm_id=@bid, title_cn=coalesce(@name_cn, title_cn), bgm_score=@score, bgm_votes=@votes, bgm_rank=@rank,
    bgm_collection=@collection, bgm_summary=@summary, bgm_air_start=@air_start, bgm_air_end=@air_end,
    bgm_eps=@eps, bgm_name_ja=@name, bgm_nsfw=@nsfw, bgm_match_score=@mscore, bgm_match_rule=@rule,
    bgm_matched_at=datetime('now'),
    is_jp=coalesce(@is_jp, is_jp),
    title_ja=CASE WHEN @name_ja IS NOT NULL THEN @name_ja ELSE title_ja END,
    -- 集数：AOD 写 0 / 1（未播新番的占位）而 bgm 有真实集数 → 用 bgm 的；bgm 也还没定、又是在播的 TV
    -- → 改成未定，别在卡片上印「1 集 · 连载中」（冰之城墙 第二季、药屋少女 第三季…）
    episodes=CASE WHEN @eps > 1 AND coalesce(episodes,0) <= 1 THEN @eps
                  WHEN coalesce(episodes,0)=0 AND @eps IS NOT NULL THEN @eps
                  WHEN @eps IS NULL AND episodes = 1 AND type = 'TV' AND @air_end IS NULL AND @air_start >= @recent THEN NULL
                  ELSE episodes END
  WHERE id=@id`);
/**
 * 对不上的：原来挂的 bgm 数据属于别的条目（特别篇挂着正片、续作挂着前作），清掉；中文名保留（拍板第 1 条）。
 * 试过「旧条目类型 / 年代对不上就连中文名一起清」：抽查下来被清的多半是系列名甚至正确译名
 * （「Iruka to Shounen」→「海豚和少年」、「Black Lagoon CM」→「黑礁」），比退回罗马字有用，所以不清。
 */
const clearWrong = db.prepare(`UPDATE anime SET bgm_id=NULL, bgm_score=NULL, bgm_votes=NULL, bgm_rank=NULL,
    bgm_collection=NULL, bgm_summary=NULL, bgm_air_start=NULL, bgm_air_end=NULL, bgm_eps=NULL, bgm_name_ja=NULL,
    bgm_nsfw=NULL, bgm_match_score=@mscore, bgm_match_rule=@rule, bgm_matched_at=datetime('now') WHERE id=@id`);
/**
 * picture 写 Bangumi 的封面地址：Cover.svelte 只在有 picture / thumbnail 时才去请求 /cover/<id>，
 * 新建条目原来两个都空，2,278 部全显示「无封面」（主人在测试站目录第一排看到 8 张空卡）。
 */
const upFresh = db.prepare(`INSERT INTO anime (uid,title,title_ja,title_cn,type,is_short,episodes,status,season,year,
    picture,source_count,is_stub,is_jp,bgm_id,bgm_score,bgm_votes,bgm_rank,bgm_collection,bgm_summary,bgm_air_start,bgm_air_end,
    bgm_eps,bgm_name_ja,bgm_nsfw,bgm_match_rule,bgm_matched_at)
  VALUES (@uid,@name,@name,@name_cn,@type,0,@eps,@status,@season,@year,
    'https://api.bgm.tv/v0/subjects/' || @bid || '/image?type=large',@src,0,1,@bid,@score,@votes,@rank,@collection,
    @summary,@air_start,@air_end,@eps,@name,@nsfw,'bgm 新建',datetime('now'))
  ON CONFLICT(uid) DO UPDATE SET title=excluded.title, title_ja=excluded.title_ja, title_cn=excluded.title_cn,
    type=excluded.type, episodes=excluded.episodes, status=excluded.status, season=excluded.season, year=excluded.year,
    picture=excluded.picture,
    source_count=excluded.source_count, bgm_score=excluded.bgm_score, bgm_votes=excluded.bgm_votes,
    bgm_rank=excluded.bgm_rank, bgm_collection=excluded.bgm_collection, bgm_summary=excluded.bgm_summary,
    bgm_air_start=excluded.bgm_air_start, bgm_air_end=excluded.bgm_air_end, bgm_eps=excluded.bgm_eps,
    bgm_nsfw=excluded.bgm_nsfw, bgm_matched_at=excluded.bgm_matched_at
  RETURNING id`);
/**
 * 两种来源分开存：src='bgm' 只放 Bangumi 中文名（和 title_cn 对得上，e2e 有不变式守着）；
 * src='bgm_alias' 放 infobox 的别名（锻刀村、波奇、Re0…，SR1 #22）—— 进搜索索引，但不当匹配证据。
 */
const delBgmAlias = db.prepare("DELETE FROM anime_alias WHERE anime_id=? AND src IN ('bgm','bgm_alias')");
const insAlias = db.prepare(`INSERT INTO anime_alias (anime_id,alias,has_kana,is_cjk,src) SELECT ?,?,?,?,?
  WHERE NOT EXISTS (SELECT 1 FROM anime_alias WHERE anime_id=? AND alias=?)`);
const delBgmTags = db.prepare(`DELETE FROM anime_tag WHERE anime_id=? AND tag IN (${[...GENRE_TAGS].map(() => '?').join(',')})`);
const insTag = db.prepare('INSERT INTO anime_tag (anime_id,tag) SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM anime_tag WHERE anime_id=? AND tag=?)');

const bind = (s, extra) => ({ bid: s.id, name: s.name, name_cn: s.name_cn, score: s.score, votes: s.votes, rank: s.rank,
  collection: s.collection, summary: s.summary, air_start: s.air_start, air_end: s.air_end, eps: s.eps, nsfw: s.nsfw, ...extra });
const writeNames = (id, s) => {
  delBgmAlias.run(id);
  if (s.name_cn) insAlias.run(id, s.name_cn, hasKana(s.name_cn) ? 1 : 0, hasCjk(s.name_cn) ? 1 : 0, 'bgm', id, s.name_cn);
  for (const a of new Set(s.aliases.filter((x) => x && x !== s.name_cn)))
    insAlias.run(id, a, hasKana(a) ? 1 : 0, hasCjk(a) ? 1 : 0, 'bgm_alias', id, a);
  delBgmTags.run(id, ...GENRE_TAGS);
  for (const t of s.tags) if (GENRE_TAGS.has(t)) insTag.run(id, t, id, t);
};

let nFresh = 0, revived = 0;
tx(db, () => {
  for (const r of rows) {
    const m = results.get(r.id);
    if (m.id) {
      const s = subjects.get(m.id);
      // title_ja 是去重和搜索置顶的锚：bgm 原名是权威的日文标题（只在它确实是日文 / 汉字时才用）
      const nameJa = s.name && (hasKana(s.name) || hasCjk(s.name)) ? s.name : null;
      upMatched.run(bind(s, { id: r.id, mscore: m.score, rule: m.rule, is_jp: s.is_jp, name_ja: nameJa, recent: RECENT }));
      writeNames(r.id, s);
    } else if (r.bgm_id) {
      clearWrong.run({ id: r.id, mscore: m.score, rule: m.rule });
      delBgmAlias.run(r.id);
    }
  }
  for (const s of fresh) {
    const { id } = upFresh.get(bind(s, { uid: `bgm:${s.id}`, type: s.type, status: statusOf(s), season: s.season,
      year: s.year, src: srcFor(s.collection) }));
    writeNames(id, s);
    nFresh++;
  }
  // 折叠放在最后：上面已把 bgm 数据写到了两边，赢家拿到的是同一份
  if (folds.length) applyAliasDupes(db, folds, { inTx: true });
  // 手工校正的中文名（#14）每天再套一遍：Bangumi 对不上的那几条，别的步骤写回错名字时第二天自己改回来
  applyCnManual(db);
  // 封面「已死」标记对有 bgm 条目的番每天放开一次：标记常打在匹配上 bgm 之前（只有失效的 MAL 链接），
  // 或 bgm 新条目当时还没传封面；不放开的话封面路由连 bgm 都不再试（和没有信徒的女神大人… 一直空卡）
  revived = db.prepare(`UPDATE anime SET cover_dead = 0
    WHERE cover_dead = 1 AND bgm_id IS NOT NULL AND cover_local_path IS NULL AND is_stub = 0`).run().changes;
  metaSet('bgm_archive', dumpName);
  metaSet('bgm_archive_at', new Date().toISOString());
  db.prepare(`INSERT INTO sync_log (kind,started_at,finished_at,items,status,error)
              VALUES ('bgm_ingest',datetime('now'),datetime('now'),?,'ok',?)`)
    .run(tally.匹配上 + nFresh, `${dumpName} · 匹配 ${tally.匹配上} · 改挂 ${tally.改挂} · 清掉错挂 ${tally.清掉错挂} · 新建 ${nFresh} · 折叠 ${folds.length}`);
});
/**
 * 分集（#49 / #47）：dump 换了（或表还是空的）才重灌 —— 26 万行，每天都灌是白干。
 * 只留库里有的条目的正片（type 0）；在播番的最新几集由 sync-episodes.js 每天用 API 补。
 */
const epEmpty = !db.prepare('SELECT 1 FROM bgm_episode LIMIT 1').get();
if (epEmpty || metaGet('bgm_episode_dump') !== dumpName) {
  const ids = new Set(db.prepare('SELECT DISTINCT bgm_id FROM anime WHERE bgm_id IS NOT NULL').all().map((r) => r.bgm_id));
  const keep = [];
  for await (const l of lines('episode.jsonlines')) {
    if (!l) continue;
    const e = JSON.parse(l);
    // 只留要的字段：description（剧情简介）占了文件的大头，不进库
    if (e.type === 0 && ids.has(e.subject_id))
      keep.push({ id: e.id, subject_id: e.subject_id, sort: e.sort, name: e.name, name_cn: e.name_cn, airdate: e.airdate, duration: e.duration });
  }
  tx(db, () => { db.exec('DELETE FROM bgm_episode'); upsertEpisodes(db, keep); });
  metaSet('bgm_episode_dump', dumpName);
  log(`🎞  分集 ${keep.length.toLocaleString()} 集（${ids.size.toLocaleString()} 个条目）`);
}

log(`✅ 已写入 ${DB_PATH}：匹配 ${tally.匹配上}（改挂 ${tally.改挂}）· 清掉错挂 ${tally.清掉错挂} · 新建 / 更新 bgm 条目 ${nFresh} · 折叠 ${folds.length} · 封面重试 ${revived}`);
log('   之后要跑 mark-nsfw.js、fix-status.js、reindex-fts.js（每日同步里已排好）');
