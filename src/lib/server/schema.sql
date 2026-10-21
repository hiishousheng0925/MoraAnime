PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────────────────────
--  番剧元数据（可重灌，同步脚本只写这些表）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS anime (
  id            INTEGER PRIMARY KEY,
  uid           TEXT NOT NULL UNIQUE,   -- 稳定自然键（首个 source URL），重灌时 id 不变
  title         TEXT NOT NULL,          -- AOD 主标题（罗马字/英文）
  title_ja      TEXT,                   -- 日文原名（从 synonyms 提取）
  title_cn      TEXT,                   -- 中文名（bgm 补全）
  type          TEXT,                   -- TV/MOVIE/OVA/ONA/SPECIAL/UNKNOWN
  is_short      INTEGER NOT NULL DEFAULT 0,  -- 泡面番：TV 且单集<=15min
  episodes      INTEGER,
  status        TEXT,                   -- FINISHED/ONGOING/UPCOMING/UNKNOWN
  season        TEXT,                   -- WINTER/SPRING/SUMMER/FALL
  year          INTEGER,
  duration_sec  INTEGER,
  picture       TEXT,
  thumbnail     TEXT,
  score_aod     REAL,                   -- ⚠️ 无投票数，不可用于排序
  source_count  INTEGER NOT NULL DEFAULT 0,  -- 知名度代理指标
  is_stub       INTEGER NOT NULL DEFAULT 0,  -- 疑似重复的残缺条目
  is_jp         INTEGER NOT NULL DEFAULT 0,  -- 别名含假名 → 判定日本作品
  -- 外部 id（从 sources 解析）
  mal_id        INTEGER,
  anilist_id    INTEGER,
  anidb_id      INTEGER,
  -- bgm 补全（第二阶段脚本填）
  bgm_id        INTEGER,
  bgm_score     REAL,
  bgm_votes     INTEGER,
  bgm_rank      INTEGER,
  bgm_collection INTEGER,
  bgm_summary   TEXT,
  bgm_weekday   INTEGER,                -- 1-7，放送星期
  bgm_matched_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_anime_year    ON anime(year);
CREATE INDEX IF NOT EXISTS idx_anime_type    ON anime(type);
CREATE INDEX IF NOT EXISTS idx_anime_status  ON anime(status);
CREATE INDEX IF NOT EXISTS idx_anime_season  ON anime(year, season);
CREATE INDEX IF NOT EXISTS idx_anime_srccnt  ON anime(source_count DESC);
CREATE INDEX IF NOT EXISTS idx_anime_bgmcoll ON anime(bgm_collection DESC);
CREATE INDEX IF NOT EXISTS idx_anime_mal     ON anime(mal_id);
CREATE INDEX IF NOT EXISTS idx_anime_bgm     ON anime(bgm_id);
-- 导入备份按 anilist_id → mal_id → bgm_id → 标题 逐级定位条目（backup.js makeResolver）。
-- 2026-10-21 审核：anilist_id 是第一级、title 是兜底那两级，原来没索引，每解析一行扫一遍 4 万行
CREATE INDEX IF NOT EXISTS idx_anime_anilist ON anime(anilist_id);
CREATE INDEX IF NOT EXISTS idx_anime_title   ON anime(title);
-- 放送表只取有更新日的 ~76 行；没有这条时规划器走年份索引扫大半张表（10.8ms）
CREATE INDEX IF NOT EXISTS idx_anime_weekday ON anime(bgm_weekday) WHERE bgm_weekday IS NOT NULL;

CREATE TABLE IF NOT EXISTS anime_alias (
  anime_id INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  alias    TEXT NOT NULL,
  has_kana INTEGER NOT NULL DEFAULT 0,
  is_cjk   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alias_anime ON anime_alias(anime_id);

CREATE TABLE IF NOT EXISTS anime_tag (
  anime_id INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL
);
-- ⚡ (anime_id, tag) 必须是复合索引，不能只索引 anime_id。
-- 目录页的题材筛选是 EXISTS (… WHERE t.anime_id=a.id AND t.tag IN (…))，
-- 只有 anime_id 的索引会让 SQLite 拿到 rowid 后【回表读 tag 再比】，
-- 41,537 行每行回表一次。实测两个题材的 count(*)：57.7ms → 23.0ms。
-- 复合索引的第一列就是 anime_id，原来那条单列索引成了纯冗余，删掉。
CREATE INDEX IF NOT EXISTS idx_tag_pair ON anime_tag(anime_id, tag);
DROP INDEX IF EXISTS idx_tag_anime;
CREATE INDEX IF NOT EXISTS idx_tag_name  ON anime_tag(tag);

CREATE TABLE IF NOT EXISTS anime_studio (
  anime_id INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  studio   TEXT NOT NULL,
  role     TEXT NOT NULL DEFAULT 'studio'   -- studio | producer
);
-- 同上：制作公司筛选也是 EXISTS (… WHERE s.anime_id=a.id AND s.studio_norm=?)
CREATE INDEX IF NOT EXISTS idx_studio_pair ON anime_studio(anime_id, studio_norm);
DROP INDEX IF EXISTS idx_studio_anime;
CREATE INDEX IF NOT EXISTS idx_studio_name  ON anime_studio(studio);

CREATE TABLE IF NOT EXISTS anime_source (
  anime_id INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  site     TEXT NOT NULL,
  url      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_src_anime ON anime_source(anime_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_src_url ON anime_source(url);

-- relatedAnime 原始 URL（⚠️ AOD 不带关系类型，只能做无向分组）
CREATE TABLE IF NOT EXISTS anime_related_raw (
  anime_id INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  url      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rel_anime ON anime_related_raw(anime_id);
CREATE INDEX IF NOT EXISTS idx_rel_url   ON anime_related_raw(url);

-- ─────────────────────────────────────────────────────────────
--  搜索索引：CJK 逐字切分 + 拉丁词保留（unicode61）
--  这样 2 字的「鬼灭」也能命中（trigram 需要>=3字符，不适用中文）
-- ─────────────────────────────────────────────────────────────
-- ⚠️ 不用 content=''（contentless 表无法按 rowid 删除，中文名补全后没法增量更新索引）
CREATE VIRTUAL TABLE IF NOT EXISTS anime_fts USING fts5(
  seg,
  tokenize='unicode61 remove_diacritics 2'
);

-- ─────────────────────────────────────────────────────────────
--  我的数据（不可再生，同步脚本永不触碰）
-- ─────────────────────────────────────────────────────────────
-- 个人数据（番单 user_entry / 快速标记 triage / 观看日志 watch_log / 我的筛选 saved_filter /
-- 标签 user_tag）和账号、会话表不在这里：它们按账号隔离，建法见 src/lib/server/multiUser.js
-- （*_all 真表 + 同名视图 + 触发器；触发器带分号，这个文件按分号切不了）。

-- 筛选器选项缓存：tags 那条查询要扫 58 万行、冷启动 3.6 秒，
-- 而选项只在重灌元数据时才变 —— 所以物化下来
CREATE TABLE IF NOT EXISTS facet_cache (
  key        TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  built_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_log (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  items        INTEGER,
  status       TEXT,
  error        TEXT
);

-- 封面本地缓存（老番的 MAL CDN 链接大量失效，热链会破图）
-- cover_dead=1 表示确认死链，UI 直接走占位符不再重试
CREATE TABLE IF NOT EXISTS franchise (
  id         INTEGER PRIMARY KEY,
  name       TEXT,
  size       INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS franchise_member (
  franchise_id  INTEGER NOT NULL REFERENCES franchise(id) ON DELETE CASCADE,
  anime_id      INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  release_order INTEGER,
  is_skippable  INTEGER NOT NULL DEFAULT 0,
  skip_reason   TEXT,
  PRIMARY KEY (franchise_id, anime_id)
);
CREATE INDEX IF NOT EXISTS idx_fm_anime ON franchise_member(anime_id);

-- 手动补的关系（AOD 有 43.8% 的条目没有任何关联数据）
CREATE TABLE IF NOT EXISTS manual_relation (
  a_id       INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  b_id       INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (a_id, b_id)
);
CREATE INDEX IF NOT EXISTS idx_mr_b ON manual_relation(b_id);

-- 观看站：主人自己配的 URL 模板，详情页渲染成跳转按钮。
-- 只存模板、只生成链接，不请求对方站点、不解析对方页面。
-- url 里的占位符见 src/lib/watchSite.js：{cn} / {ja} / {romaji} / {title}
CREATE TABLE IF NOT EXISTS watch_site (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  url      TEXT NOT NULL,
  ord      INTEGER NOT NULL DEFAULT 0,
  enabled  INTEGER NOT NULL DEFAULT 1
);

-- 设置项（NSFW 开关等）
CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 分集（#49 分集列表 / #47 今天更新）：Bangumi 的正片分集。写入见 src/lib/server/episodes.js
-- 来源：每周导出 episode.jsonlines（ingest-bgm.js 全量）+ 每日 API（sync-episodes.js 只刷在播的）
CREATE TABLE IF NOT EXISTS bgm_episode (
  id         INTEGER PRIMARY KEY,   -- Bangumi 分集 id
  subject_id INTEGER NOT NULL,      -- = anime.bgm_id
  sort       REAL,
  name       TEXT,
  name_cn    TEXT,
  airdate    TEXT,                  -- 日本播出日期 YYYY-MM-DD，未定为 NULL
  duration   TEXT
);
CREATE INDEX IF NOT EXISTS idx_ep_subject ON bgm_episode(subject_id, sort);
CREATE INDEX IF NOT EXISTS idx_ep_airdate ON bgm_episode(airdate);
