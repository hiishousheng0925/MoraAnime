/**
 * 灌库：anime-offline-database → SQLite
 *
 * 数据源：GitHub release 静态 dump（5.8MB zst / 59MB json），无 API 依赖。
 * 实测 41,537 条。详见 DATA-SOURCES.md
 *
 * 用法：
 *   node scripts/ingest-aod.js              # 有缓存用缓存
 *   node scripts/ingest-aod.js --refresh    # 强制重新下载
 *   node scripts/ingest-aod.js --refresh --new-only
 *       ↑ 每天定时用这个。只把「库里没有的 uid」灌进去，
 *         已有条目仅刷新 anime 表的标量字段（集数/状态/封面/评分）。
 *         全量模式会 DELETE 再重灌 alias/tag/studio/source/relation 五张表
 *         （130 万行），每天跑一次会让站点卡好几分钟，且期间搜索索引是空的。
 */
import { getDb, initSchema, tx, DB_PATH } from '../src/lib/server/db.js';
import { CACHE_DIR } from '../src/lib/server/paths.js';
import { segment, hasKana, hasCjk, normTitle, normStudio, dedupKey, pickTitleJa } from '../src/lib/server/text.js';
import { existsSync, mkdirSync, createWriteStream, statSync, renameSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';

const JSON_PATH = join(CACHE_DIR, 'aod.json');
const URL_ZST =
  'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json.zst';

const SITE_RE = /^https?:\/\/(?:www\.)?([^/]+)/;
const SHORT_SEC = 15 * 60; // 泡面番阈值：单集 <=15 分钟

function log(...a) { console.log(...a); }

async function ensureData(refresh) {
  mkdirSync(CACHE_DIR, { recursive: true });
  if (!refresh && existsSync(JSON_PATH)) {
    log(`📦 用缓存: ${JSON_PATH} (${(statSync(JSON_PATH).size / 1048576).toFixed(1)} MB)`);
    return;
  }
  log(`⬇️  下载 ${URL_ZST}`);
  // 60MB 的文件给 10 分钟；没有超时的话网络半死不活时能一直挂着（#42）
  const res = await fetch(URL_ZST, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  // 边下边解压，不落中间的 .zst 文件。
  // 原先调外部 `zstd` 命令（还要 brew install），Windows 上根本没这个程序；
  // node:zlib 自 22.15 起内置 zstd，改用它就没有平台依赖了。
  // 先写 .tmp，完整了再改名（#42）：原来直接写 aod.json，下载中断留下半截文件，
  // 下次不带 --refresh 就会读到坏文件
  const tmp = JSON_PATH + '.tmp';
  try { await pipeline(res.body, createZstdDecompress(), createWriteStream(tmp)); }
  catch (e) { rmSync(tmp, { force: true }); throw e; }
  renameSync(tmp, JSON_PATH);
  log(`   解压到 ${(statSync(JSON_PATH).size / 1048576).toFixed(1)} MB`);
}

function extIds(sources) {
  const out = { mal_id: null, anilist_id: null, anidb_id: null };
  for (const u of sources) {
    let m;
    if ((m = u.match(/myanimelist\.net\/anime\/(\d+)/))) out.mal_id = +m[1];
    else if ((m = u.match(/anilist\.co\/anime\/(\d+)/))) out.anilist_id = +m[1];
    else if ((m = u.match(/anidb\.net\/anime\/(\d+)/))) out.anidb_id = +m[1];
  }
  return out;
}

const durSec = (d) => {
  if (!d || d.value == null) return null;
  const u = (d.unit || 'SECONDS').toUpperCase();
  return u === 'SECONDS' ? d.value : u === 'MINUTES' ? d.value * 60 : u === 'HOURS' ? d.value * 3600 : d.value;
};

async function main() {
  const refresh = process.argv.includes('--refresh');
  const newOnly = process.argv.includes('--new-only');
  await ensureData(refresh);

  log('📖 解析 JSON…');
  const raw = JSON.parse(await readFile(JSON_PATH, 'utf8'));
  const rows = raw.data;
  log(`   ${rows.length} 条  (dump lastUpdate: ${raw.lastUpdate})`);

  const db = getDb();
  initSchema(db);

  // ── 预处理 + 去重标记 ────────────────────────────────
  // 实测：source URL 在条目间零共用，所以只能按「标题+年份+type」分组，
  // 保留 sources 最多的作为主条目，其余标 is_stub。（One Piece 案例）
  const prepped = rows.map((x) => {
    const sources = x.sources || [];
    const syns = x.synonyms || [];
    const ja = pickTitleJa(syns, x.title);
    const dsec = durSec(x.duration);
    return {
      uid: (sources.slice().sort()[0]) || `no-src:${normTitle(x.title)}:${x.animeSeason?.year ?? ''}:${x.type}`,
      title: x.title,
      title_ja: ja,
      type: x.type || 'UNKNOWN',
      is_short: x.type === 'TV' && dsec != null && dsec > 0 && dsec <= SHORT_SEC ? 1 : 0,
      episodes: x.episodes ?? null,
      status: x.status || 'UNKNOWN',
      season: x.animeSeason?.season ?? null,
      year: x.animeSeason?.year ?? null,
      duration_sec: dsec,
      picture: x.picture ?? null,
      thumbnail: x.thumbnail ?? null,
      score_aod: x.score?.arithmeticMean ?? null,
      source_count: sources.length,
      /**
       * 是不是日本作品。目录页默认只看日本作品、快速标记的出题池也只要日本作品，
       * 所以判错就等于「这部番在站里搜不到」。
       *
       * 只看假名是不够的：标题全是汉字的日本番一个假名都没有 —— 实测漏掉 1,163 条，
       * 其中收录站点 >=8 的 TV 有 374 部（化物語、暗殺教室、亜人、ACCA、風夏…）。
       * AOD 的 tags 里有产地标签，'japanese production' 这一条精度很高（抽查 20 部全对）。
       * 只加不减：反过来用「中/韩产地标签」去排除会误伤 —— 灵剑山、神之塔那类
       * 中韩原作但由日本公司制作的番，恰好没有 japanese production 标签。
       */
      is_jp: syns.some(hasKana) || hasKana(x.title) || (x.tags || []).includes('japanese production') ? 1 : 0,
      ...extIds(sources),
      _sources: sources,
      _syns: syns,
      _tags: x.tags || [],
      _studios: x.studios || [],
      _producers: x.producers || [],
      _related: x.relatedAnime || [],
      _grp: `${dedupKey(x.title, x.animeSeason?.year)}|${x.animeSeason?.year ?? ''}|${x.type}`
    };
  });

  // ⚠️ 守卫：同一组里若出现多个不同的官方 ID（MAL / AniList），说明上游把它们
  //    当成不同作品 —— 不能因为标题写法像就合掉。实测这条守住了 100 处误合，
  //    比如《我们无法学习》第一季和第二季只差一个「!」。
  //    没有官方 ID 的碎片条目，挂到来源数最多的那一桶。
  //    ⚠️ 冲突只能在【同一个命名空间】内判定。一条只有 mal_id、另一条只有
  //    anilist_id 时，两个数字互相说明不了任何事 —— 早先把它们当成「上游认为是
  //    两部作品」，结果《トミカとトム シーズン2》两条 TV 条目一直合不上。
  const byGrp = new Map();
  for (const r of prepped) {
    if (!byGrp.has(r._grp)) byGrp.set(r._grp, []);
    byGrp.get(r._grp).push(r);
  }
  //    只用 MAL 和 AniList 判冲突，不用 anidb_id —— AniDB 按 cour 拆条，
  //    粒度比另两家细得多，拿它判会把同一部番又拆回去（实测 Yoroi 会多出一张卡）
  const NS = ['mal_id', 'anilist_id'];
  let stubs = 0, guarded = 0;
  for (const g of byGrp.values()) {
    // 找出「同一站点给了两个不同 id」的那个命名空间
    const conflict = NS.find((k) => new Set(g.map((r) => r[k]).filter((x) => x != null)).size > 1);
    let buckets;
    if (!conflict) buckets = [g];
    else {
      guarded++;
      const m = new Map();
      const noId = [];
      for (const r of g) {
        const i = r[conflict];
        if (i == null) { noId.push(r); continue; }
        if (!m.has(i)) m.set(i, []);
        m.get(i).push(r);
      }
      // 该站点没收录的碎片条目，挂到来源数最多的那一桶
      [...m.values()].sort((a, b) => b[0].source_count - a[0].source_count)[0].push(...noId);
      buckets = [...m.values()];
    }
    for (const b of buckets) {
      const p = b.reduce((x, y) => (y.source_count > x.source_count ? y : x));
      for (const r of b) { r.is_stub = p === r ? 0 : 1; stubs += r.is_stub; }
    }
  }
  log(`🔀 重复条目：标记 ${stubs} 条为 is_stub（保留 sources 最多的为主条目）`);
  log(`   其中 ${guarded} 组因官方 ID 不同被拆开，未合并`);

  // ── 写库 ────────────────────────────────────────────
  // 增量模式先记下已有的 uid，据此判断哪些条目要连子表一起灌
  const known = newOnly
    ? new Set(db.prepare('SELECT uid FROM anime').all().map((r) => r.uid))
    : null;
  if (newOnly) log(`🔎 增量模式：库里已有 ${known.size} 个 uid`);

  log('💾 写入…');
  if (!newOnly) {
    db.exec('BEGIN');   // 和下面整轮写入同一个事务，见 run()（#42）
    db.exec('DELETE FROM anime_fts; DELETE FROM anime_related_raw; DELETE FROM anime_source; DELETE FROM anime_studio; DELETE FROM anime_tag;');
    // ⚠️ 别名表不能整张清：enrich-bgm 往里加过中文名（实测 4,233 条）。
    // 整张 DELETE 会把它们删掉，且 reindex-fts 全量重建时读的正是这张表。
    const gone = db.prepare("DELETE FROM anime_alias WHERE src IS NULL OR src <> 'bgm'").run().changes;
    const kept = db.prepare("SELECT count(*) c FROM anime_alias WHERE src = 'bgm'").get().c;
    log(`🧹 清掉 ${gone} 条 AOD 别名，保留 ${kept} 条 bgm 中文名别名`);
  }

  const upAnime = db.prepare(`
    INSERT INTO anime (uid,title,title_ja,type,is_short,episodes,status,season,year,
      duration_sec,picture,thumbnail,score_aod,source_count,is_stub,is_jp,mal_id,anilist_id,anidb_id)
    VALUES (@uid,@title,@title_ja,@type,@is_short,@episodes,@status,@season,@year,
      @duration_sec,@picture,@thumbnail,@score_aod,@source_count,@is_stub,@is_jp,@mal_id,@anilist_id,@anidb_id)
    ON CONFLICT(uid) DO UPDATE SET
      title=excluded.title, title_ja=excluded.title_ja, type=excluded.type,
      is_short=excluded.is_short, episodes=excluded.episodes, status=excluded.status,
      season=excluded.season, year=excluded.year, duration_sec=excluded.duration_sec,
      picture=excluded.picture, thumbnail=excluded.thumbnail, score_aod=excluded.score_aod,
      source_count=excluded.source_count, is_stub=excluded.is_stub, is_jp=excluded.is_jp,
      mal_id=excluded.mal_id, anilist_id=excluded.anilist_id, anidb_id=excluded.anidb_id,
      updated_at=datetime('now')
    RETURNING id`);
  /**
   * ⚠️ 增量模式下已有条目只刷「上游说了算」的字段（#8）。
   * 原来 --new-only 也走上面那条全量 UPSERT，每天 04:30 把 is_stub / is_jp / title_ja /
   * 外部 ID / 集数统统冲回 AOD 原值，再靠后面 6 个 fix-* 脚本改回来 —— 2,095 条被折叠的
   * 条目每天先「复活」再折回去，中间任何一步失败，错的状态就挂一整天。
   * 这几列归修正脚本管：is_stub/dup_of（去重）、is_jp（fix-isjp）、title_ja（fix-title-ja）、
   * mal/anilist/anidb_id（去重会把输家的 ID 补给赢家）。集数只在上游给了正数时才跟（0 = 未定）。
   */
  const upKnown = db.prepare(`UPDATE anime SET
      title=@title, type=@type, is_short=@is_short, status=@status, season=@season, year=@year,
      duration_sec=@duration_sec, picture=@picture, thumbnail=@thumbnail, score_aod=@score_aod,
      source_count=@source_count,
      episodes=CASE WHEN @episodes > 0 THEN @episodes ELSE episodes END,
      updated_at=datetime('now')
    WHERE uid=@uid`);
  const KNOWN_BIND = ['uid','title','type','is_short','status','season','year','duration_sec',
    'picture','thumbnail','score_aod','source_count','episodes'];
  const insAlias  = db.prepare(`INSERT INTO anime_alias (anime_id,alias,has_kana,is_cjk,src)
    SELECT ?,?,?,?,'aod'
    WHERE NOT EXISTS (SELECT 1 FROM anime_alias WHERE anime_id=? AND alias=?)`);
  const insTag    = db.prepare('INSERT INTO anime_tag (anime_id,tag) VALUES (?,?)');
  const insStudio = db.prepare('INSERT INTO anime_studio (anime_id,studio,role,studio_norm) VALUES (?,?,?,?)');
  const insSrc    = db.prepare('INSERT OR IGNORE INTO anime_source (anime_id,site,url) VALUES (?,?,?)');
  const insRel    = db.prepare('INSERT INTO anime_related_raw (anime_id,url) VALUES (?,?)');
  const insFts    = db.prepare('INSERT INTO anime_fts (rowid,seg) VALUES (?,?)');

  // node:sqlite 不允许多余的命名参数，所以只挑语句用到的字段
  const BIND = ['uid','title','title_ja','type','is_short','episodes','status','season','year',
    'duration_sec','picture','thumbnail','score_aod','source_count','is_stub','is_jp',
    'mal_id','anilist_id','anidb_id'];
  const bind = (r) => Object.fromEntries(BIND.map((k) => [k, r[k]]));

  let added = 0;
  const runOne = (list) => {
    for (const r of list) {
      const isNew = !known || !known.has(r.uid);
      // 已有条目在增量模式下只刷标量字段（而且不碰修正脚本管的那几列，见 upKnown）：
      // 子表内容一年也不会变，重灌它们才是那 130 万行的来源
      if (!isNew) { upKnown.run(Object.fromEntries(KNOWN_BIND.map((k) => [k, r[k]]))); continue; }
      const { id } = upAnime.get(bind(r));
      added++;
      for (const a of new Set([r.title, ...r._syns].filter(Boolean)))
        insAlias.run(id, a, hasKana(a) ? 1 : 0, hasCjk(a) ? 1 : 0, id, a);
      for (const t of new Set(r._tags)) insTag.run(id, t);
      for (const s of new Set(r._studios)) insStudio.run(id, s, 'studio', normStudio(s));
      for (const s of new Set(r._producers)) insStudio.run(id, s, 'producer', normStudio(s));
      for (const u of r._sources) insSrc.run(id, (u.match(SITE_RE)?.[1] ?? '?'), u);
      for (const u of r._related) insRel.run(id, u);
      insFts.run(id, segment([r.title, ...r._syns].join(' ')));
    }
  };
  // 全量模式：上面的 DELETE 已经在外层事务里，整轮写完才提交（重建期间站点看到的是旧数据）；
  // 增量模式照旧分块提交
  const run = (list) => (newOnly ? tx(db, () => runOne(list)) : runOne(list));

  const CHUNK = 2000;
  for (let i = 0; i < prepped.length; i += CHUNK) {
    run(prepped.slice(i, i + CHUNK));
    process.stdout.write(`\r   ${Math.min(i + CHUNK, prepped.length)}/${prepped.length}`);
  }
  if (!newOnly) db.exec('COMMIT');

  process.stdout.write('\n');

  db.prepare(`INSERT INTO meta (key,value) VALUES ('aod_last_update',?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(raw.lastUpdate ?? '');
  db.prepare(`INSERT INTO sync_log (kind,started_at,finished_at,items,status)
              VALUES (?,datetime('now'),datetime('now'),?,'ok')`)
    .run(newOnly ? 'aod_ingest_incr' : 'aod_ingest', newOnly ? added : prepped.length);
  if (newOnly) log(`\n🆕 新增 ${added} 条`);

  // 收尾自愈：灌库时 FTS 的 seg 只来自 title + synonyms，
  // 中文名不进去的话搜中文会漏（实测 1,065 条）。以前靠事后手跑 reindex-fts --cn，
  // 但这脚本会被定时任务单独调用，不能指望第二条命令。所以这里就地补上。
  const cnRows = db.prepare(`SELECT a.id, a.title, a.title_ja, a.title_cn,
      (SELECT group_concat(alias, ' ') FROM anime_alias WHERE anime_id = a.id) aliases
    FROM anime a WHERE a.title_cn IS NOT NULL`).all();
  if (cnRows.length) {
    const delF = db.prepare('DELETE FROM anime_fts WHERE rowid = ?');
    const insF = db.prepare('INSERT INTO anime_fts (rowid, seg) VALUES (?, ?)');
    tx(db, () => {
      for (const r of cnRows) {
        delF.run(r.id);
        insF.run(r.id, segment([r.title, r.title_ja, r.title_cn, r.aliases].filter(Boolean).join(' ')));
      }
    });
    log(`🔤 已把 ${cnRows.length} 条中文名并进搜索索引`);
  }
  // 孤儿索引行（anime 被删过才会有），留着会让搜索命中已不存在的 id
  const orphan = db.prepare(`DELETE FROM anime_fts
    WHERE rowid NOT IN (SELECT id FROM anime)`).run().changes;
  if (orphan) log(`🧹 清掉 ${orphan} 条孤儿索引行`);

  db.exec('ANALYZE');
  const { rebuildFacets } = await import('../src/lib/server/queries.js');
  rebuildFacets();   // 筛选器选项物化，否则目录页每次请求现算要 3.6 秒
  const q = (s) => db.prepare(s).get();
  log('\n✅ 灌库完成');
  log(`   anime          ${q('SELECT count(*) c FROM anime').c}`);
  log(`   ├─ 非 stub     ${q('SELECT count(*) c FROM anime WHERE is_stub=0').c}`);
  log(`   ├─ 日本作品    ${q('SELECT count(*) c FROM anime WHERE is_jp=1').c}`);
  log(`   ├─ 泡面番      ${q('SELECT count(*) c FROM anime WHERE is_short=1').c}`);
  log(`   └─ 连载中      ${q("SELECT count(*) c FROM anime WHERE status='ONGOING'").c}`);
  log(`   别名           ${q('SELECT count(*) c FROM anime_alias').c}`);
  log(`   标签           ${q('SELECT count(*) c FROM anime_tag').c}`);
  log(`   跨站链接       ${q('SELECT count(*) c FROM anime_source').c}`);
  log(`   关联作品边     ${q('SELECT count(*) c FROM anime_related_raw').c}`);
  log(`   DB 大小        ${(statSync(DB_PATH).size / 1048576).toFixed(1)} MB`);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
