/**
 * 中文名补全：Bangumi (bgm.tv) → anime.title_cn
 *
 * 为什么必须做：实测 AniList/AOD 对日漫的中文名覆盖仅 6.3%，等于没有。
 * 主人看中文字幕、要中文界面，所以这是 P0 刚需。详见 DATA-SOURCES.md
 *
 * 匹配路径：AOD 的日文原名 → bgm 搜索 → 年份±1 + 标题相似度 校验 → name_cn
 *
 * 用法：
 *   node scripts/enrich-bgm.js --limit 20 --dry   # 干跑，看匹配质量
 *   node scripts/enrich-bgm.js --limit 6000       # 正式跑（可中断，可续跑）
 *   node scripts/enrich-bgm.js --mine            # 只补自己番单里还没中文名的（忽略「已试过」标记）
 *   node scripts/enrich-bgm.js --from 2024 --retry --limit 3000   # 补 2024 年起的，连试过没中的一起重试
 */
import { getDb, initSchema } from '../src/lib/server/db.js';
import { normTitle, segment, fixCnSeason, hasKana, SIMPLIFIED } from '../src/lib/server/text.js';

const UA = 'j-anime/0.1 (personal anime tracker; contact via github)';
const BGM = 'https://api.bgm.tv';
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? (process.argv[i + 1] ?? d) : d;
};
const LIMIT = +arg('--limit', 200);
const DRY = process.argv.includes('--dry');
const DELAY = +arg('--delay', 350); // ms between requests，对 bgm 客气点
/**
 * --mine：只补【自己番单里】还没有中文名的那些。
 *
 * 常规队列是按 bgm_matched_at IS NULL 走的，匹配失败过一次就永久跳过；
 * 而番单里显示成罗马音的番恰恰是「当初匹配失败」的那批 —— 主人看到的就是这些。
 * 这个模式忽略 bgm_matched_at，专门重试自己标过的番（数量少，重试成本可以忽略）。
 */
const MINE = process.argv.includes('--mine');
/** --ids 1,2,3：只处理这几条。诊断「为什么这部没匹配上」时用 */
const IDS = (arg('--ids', '') || '').split(',').map((x) => +x).filter(Boolean);
/** --from 2024：只补这一年及以后的。主人在看哪一季就先补那一季 */
const FROM = +arg('--from', 0);
const MIN_SRC = +arg('--min-sources', 0);
/**
 * --retry：连「试过但没匹配上」的一起重试。
 * 常规队列按 bgm_matched_at IS NULL 走，失败一次就永久跳过（全库 1,529 条），
 * 而 bgm 上的条目会随时间补齐，隔一段时间重试是有意义的。
 */
const RETRY = process.argv.includes('--retry') || MINE;
/**
 * ⛔ 不要给定时同步加「重扫没中文名的那批」——查过了，收益是 0。
 *
 * 起因：定时同步连续四天打印「待处理 0 / 命中率 0.0%」，看起来像每天 800 条额度
 * 在空转、中文名覆盖率卡死在 54.8%（14,463 / 26,370）。实际不是 ——
 * 常规队列是 bgm_matched_at IS NULL，全库确实【已经全部匹过一遍了】，
 * 「待处理 0」的正确读法是「今天没有新番要匹」，不是「坏了」。
 *
 * 真去重扫了两段，各 40 条实跑（2026-09-15）：
 *   A. 已匹到 bgm 条目、但 bgm 自己没有中文名 —— 1,815 条
 *      → 重匹命中 32/40 (80%)，【新增中文名 0】。bgm 那边 name_cn 就是空的。
 *   B. 根本没匹到 bgm 条目的真失败 —— 10,092 条（其中 >=6 站收录 1,319）
 *      → 拿收录站数最高的那段跑，命中 0/40，【新增中文名 0】。bgm 上确实没有。
 *
 * 结论：11,907 条没中文名不是「匹配器漏了」，是【数据源没有】。
 * 54.8% 是 Bangumi 覆盖面的天花板，不是我们的 bug。再加重扫只会每天白打
 * 800 个 bgm 请求。要定点补某几条用 --ids / --mine / --retry，别进定时任务。
 */
/** 判断别名里有没有中日文字（假名或汉字）—— 第三轮搜索只拿这类别名当搜索词 */
const CJK_ANY = /[぀-鿿㐀-䶿]/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取 subject 详情里的放送开始/结束 —— AOD 快照会过期，这两个日期是事实数据 */
async function bgmSubject(id) {
  const res = await fetch(`${BGM}/v0/subjects/${id}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  const d = await res.json();
  const box = Object.fromEntries((d.infobox ?? []).map((x) => [x.key, x.value]));
  const norm = (v) => {
    if (typeof v !== 'string') return null;
    const m = v.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})?/);
    if (!m) return null;
    return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3] ?? 1).padStart(2, '0')}`;
  };
  return {
    start: norm(box['放送开始']) ?? d.date ?? null,
    end: norm(box['播放结束']) ?? norm(box['放送结束']) ?? null,
    eps: d.total_episodes || d.eps || null,
    score: d.rating?.score ?? null, votes: d.rating?.total ?? null,
    rank: d.rating?.rank ?? null,
    coll: d.collection ? Object.values(d.collection).reduce((x, y) => x + (y || 0), 0) : null,
    summary: d.summary ?? null
  };
}

async function bgmSearch(keyword) {
  const res = await fetch(`${BGM}/v0/search/subjects?limit=5`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ keyword, filter: { type: [2] } }),  // type 2 = anime
    signal: AbortSignal.timeout(20_000)   // 没有超时的话一个卡住的请求能拖住整轮同步（#42）
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`bgm search HTTP ${res.status}`);
  const j = await res.json();
  return j.data || [];
}

/**
 * 标题清洗：去掉括号注释、季数/篇章后缀、装饰符号。
 * 「かぐや様は告らせたい (新作アニメーション)」→「かぐや様は告らせたい」
 * 这一步是命中率从 68% 提上来的主因。
 */
const SEASON_RE = new RegExp(
  '(?:' +
  '第[0-9一二三四五六七八九十]+[季期部]|' +
  '(?:2nd|3rd|[0-9]+th)\\s*season|season\\s*[0-9]+|' +
  'part\\s*[0-9ivx]+|final\\s*season|' +
  '[0-9]+(?:st|nd|rd|th)?\\s*シーズン' +
  ')', 'gi');

function clean(s) {
  if (!s) return '';
  const noise = (t) => t
    .replace(/[「」『』~〜～:：\-—_.,!?！？·・]/g, ' ')  // 装饰符号
    .replace(SEASON_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const stripped = noise(String(s).replace(/[（(\[【][^)）\]】]*[)）\]】]/g, ' '));  // 括号注释
  if (stripped.length >= 2) return stripped;
  /**
   * 整个标题都在括号里时，上面那一刀会把标题本身削掉：
   *   「【推しの子】第三期」→ 去括号注释 →「第三期」→ 去季数 → 空串
   * 于是候选列表被 length>=2 过滤掉，相似度恒为 0 ——
   * 实测《[推しの子] 第2期 / 第3期》搜索结果第一位就是正确条目
   * 「【我推的孩子】 第二季」，却因为 s=0.00 被拒，这么热门的番一直没有中文名。
   * 这种情况只去掉括号本身，保留里面的字。
   */
  return noise(String(s).replace(/[（()）\[\]【】]/g, ' '));
}

/**
 * 别名的「基础名」—— 去掉季数/分部标记后的主体。
 * 用来判断两个中文名是不是同一部作品的不同季：
 *   「终究、与你相恋。」和「终究、与你相恋。 第二季」→ 基础名相同，是同一部
 *   「异世界舅舅」和「异世界药局」→ 基础名不同，是两部不同的作品
 */
const ALIAS_SEASON = /\s*第\s*(?:[0-9]+|[一二三四五六七八九十])\s*(?:季|期|部分|部|幕|章)\s*|\s*(?:season|part|cour)\s*[0-9ivx]+\s*/gi;
const aliasBase = (s) => String(s ?? '').replace(ALIAS_SEASON, '').replace(/\s+/g, '').trim();

/** 双字符集相似度（bigram Dice） */
function sim(a, b) {
  a = normTitle(a); b = normTitle(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bg = (s) => { const m = new Set(); for (let i = 0; i < s.length - 1; i++) m.add(s.slice(i, i + 2)); return m; };
  const A = bg(a), B = bg(b);
  if (!A.size || !B.size) return a === b ? 1 : 0;
  let hit = 0; for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
}

/**
 * 集数量级否决 —— 名字像不代表是同一部作品。
 *
 * 实测：2025 秋的单集特番《ドリームログ / Dreamlog》(1 集) 匹配到了 2026-10-17
 * 首播的 10 集《Dreamland》—— bigram 相似度 0.67 过了 0.5 的门槛，年份又刚好
 * 差 1 年落在容差里，于是一部 2025 年的番挂上了 2026 的放送日期，
 * 被 fix-status 判成「未上映」（e2e「往年的番不会还挂着未上映」就是抓这个）。
 *
 * 双方集数都已知、且相差 4 倍以上就当作「不是同一个粒度」—— 单集特番/OVA/剧场版
 * 撞上连续剧本篇属于这一类，而分季合并（12 集对 24 集）差 2 倍，不会被误伤。
 * 不用 bgm 的 platform 字段做校验：它不可靠（Dreamland 在 ABC/朝日电视台播，
 * platform 却写 WEB）。
 *
 * 命中 clash 的其实是两类，处理方式不同（实测全库 1,741 条）：
 *
 *   ① 同系列不同粒度，名字对得上 —— 《幽☆遊☆白書 (映画)》(1 集) 匹配到 112 集的
 *      《幽游白书》TV 本篇。「幽游白书」这个名字用在剧场版上没问题，比留着罗马音好
 *      （这类占 1,619 条）；有害的只是跟着进来的 1992-10-10 这种本篇日期。
 *      → 名字照收，start/end/eps 置空，让 fix-status 退回按季度推导。
 *
 *   ② 压根是另一部番，只是名字像 —— Dreamlog(1 集) ↔ Dreamland(10 集)。
 *      这种连简介和评分都是别人的，全盘不能要。
 *      → 直接拒收。
 *
 * 用相似度分流：①去掉粒度词后基本同名（s≥0.9 或完全同名），②只有 0.67。
 */
const epsClash = (mine, theirs) =>
  mine > 0 && theirs > 0 && Math.max(mine, theirs) >= 4 * Math.min(mine, theirs);

/**
 * 从候选里挑最佳。
 * 关键：拿我们的**全部别名**（日文名/罗马字/英文名/简称）去比 bgm 的
 * name 和 name_cn，取最大相似度 —— 只用日文名会漏掉一堆。
 */
/**
 * 标题属于哪种文字。用来避免跨语言比较 —— 见 pick() 里的说明。
 *   ja  含假名，确定是日文
 *   cn  含简体专用字，确定是简体中文
 *   any 纯汉字或拉丁字母，分不清（日文汉字标题、繁体、罗马音都落这里）
 */
const kindOf = (s) => (hasKana(s) ? 'ja' : SIMPLIFIED.test(s) ? 'cn' : 'any');

function pick(anime, cands, aliases) {
  const mine = [...new Set([anime.title_ja, anime.title, ...aliases].filter(Boolean).map(clean))]
    .filter((x) => x.length >= 2);
  let best = null;
  for (const c of cands) {
    /**
     * ⚠️ 只在【文字种类相容】时比相似度。
     *
     * bgm 的 name 是原名（日文），name_cn 是中文译名。拿我们的日文标题去和
     * 中文译名比，共享的汉字前缀会凭空造出相似度，实测：
     *   《魔法少女アイ》(2003, 5集) ↔ bgm 1262《魔法少女リリカルなのは》
     *      日↔日 = 0.40（正确拒掉）  日↔中「魔法少女奈叶」= 0.60（错误接受）
     *   于是一部完全不同的作品被标成了「魔法少女奈叶」。
     * 「魔法少女」「異世界」「劇場版」这类前缀在日文里极常见，跨语言比时
     * 它们贡献的 bigram 占比很高，短标题尤其容易翻车。
     *
     * 相容规则：日文只和 name 比、简体中文只和 name_cn 比，
     * 分不清的（纯汉字/罗马音）两边都比 —— bgm 的 name 有时本身就是拉丁标题。
     */
    const theirs = [[clean(c.name), 'ja'], [clean(c.name_cn), 'cn']]
      .filter(([t]) => t && t.length >= 2);
    const byear = c.date ? +String(c.date).slice(0, 4) : null;
    let s = 0, exact = false;
    for (const m of mine) {
      const k = kindOf(m);
      for (const [t, tk] of theirs) {
        if (k !== 'any' && k !== tk) continue;      // 跨语言，不比
        const v = sim(m, t);
        if (v > s) s = v;
        if (normTitle(m) === normTitle(t)) exact = true;
      }
    }
    // 年份校验：允许 ±1（跨季番首播年可能差一年）
    const yearOk = !anime.year || !byear || Math.abs(byear - anime.year) <= 1;
    const clash = epsClash(anime.episodes || 0, c.eps || 0);
    // clash 只给 -0.15：够让同分时让位给干净的候选，又不至于把明显更像的那个挤掉
    const score = s + (yearOk ? 0.25 : -0.5) + (exact ? 0.5 : 0) + (clash ? -0.15 : 0);
    if (!best || score > best.score) best = { cand: c, score, s, yearOk, exact, byear, clash };
  }
  if (!best) return null;
  // 接受门槛：完全同名(且年份不冲突) / 相似度>=0.5且年份对得上 / 相似度>=0.85
  let ok = (best.exact && best.yearOk) || (best.s >= 0.5 && best.yearOk) || best.s >= 0.85;
  // 集数量级冲突且名字没到「基本同名」→ 是另一部番，全盘拒收（见 epsClash 上的②）
  if (ok && best.clash && !best.exact && best.s < 0.9) ok = false;
  return ok ? best : { ...best, rejected: true };
}

async function main() {
  const db = getDb();
  initSchema(db);

  // 优先队列：日本作品 + 非 stub + 有日文原名 + 还没匹配过
  // 按 source_count 降序（实测的知名度代理指标），先补你最可能看到的
  const todo = db.prepare(`
    SELECT id, title, title_ja, year, episodes, type, source_count
    FROM anime
    WHERE is_jp = 1 AND is_stub = 0
      /**
       * ⚠️ 不要再加「title_ja IS NOT NULL」：NINJA KAMUI / D4DJ All Mix / Idoly Pride
       * 这类番的官方标题本来就是拉丁字母，一个 CJK 字符都没有 —— 加了这个条件
       * 它们永远进不了队列。下面搜索时会退回用罗马字标题去搜，bgm 的原名字段
       * 存的也是拉丁标题，一样能命中。
       */
      AND (title_ja IS NOT NULL OR title IS NOT NULL)
      /**
       * --min-sources N：只补「被 N 个站以上收录」的。
       * 长尾里全是 bgm 没有的东西（活动短片、PV、ミニアニメ、音乐 MV），
       * 一条要花 1-2 秒发两三个请求，命中率却是 0 —— 有额度限制时先跳过它们。
       */
      AND ${IDS.length ? `id IN (${IDS.join(',')})`
            : RETRY ? 'title_cn IS NULL'
            : 'bgm_matched_at IS NULL'}
      ${MINE ? 'AND id IN (SELECT anime_id FROM user_entry_all)' : ''}
      ${FROM ? `AND year >= ${FROM}` : ''}
      ${MIN_SRC ? `AND source_count >= ${MIN_SRC}` : ''}
    /**
     * 顺序：先知名度（被几个站收录），同档再让最近两年优先。
     *
     * 历史上换过两轮：
     *   ① source_count DESC, year DESC —— 1990 年代的老番排在所有新番前面，
     *      每天 800 条额度全花在老番上，2026 年覆盖率只有 29%，目录一屏罗马音。
     *   ② (year >= 今年-1) DESC 提到最前 —— 治好了新番，但现在当季覆盖率已经
     *      96%/67%，这个键只剩下把长尾垃圾顶到前面的作用：实测队列前 1700 条里
     *      810 条是「只被 1-3 个站收录」的活动短片/PV/ミニアニメ，bgm 压根没收录，
     *      连续跑 11 分钟 590 条命中 0 条；而 2021-2022 那些被 9-10 个站收录的
     *      TV 番（【推しの子】第2期、ダンまち、Idoly Pride…）排在后面一直轮不到，
     *      抽样一试命中率 66.7%。
     * 所以知名度当主键、年份当同档内的抢七 —— 两个毛病都不犯。
     */
    ORDER BY source_count DESC, (year >= ${new Date().getFullYear() - 1}) DESC, year DESC
    LIMIT ?`).all(LIMIT);

  /**
   * ⚠️ 两个数必须同口径。原来 done 数全库（含非日本作品与 stub）、total 只数可见条目，
   * 相减会穿底 —— 实测日志里印出「剩余 -794」这种负数。
   * 现在一律限定在 is_jp=1 AND is_stub=0 上，并且「剩余」按【还没有中文名】算，
   * 因为那才是这个脚本真正要推进的指标（匹过但没匹出中文名的不算已完成）。
   */
  const cnt = (w) => db.prepare(`SELECT count(*) c FROM anime WHERE is_jp=1 AND is_stub=0 AND ${w}`).get().c;
  const total = cnt('1=1');
  const withCn = cnt('title_cn IS NOT NULL');
  const untried = cnt('bgm_matched_at IS NULL');
  console.log(`🈸 bgm 中文名补全  待处理 ${todo.length} / 还没中文名 ${total - withCn}`
    + `（其中没匹过 ${untried}）/ 总计 ${total} · 覆盖率 ${(withCn / total * 100).toFixed(1)}%`
    + `${DRY ? '  [DRY RUN]' : ''}`)

  /**
   * ⚠️ episodes 也要顺手补：AOD 对当季新番常写 episodes=0（还没定），而 bgm 已经
   * 知道是 12 集。卡片的「N集」角标、进度条、统计的累计集数、「集数 ≤」筛选、
   * 标「看完」时自动补满 —— 全都读 episodes，是 0 就等于这些功能失效。
   * 只在 episodes 为 0/空时用 bgm 的值覆盖，AOD 已经有值的不动。
   */
  const upd = db.prepare(`
    UPDATE anime SET title_cn=@cn, bgm_id=@bid, bgm_score=@score, bgm_votes=@votes,
      bgm_rank=@rank, bgm_collection=@coll, bgm_summary=@summary,
      bgm_air_start=@start, bgm_air_end=@end, bgm_eps=@eps,
      bgm_match_score=@mscore, bgm_name_ja=@mname,
      episodes = CASE WHEN coalesce(episodes,0) = 0 AND @eps > 0 THEN @eps ELSE episodes END,
      bgm_matched_at=datetime('now')
    WHERE id=@id`);
  const updFail = db.prepare(`UPDATE anime SET bgm_matched_at=datetime('now') WHERE id=?`);
  // 中文名要进别名表 + 立刻重建这一行的 FTS 索引，
  // 否则新补的中文名搜不到（实测曾有 52% 的中文名不在索引里）
  // src='bgm' 是给 ingest-aod 看的标记：全量灌库清别名表时要跳过这批
  const insAlias = db.prepare(`INSERT INTO anime_alias (anime_id,alias,has_kana,is_cjk,src)
    SELECT ?,?,0,1,'bgm' WHERE NOT EXISTS (SELECT 1 FROM anime_alias WHERE anime_id=? AND alias=?)`);
  const delFts = db.prepare('DELETE FROM anime_fts WHERE rowid = ?');
  const insFts = db.prepare('INSERT INTO anime_fts (rowid, seg) VALUES (?, ?)');
  const getNames = db.prepare(`SELECT a.title, a.title_ja, a.title_cn,
      (SELECT group_concat(alias, ' ') FROM anime_alias WHERE anime_id=a.id) aliases
    FROM anime a WHERE a.id = ?`);
  const reindexOne = (id) => {
    const n = getNames.get(id);
    if (!n) return;
    delFts.run(id);
    insFts.run(id, segment([n.title, n.title_ja, n.title_cn, n.aliases].filter(Boolean).join(' ')));
  };

  /**
   * ⚠️ 必须排掉 src='bgm' 的别名 —— 那是【匹配器自己的产出】，不是关于这部番的证据。
   *
   * 命中后我们会把 bgm 的 name_cn 插进 anime_alias（给搜索用，src='bgm'）。
   * 如果下一轮 --retry 又把它当候选名拿去比对，就成了自我强化的循环：
   * 第一次靠模糊相似度勉强匹到错的条目 → 写入错的中文名 → 下一轮拿这个错名字
   * 去比，和那个错条目【完全同名 s=1.00】→ 把错误坐实，而且再也纠不回来。
   *
   * 实测：《异世界药局》(Isekai Yakkyoku, 12 集) 被匹到 bgm 339326
   * 《異世界おじさん》(13 集)，于是中文名显示成「异世界舅舅」。它的别名表里
   * 就躺着一条 [bgm] 异世界舅舅，重跑时 s=1.00 —— 上游数据其实是对的
   * （異世界薬局 是 bgm 342200），纯粹是这个循环造成的。
   */
  const getAliases = db.prepare(`SELECT alias FROM anime_alias
    WHERE anime_id = ? AND coalesce(src, '') != 'bgm' LIMIT 25`);
  const getBgmAliases = db.prepare("SELECT alias FROM anime_alias WHERE anime_id = ? AND src = 'bgm'");
  const delBgmAlias = db.prepare("DELETE FROM anime_alias WHERE anime_id = ? AND alias = ? AND src = 'bgm'");

  /**
   * 每次开跑先清一遍历史遗留的污染别名 —— 让它自愈，而不是靠记得手动修。
   * 判据同上：bgm 来源、且去掉季数标记后基础名和当前 title_cn 不同。
   */
  {
    const stale = db.prepare(`SELECT anime_id, alias FROM anime_alias al
      JOIN anime a ON a.id = al.anime_id
      WHERE al.src = 'bgm' AND (a.title_cn IS NULL OR al.alias <> a.title_cn)`).all()
      .filter((r) => {
        const cn = db.prepare('SELECT title_cn FROM anime WHERE id = ?').get(r.anime_id).title_cn;
        return aliasBase(r.alias) !== aliasBase(cn);
      });
    if (stale.length) {
      for (const r of stale) delBgmAlias.run(r.anime_id, r.alias);
      for (const id of new Set(stale.map((r) => r.anime_id))) reindexOne(id);
      console.log(`🧹 清掉 ${stale.length} 条历史遗留的污染别名（基础名和中文名不符）`);
    }
  }

  let hit = 0, miss = 0, err = 0, retried = 0;
  for (let i = 0; i < todo.length; i++) {
    const a = todo[i];
    try {
      const aliases = getAliases.all(a.id).map((r) => r.alias);
      // 没有日文标题就用罗马字标题搜（拉丁标题的番）
      const primary = a.title_ja || a.title;
      let cands = await bgmSearch(clean(primary) || primary);
      let p = cands.length ? pick(a, cands, aliases) : null;
      // 第一轮没中 → 用罗马字标题再搜一次（纯假名短标题常需要这一步）
      if ((!p || p.rejected) && a.title && clean(a.title) !== clean(primary)) {
        retried++;
        await sleep(DELAY);
        const c2 = await bgmSearch(clean(a.title));
        const p2 = c2.length ? pick(a, c2, aliases) : null;
        if (p2 && !p2.rejected) p = p2;
      }
      /**
       * 还没中 → 用【最长的 CJK 别名】再搜一次。
       *
       * title_ja 有时候是个缩写：AOD 里「魔法少女育成計画 restart」这部同时有别名
       * 「まほいく」，pickTitleJa 会挑到缩写（拉丁占比那道筛把带 " restart" 的
       * 全名筛掉了）。拿 4 个字的缩写去搜 bgm 搜不到，这部 9 个站收录的番就一直
       * 没有中文名。全库有 1,180 条 title_ja 短于最长 CJK 别名的六成。
       *
       * ⚠️ 修法是「多搜一个词」而不是「改 title_ja」—— title_ja 是去重的锚
       * （见 dedup.js），实测按「取最长」重写会动 1,063 条可见番，而那批里有明确
       * 变坏的（伊藤瑞希x変態紳士クラブ → TOHO animation ミュージックフィルムズ，
       * 那是系列名不是这一支）。搜索词多试一个不动库里任何字段，错了也只是搜不到。
       */
      if (!p || p.rejected) {
        const longest = aliases.filter((x) => CJK_ANY.test(x))
          .sort((x, y) => y.length - x.length)[0];
        if (longest && clean(longest) !== clean(primary) && clean(longest) !== clean(a.title)) {
          retried++;
          await sleep(DELAY);
          const c3 = await bgmSearch(clean(longest) || longest);
          const p3 = c3.length ? pick(a, c3, aliases) : null;
          if (p3 && !p3.rejected) p = p3;
        }
      }
      if (p && !p.rejected) {
        const c = p.cand;
        const r = c.rating || {};
        let coll = c.collection ? Object.values(c.collection).reduce((x, y) => x + (y || 0), 0) : null;
        // 再取一次详情拿放送日期（搜索结果里没有 infobox）
        let det = null;
        if (!DRY) { await sleep(DELAY); det = await bgmSubject(c.id).catch(() => null); }
        /**
         * 集数量级要拿【详情接口】的数字再判一次。
         * pick() 里用的是搜索结果的 c.eps，可落库的 bgm_eps 来自详情的
         * total_episodes —— 两个数常常不一样（实测《まるまるマヌル》搜索给 50、
         * 详情给 12），只按搜索结果把门会漏。漏掉的后果就是 e2e
         * 「集数量级对不上的番不会留着 bgm 放送日期」挂红。
         */
        const clash = p.clash || epsClash(a.episodes || 0, det?.eps || 0);
        if (!DRY) upd.run({
          id: a.id,
          // 用罗马字标题的季数校正 bgm 的中文名 —— bgm 对分季的粒度和 AOD 不同，
          // 一个 bgm 条目常匹配到多个 AOD 条目（实测 604 个 bgm_id 挂 1300 条），
          // 结果目录里出现三张「间谍过家家 第二季」年份却是 2022/2023/2025。见 text.js
          cn: fixCnSeason(c.name_cn || null, a.title), bid: c.id,
          // 匹配痕迹：相似度 + bgm 那边的原名。exact 记成 1，和 s 同一个量纲
          mscore: p.exact ? 1 : p.s ?? null,
          mname: c.name ? String(c.name).slice(0, 200) : null,
          score: det?.score ?? r.score ?? null,
          votes: det?.votes ?? r.total ?? null,
          rank: det?.rank ?? r.rank ?? null,
          coll: det?.coll ?? coll,
          summary: (det?.summary ?? c.summary) ? String(det?.summary ?? c.summary).slice(0, 2000) : null,
          // 集数量级冲突 → 匹配到的是别的粒度（本篇/合集），日期和集数一律不采信
          start: clash ? null : (det?.start ?? null),
          end: clash ? null : (det?.end ?? null),
          eps: clash ? null : (det?.eps ?? null)
        });
        /**
         * 写新中文名之前，先删掉这一行【基础名不同】的旧 bgm 别名。
         *
         * 原来只插不删，于是一次错误匹配留下的名字永久污染搜索：
         * 主人搜「异世界舅舅」会搜出《异世界药局》—— 那条 [bgm] 异世界舅舅
         * 是之前错匹配写进去的，改对 title_cn 之后它还在，reindex 又把它收进索引。
         *
         * 只删【基础名不同】的：只差季数标记的要留着（别名「终究、与你相恋。」
         * 对应中文名「… 第二季」，搜基础名能找到全部季，那是有用的）。
         * 实测全库只有 2 条属于该删的，515 条属于该留的。
         */
        if (!DRY && c.name_cn) {
          for (const old of getBgmAliases.all(a.id))
            if (aliasBase(old.alias) !== aliasBase(c.name_cn)) delBgmAlias.run(a.id, old.alias);
          insAlias.run(a.id, c.name_cn, a.id, c.name_cn);
          reindexOne(a.id);
        }
        hit++;
        if (DRY || i < 12) console.log(`  ✅ ${String(a.year||'?').padEnd(5)} ${(a.title_ja || a.title).slice(0,26).padEnd(28)} → ${(c.name_cn||'(无中文名)').slice(0,24).padEnd(26)} [s=${p.s.toFixed(2)} bgm:${c.id}]${clash ? `  ⚠️ 集数 ${a.episodes}≠${det?.eps ?? c.eps}，日期不采信` : ''}`);
      } else {
        if (!DRY) updFail.run(a.id);
        miss++;
        if (DRY) console.log(`  ❌ ${String(a.year||'?').padEnd(5)} ${(a.title_ja || a.title).slice(0,26).padEnd(28)} → ${p ? `最佳「${(p.cand.name_cn||p.cand.name).slice(0,20)}」s=${p.s.toFixed(2)} year=${p.byear}${p.clash ? ` 集数 ${a.episodes}≠${p.cand.eps}` : ''} 被拒` : '无候选'}`);
      }
    } catch (e) {
      err++;
      console.error(`  ⚠️  ${(a.title_ja || a.title)?.slice(0,30)}: ${e.message}`);
      if (err > 20) { console.error('错误过多，中止'); break; }
      await sleep(2000);
    }
    if (!DRY && (i + 1) % 50 === 0)
      process.stdout.write(`\r   进度 ${i + 1}/${todo.length}  命中 ${hit} 未匹配 ${miss} 错误 ${err}   `);
    await sleep(DELAY);
  }
  console.log(`\n\n📊 命中 ${hit}  未匹配 ${miss}  错误 ${err}  二次搜索 ${retried}   命中率 ${((hit / Math.max(1, hit + miss)) * 100).toFixed(1)}%`);
  if (!DRY) {
    db.prepare(`INSERT INTO sync_log (kind,started_at,finished_at,items,status)
                VALUES ('bgm_enrich',datetime('now'),datetime('now'),?,'ok')`).run(hit);
    console.log(`   已补中文名总数: ${db.prepare('SELECT count(*) c FROM anime WHERE title_cn IS NOT NULL').get().c}`);
  }
}
main().catch((e) => { console.error('❌', e); process.exit(1); });
