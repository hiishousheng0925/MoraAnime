import { partOrd } from './text.js';
import { tx } from './db.js';

/**
 * 按别名合并重复条目 —— 补 ingest 里「按标题分组」漏掉的那一类。
 *
 * ingest 的去重是按「归一化标题 + 年份 + 类型」分组的，可是同一部番在 AOD 里
 * 可能有两条主标题完全不同的记录：一条叫「Oni no Hanayome」，另一条叫
 * 「The Ogre's Bride」。两条都进了库，目录里就是两张一样的卡，而且两张都能
 * 加进番单（主人实测把「鬼的新娘」和「The Ogre's Bride」都标了想看）。
 *
 * 判据只敢卡在「薄壳」上：只被 1-2 个站收录、集数为 0，而同年同类型里存在一条
 * 共享别名的更胖的记录。反例是东宝那 5 支音乐短片 —— 它们的 title_ja 是同一个
 * 系列名，但各有 10 个站和各自的 MAL ID，是真不同的作品，绝不能合。
 */

/**
 * 别名归一化：大小写、空白、各种连接符和括号都不算。
 *
 * ⚠️ 波浪号有三个 Unicode 码位，必须都列上：~ (U+007E)、〜 (U+301C)、～ (U+FF5E)。
 * 漏了全角的 ～ 时实测翻车：ヘルモード 那部六条记录里三条写 ~、三条写 ～，
 * 归一化后仍然不相等，于是目录里一部番出现五张卡。
 */
export const normAlias = (s) =>
  String(s).toLowerCase().replace(/[\s　·・:：~〜～\-—–_.,、，!！?？'’"“”「」『』〈〉《》（）()【】\[\]／/]/g, '');

/**
 * 日文标题归一化。除了通用归一化，还要去掉结尾的年份后缀 ——
 * AOD 里同一部番常有「マリッジトキシン」和「マリッジトキシン (2027)」两条。
 */
export const normJa = (s) => normAlias(String(s ?? '').replace(/[（(]\s*(19|20)\d{2}\s*[)）]\s*$/, ''));

/** 结尾的括号注释：「弱虫ペダル (劇場版)」的 (劇場版)。只认最后一段、不吃嵌套 */
const PAREN_TAIL = /[（(]([^（()）]*)[)）]\s*$/;

/** 去掉结尾括号注释后的日文名（判据④ 用） */
const normBase = (s) => normJa(String(s ?? '').replace(PAREN_TAIL, '').trim());

/**
 * 「系列/季数限定词」。判据④ 的护栏：保留方的结尾括号里若是这类词，说明它是
 * 【续作或某一季】，不能拿它去吞掉不带限定词的本篇。
 * 实测两个反例，方向正好相反：
 *   キングダム (TV)      1 集 3 站  想吞  キングダム (New)  38 集
 *   みなみけ (新シリーズ) 1 集 9 站  想吞  みなみけ          13 集
 * 「(劇場版)」「(2クール)」「(みんなのうた)」「（仮）」不在此列 —— 那些是同一部
 * 作品的排版差异，正是判据④ 要折的。
 */
const SERIES_TAG = /^\s*(new|tv|新アニメ|新作(tv)?アニメ|新シリーズ|第\s*\d+\s*シリーズ)\s*$/i;
/** 括号外也可能写系列号：保留方有、薄壳没有，同样不能折 */
const SERIES_ANY = /(新シリーズ|第\s*\d+\s*シリーズ)/;

/**
 * 「薄壳」：只被 1-2 个站收录、且没有任何外部 ID。
 *
 * ⚠️ 不要再加「集数必须为 0」这个条件 —— 那是上一版的判据，漏掉了一大类：
 * 葬送のフリーレン 第3期 有两条，胖的那条 3 站 0 集、薄的那条 1 站却写了 12 集，
 * 于是薄的那条逃过了折叠，目录里两张一样的卡（マリッジトキシン 第2期 同样）。
 * 站点数 + 有没有外部 ID 才是「这条是不是某个站刚建的空记录」的可靠信号。
 */
const idCount = (r) => [r.mal_id, r.anilist_id, r.anidb_id].filter(Boolean).length;
/**
 * 「薄壳」：只被 1-2 个站收录，且最多只有一个外部 ID。
 *
 * 允许带一个 ID —— MAL 自己也会为同一部番建重复条目：ヘルモード 那部有一条
 * 1 站 + 1 个 MAL ID 的记录，和 9 站 + 3 个 ID 的正主日文标题完全相同。
 * 下面还要求「保留方站点数更多、外部 ID 不更少」，误折的空间已经压得很小。
 */
const THIN = (r) => r.source_count <= 2 && idCount(r) <= 1;

/**
 * 找出应该被折叠的条目。纯计算，不写库 —— 这样 dry-run 和实际执行走同一份逻辑。
 *
 * 不再用「共享别名」来分组：实测漏得厉害 —— ヘルモード 那部里有两条记录
 * 一个别名都不重叠（一条只有日文名、一条只有英文名），却是同一部番。
 * 现在直接按「胖 / 瘦」分两堆，瘦的那堆逐条去胖的那堆里找同一部番（见 sameShow）。
 * 数量级：4 万条里瘦的约 1 万、胖的约 3 万，按 normJa 建索引 + 同年同类型分桶，
 * 实测 1 秒内跑完。
 *
 * @returns {{ winner: number, loser: number, why: string }[]}
 */
export function findAliasDupes(db) {
  // title（罗马字）判据⑤ 的 partOrd 护栏要用 —— 分部号只剩在罗马字标题里
  const rows = db.prepare(`SELECT id, year, type, source_count, episodes, mal_id, anilist_id, anidb_id,
    title, title_cn, title_ja FROM anime WHERE is_stub = 0`).all();
  const titles = new Map(rows.map((r) => [r.id, [r.title_cn ?? '', r.title_ja ?? '']]));

  const fat = rows.filter((r) => !THIN(r));
  const thin = rows.filter((r) => THIN(r));

  // 索引一：归一化日文标题 → 胖条目（日文标题严格相等时可以跨年份配对）
  const byJa = new Map();
  // 索引二：年份|类型 → 胖条目（前缀规则和中文名规则都要求同年同类型）
  const byYT = new Map();
  for (const f of fat) {
    const ja = normJa(f.title_ja ?? '');
    if (ja) (byJa.get(ja) ?? byJa.set(ja, []).get(ja)).push(f);
    const k = `${f.year}|${f.type}`;
    (byYT.get(k) ?? byYT.set(k, []).get(k)).push(f);
  }
  // 胖瘦排序：站点数 → 外部 ID 数 → id 小
  const fatter = (a, b) => b.source_count - a.source_count || idCount(b) - idCount(a) || a.id - b.id;
  for (const list of byJa.values()) list.sort(fatter);
  for (const list of byYT.values()) list.sort(fatter);

  /**
   * 索引三：去掉结尾括号后的日文名|类型|年份 → 【全部】条目（判据④ 专用）。
   * 这一条不能只看胖条目 —— 括号变体那类重复常常两边都只有 1-2 个站：
   * 「ビックリマン ロココ＆マリア奇跡」2 站 和「…（ミラクル）」1 站，
   * 保留方自己也是薄壳，在 byJa / byYT 里根本不存在，于是前台一直是两张同名卡。
   * ok() 仍然要求保留方站点数【严格更多】且外部 ID 不更少，护栏没有放松。
   */
  const byBase = new Map();
  for (const r of rows) {
    const b = normBase(r.title_ja ?? '');
    if (!b) continue;
    const k = `${b}|${r.type}|${r.year}`;
    (byBase.get(k) ?? byBase.set(k, []).get(k)).push(r);
  }
  for (const list of byBase.values()) list.sort(fatter);

  /**
   * 索引四：归一化日文名|类型|年份 → 【全部】条目（判据⑤ 专用）。
   * 和 byJa 的区别是它包含薄条目，因为判据⑤ 允许输家不是薄壳。
   */
  const byJaAll = new Map();
  for (const r of rows) {
    const ja = normJa(r.title_ja ?? '');
    if (!ja) continue;
    const k = `${ja}|${r.type}|${r.year}`;
    (byJaAll.get(k) ?? byJaAll.set(k, []).get(k)).push(r);
  }
  for (const list of byJaAll.values()) list.sort(fatter);

  const out = [];
  const done = new Set();
  /**
   * 判据⑤ 先跑：它的判据最强（日文名严格相等 + 集数相容 + 外部 ID 不冲突），
   * 而且候选池是全部条目 —— 让它先定输赢，后面两趟只处理它没管的。
   * 输家可以是胖条目，所以要遍历全部行、拿组内最胖的当赢家。
   */
  for (const r of rows) {
    const list = byJaAll.get(`${normJa(r.title_ja ?? '')}|${r.type}|${r.year}`) ?? [];
    const w = list[0];
    if (!w || w.id === r.id) continue;
    if (idCount(r) > idCount(w) || !sameShowStrict(r, w, titles)) continue;
    out.push({ winner: w.id, loser: r.id, why: `${r.source_count} 站/${r.episodes ?? 0} 集` });
    done.add(r.id);
  }
  for (const r of thin) {
    if (done.has(r.id)) continue;
    const ok = (w) => w.source_count > r.source_count && idCount(w) >= idCount(r);
    const ja = normJa(r.title_ja ?? '');
    const cands = [...(ja ? byJa.get(ja) ?? [] : []), ...(byYT.get(`${r.year}|${r.type}`) ?? [])];
    let winner = cands.find((w) => w.id !== r.id && ok(w) && sameShow(r, w, titles));
    if (!winner) {
      const base = byBase.get(`${normBase(r.title_ja ?? '')}|${r.type}|${r.year}`) ?? [];
      winner = base.find((w) => w.id !== r.id && ok(w) && sameParenVariant(r, w, titles));
    }
    if (winner) { out.push({ winner: winner.id, loser: r.id, why: `${r.source_count} 站/${r.episodes ?? 0} 集` }); done.add(r.id); }
  }
  /**
   * 判据④ 的保留方可以是薄壳，于是可能出现链条 A→B→C（B 既是保留方又被折）。
   * 折了 B 之后 A 就挂在一个隐藏条目下面，repairOrphans 又会把它放回来，来回震荡。
   * 直接丢掉链条中间那一段：下一轮同步 B 已经是 is_stub、不在 rows 里，A 会重新配对到 C。
   */
  return out.filter((p) => !done.has(p.winner));
}

/**
 * 折叠后的修复：把「没有任何可见对应条目」的 is_stub 放回可见。
 *
 * 为什么会出现：ingest 的去重按「归一化标题」分组，A 和 B 同组、A 当组长、B 被标 stub；
 * 而这里的别名去重又把 A 折进了 C —— 于是 B 挂在一个已经隐藏的组长下面，
 * 界面上彻底消失了（实测「I Love Me Part 2」5 集就这么丢了）。
 * 判据和 e2e 的不变式一致：归一化标题 / 日文标题 / 中文名，三者任一能对上就算有归属。
 */
export function repairOrphans(db, dedupKey) {
  const vis = db.prepare('SELECT title, title_ja, title_cn, year, type FROM anime WHERE is_stub = 0').all();
  const byTitle = new Set(vis.map((r) => `${dedupKey(r.title, r.year)}|${r.year ?? ''}|${r.type}`));
  const byJa = new Set(vis.filter((r) => r.title_ja).map((r) => normJa(r.title_ja)));
  const byCn = new Set(vis.filter((r) => r.title_cn).map((r) => normAlias(r.title_cn)));
  /**
   * 外部 ID 也算「有归属」：MAL/AniList 上是同一条，内容就没丢，
   * 放回去反而会让同一个 mal_id 挂在两个可见条目上（e2e 有这条不变式）。
   * 实测：Girls & Panzer Movie Specials 和「少女与战车 剧场版」共用 mal_id=32740。
   */
  const ids = new Set();
  for (const r of db.prepare(`SELECT mal_id, anilist_id, anidb_id FROM anime WHERE is_stub = 0`).all())
    for (const [k, v] of Object.entries(r)) if (v) ids.add(`${k}:${v}`);

  /**
   * dup_of 记着「被折进了哪一条」—— 那本身就是归属，不用再靠标题去猜。
   * 少了这一条判据，判据④（括号变体）折掉的条目会当场被放回来：它的判据恰恰是
   * 「全名对不上、只差结尾括号」，下面三个 Set 一个都命中不了。
   */
  const alive = new Set(db.prepare('SELECT id FROM anime WHERE is_stub = 0').all().map((r) => r.id));
  const orphans = db.prepare(`SELECT id, title, title_ja, title_cn, year, type, dup_of,
      mal_id, anilist_id, anidb_id FROM anime WHERE is_stub = 1`).all()
    .filter((r) => !(r.dup_of && alive.has(r.dup_of))
      && !byTitle.has(`${dedupKey(r.title, r.year)}|${r.year ?? ''}|${r.type}`)
      && !(r.title_ja && byJa.has(normJa(r.title_ja)))
      && !(r.title_cn && byCn.has(normAlias(r.title_cn)))
      && !['mal_id', 'anilist_id', 'anidb_id'].some((k) => r[k] && ids.has(`${k}:${r[k]}`)));
  // 放回可见就不再属于任何一条，dup_of 要一起清掉，否则下一轮又被当成「已有归属」
  for (const r of orphans) db.prepare('UPDATE anime SET is_stub = 0, dup_of = NULL WHERE id = ?').run(r.id);
  return orphans;
}

/**
 * 两条番单记录合并成一条（折叠时两边都有记录）。
 * 主记录取「用户动过的」（不是没动过的快速标记）、其次更新时间晚的；
 * 主记录上空着的字段（分数、短评、进度、开始/看完时间）用另一条补。
 * 原来是直接删掉输家的记录 —— 万一判重判错，删掉的可能正是打过分、写过短评的那条。
 */
export function mergeEntries(a, b) {
  const touched = (e) => !(e.is_vague === 1 && e.status === 'completed' && e.my_score == null && !e.my_note);
  const [p, q] = touched(a) !== touched(b) ? (touched(a) ? [a, b] : [b, a])
    : (String(a.updated_at) >= String(b.updated_at) ? [a, b] : [b, a]);
  const out = { ...p };
  for (const k of ['my_score', 'my_note', 'current_episode', 'started_at', 'finished_at'])
    if (out[k] == null || out[k] === '') out[k] = q[k];
  out.is_vague = touched(out) ? 0 : out.is_vague;
  return out;
}

/**
 * 执行折叠：把薄壳标成 is_stub，个人记录（番单/快速标记）迁到保留的那条上，
 * 并把薄壳身上有、保留条目缺的外部 ID 补过去。整批在一个事务里（中途出错不留半截）。
 */
export function applyAliasDupes(db, pairs, { inTx = false } = {}) {
  let moved = 0; const merged = [];
  // 调用方已经开了事务（ingest-bgm）时直接跑，SQLite 不允许嵌套 BEGIN。
  // 同步脚本没有登录态，必须直接读写 *_all 真表、按账号逐个合并（视图在这里是空的，见 multiUser.js）
  (inTx ? (_d, fn) => fn() : tx)(db, () => { for (const { winner, loser } of pairs) {
    const users = db.prepare(`SELECT user_id FROM user_entry_all WHERE anime_id = ?
      UNION SELECT user_id FROM triage_all WHERE anime_id = ?`).all(loser, loser).map((r) => r.user_id);
    for (const u of users) {
      const [ew, el] = [winner, loser].map((id) => db.prepare('SELECT * FROM user_entry_all WHERE user_id = ? AND anime_id = ?').get(u, id));
      if (ew && el) {
        const m = mergeEntries(ew, el);
        db.prepare(`UPDATE user_entry_all SET status=@status, current_episode=@current_episode, my_score=@my_score,
            my_note=@my_note, is_vague=@is_vague, started_at=@started_at, finished_at=@finished_at,
            updated_at=datetime('now') WHERE user_id=@u AND anime_id=@winner`)
          .run({ status: m.status, current_episode: m.current_episode, my_score: m.my_score, my_note: m.my_note,
                 is_vague: m.is_vague, started_at: m.started_at, finished_at: m.finished_at, winner, u });
        db.prepare('DELETE FROM user_entry_all WHERE user_id = ? AND anime_id = ?').run(u, loser);
        merged.push({ winner, loser, user: u }); moved++;
      } else if (el) {
        moved += db.prepare('UPDATE user_entry_all SET anime_id = ? WHERE user_id = ? AND anime_id = ?').run(winner, u, loser).changes;
      }
      const hasT = db.prepare('SELECT 1 FROM triage_all WHERE user_id = ? AND anime_id = ?').get(u, winner);
      moved += hasT ? db.prepare('DELETE FROM triage_all WHERE user_id = ? AND anime_id = ?').run(u, loser).changes
                    : db.prepare('UPDATE triage_all SET anime_id = ? WHERE user_id = ? AND anime_id = ?').run(winner, u, loser).changes;
    }
    // 快速标记两边都有就留保留方那条（上面）；观看日志一律迁过去（历史不能丢）
    db.prepare('UPDATE watch_log_all SET anime_id = ? WHERE anime_id = ?').run(winner, loser);
    db.prepare(`UPDATE anime SET mal_id = coalesce(mal_id, (SELECT mal_id FROM anime WHERE id = ?)),
      anilist_id = coalesce(anilist_id, (SELECT anilist_id FROM anime WHERE id = ?)),
      anidb_id = coalesce(anidb_id, (SELECT anidb_id FROM anime WHERE id = ?)) WHERE id = ?`)
      .run(loser, loser, loser, winner);
    db.prepare('UPDATE anime SET is_stub = 1, dup_of = ? WHERE id = ?').run(winner, loser);
  } });
  return { folded: pairs.length, moved, merged };
}

/**
 * 判据⑤：日文名严格相等 + 同年同类型 + 集数相容 + 【没有任何一类外部 ID 取值冲突】。
 *
 * 和判据① 的区别只有一个：**不要求输家是薄壳**。库里有一批两边都 3-10 站的真重复，
 * 判据① 碰不到（THIN 只折 <=2 站、且候选池只从胖条目里建）：
 *   魔法の姉妹ルルットリリィ  src10 12集  ←  Magical Sisters Lulutto Lilly  src3 12集
 *   正反対な君と僕          src10 12集  ←  You and I Are Polar Opposites  src3 12集
 *   五等分の花嫁【春夏秋冬】   三条，mal_id / anilist_id 各挂一条
 * 上游是两个站各建了一条、外部 ID 分散在不同行上，站点数就都不低。
 *
 * ⚠️ 放宽 THIN 的安全绳是「外部 ID 不冲突」，不是站点数：
 * · 东宝那 5 支音乐短片共用一个系列名、各有 10 个站，但**各有自己的 MAL ID** → 冲突 → 放手
 * · Q版变形金刚两季（帰ってきたコンボイの謎 / さらなる人気者への道）title_ja 被填成
 *   同一个，三类 ID 全都不同 → 冲突 → 放手（这类是 pickTitleJa 填错，不是重复）
 * · 《只要可爱即使是变态》和 Hensuki▽ 同理
 *
 * 集数「相容」= 相等，或有一边是 0（上游没填不算冲突：マロニエ王国の七人の騎士
 * 一条 12 集一条 0 集）。两边都有集数且不同的一律放手 —— 那一批混着真不同的作品
 * （らんま1/2 熱闘編 143集 vs 161集、涼宮ハルヒの憂鬱 28集 vs 14集、
 * パンダ・コパンダ 1集 vs 2集），17 组需要人工看，不能自动折。
 */
const ID_KEYS = ['mal_id', 'anilist_id', 'anidb_id'];
const idClash = (a, b) => ID_KEYS.some((k) => a[k] && b[k] && a[k] !== b[k]);
const epsCompat = (a, b) => (a.episodes ?? 0) === (b.episodes ?? 0)
  || (a.episodes ?? 0) === 0 || (b.episodes ?? 0) === 0;

function sameShowStrict(a, b, titles) {
  const aja = titles.get(a.id)?.[1] ?? '', bja = titles.get(b.id)?.[1] ?? '';
  const na = normJa(aja);
  if (!na || na !== normJa(bja)) return false;
  if (a.year !== b.year || a.type !== b.type) return false;
  /**
   * 分部号必须一致。日文名相等还不够 —— pickTitleJa 会把罗马字里的
   * 「Part II」这类后缀丢掉，于是上下半季拿到同一个 title_ja：
   *   千歳くんはラムネ瓶のなか        Chitose Is in the Ramune Bottle
   *   千歳くんはラムネ瓶のなか        Chitose Is in the Ramune Bottle: Part II   ← 是下半季
   *   劇場版 Collar×Malice        Deep Cover  /  Deep Cover - Part II
   *   鬼滅の刃 無限城編             Infinity Castle: Part 2  /  Part 3          ← 两部不同的电影
   * 区分信息只剩在罗马字标题里，所以拿 partOrd 再卡一道。
   * ⚠️ 不能连 seasonOrd 一起卡：「Dai 2 Shou」会被读成第 2 季，
   * 而它和「Movie 2」「Dainishou」其实是同一部（第二章），卡了会漏折。
   */
  if (partOrd(a.title) !== partOrd(b.title)) return false;
  if (partOrd(titles.get(a.id)?.[0] ?? '') !== partOrd(titles.get(b.id)?.[0] ?? '')) return false;
  return epsCompat(a, b) && !idClash(a, b);
}

/**
 * 判据④（独立一条，因为它的候选池和上面三条不同）：
 * 去掉【结尾括号注释】后日文名相同，且同年同类型（两边都是 NULL 也算同年）。
 *
 * AOD 里同一部番常有一条带括号注释、一条不带：
 *   弱虫ペダル (劇場版)              ← 弱虫ペダル              （9 站 vs 1 站 0 集）
 *   ヴァニタスの手記 (2クール)        ← ヴァニタスの手記          （10 站 vs 1 站 0 集）
 *   ビックリマン ロココ＆マリア奇跡    ← …奇跡（ミラクル）        （前台两张卡同名）
 * sameShow 的判据① 抓不到（归一化只去年份后缀，不去别的括号）；判据② 也抓不到
 * （前缀规则会把多出来的 (2クール) 当成分割播标记拒掉）。
 *
 * ⚠️ 护栏见 SERIES_TAG —— 保留方带系列/季数限定词时必须放手。
 *
 * @param {*} a 薄壳（要被折的）  @param {*} b 保留方
 */
function sameParenVariant(a, b, titles) {
  const aja = titles.get(a.id)?.[1] ?? '', bja = titles.get(b.id)?.[1] ?? '';
  const ba = normBase(aja), bb = normBase(bja);
  if (!ba || ba.length < 3 || ba !== bb) return false;
  /**
   * 归一化全名【必须不同】—— 相同的那类归判据① 管，不能从这里溜进来。
   * 放开的话就不只是「括号变体」了：库里有 120 多对两边都只 1-2 站、日文名归一化后
   * 完全相同的薄壳（茶啊二中 第3季 / 茶啊二中第3季、猟奇の檻 ～第2章～ / 猟奇の檻～第2章～），
   * 会跟着一起被折 —— 里面夹着「哈皮父子之超能泡蛋 26 集吞 52 集」这种反向合并。
   */
  if (normJa(aja) === normJa(bja)) return false;
  if (a.year !== b.year || a.type !== b.type) return false;
  if (SERIES_TAG.test(PAREN_TAIL.exec(bja)?.[1] ?? '')) return false;
  return !(SERIES_ANY.test(bja) && !SERIES_ANY.test(aja));
}

/**
 * 两条记录是不是同一部番。三条判据，从强到弱：
 *
 * ① 日文标题严格相等（归一化后）。这是最强的信号，可以跨年份配对 ——
 *    AOD 里同一部番常有「マリッジトキシン」和「マリッジトキシン (2027)」两条，
 *    年份还写得不一样。
 *    ⚠️ 不能放宽成「一方的日文标题出现在另一方的别名里」：AOD 把每支短片的
 *    日文标题都写进了系列条目的别名，放宽就会把 Poketoon 的单集折进系列，
 *    Ani*Kuri15、Hello Kitty 合集同理。
 *
 * ② 薄壳的日文标题是胖条目的【前缀】，且同年同类型。AOD 里同一部番常有
 *    「带副标题」和「不带副标题」两条：
 *      ヘルモード～…無双する～              （1-2 站的空记录）
 *      ヘルモード～…無双する～ はじまりの召喚士  （9 站，正主）
 *    方向必须是「薄壳更短」—— 反过来会把同年的第二季空记录折进第一季，
 *    因为「マリッジトキシン」正好是「マリッジトキシン 第2期」的前缀。
 *    前缀要够长（8 个字符以上），否则短名字会互相撞。
 *
 * ③ 中文名 + 年份 + 类型 + 集数全同。给「日文标题差一点、但渲染出来一模一样」
 *    的那类：ソードアート…ガンゲイルオンライン GALA 和 …ガンゲイルオンラインⅡ GALA
 *    差一个 Ⅱ，而两条的中文名/年份/类型/集数全同 —— 界面上就是两张一样的卡。
 */
function sameShow(a, b, titles) {
  const [acn, aja] = titles.get(a.id) ?? [];
  const [bcn, bja] = titles.get(b.id) ?? [];
  const na = normJa(aja ?? ''), nb = normJa(bja ?? '');
  if (na && nb && na === nb) {
    // 同年：直接算同一部（跨类型也行，TV 和 OVA 各建一条的情况很常见）
    if (a.year === b.year) return true;
    /**
     * 跨年份就要收紧：同一个日文标题在不同年份、不同类型下往往是【不同作品】——
     * 「一休さん」1975 TV 和 1976 劇場版、「テイコウペンギン」2019 ONA 和 2022 TV。
     * 只放过「同类型 + 年份差 1 年」这种明显是上游年份写歪了的情况。
     */
    return a.type === b.type && Math.abs((a.year ?? 0) - (b.year ?? 0)) <= 1;
  }
  if (na && nb && na.length >= 8 && nb.startsWith(na)
      && a.year === b.year && a.type === b.type) {
    /**
     * 多出来的那一截若是【季数/分割播标记】，就不能折 —— 同年分两个 cour 播的番，
     * 「千歳くんはラムネ瓶のなか」和「…第2クール」是上下半季，不是重复；
     * 「神達に拾われた男」和「…2」、「青のオーケストラ」和「…Season2」同理。
     * 「新シリーズ」「(New)」「(TV)」也算 —— 和判据④ 的 SERIES_TAG 同一个道理：
     * 「みなみけ (新シリーズ)」是续作，不能把「みなみけ」本篇折进去。
     * 这里宁可多拒：拒了只是目录里多一张卡，折错了是一部番从目录消失。
     * 例外：薄壳的日文标题自带年份后缀（…（2027）），那是某个站为「这一年那一季」
     * 单独建的记录，折进带季数的正主才是对的。
     */
    const extra = nb.slice(na.length);
    const marker = /^(第?\d{1,2}(期|季|クール|st|nd|rd|th)?|season\d|s\d|\d(ndseason|rdseason|thseason)|vol\d|part\d|新シリーズ|新アニメ|新作(tv)?アニメ|第?\d{1,2}シリーズ|new|tv)/i.test(extra);
    const yearTagged = /[（(]\s*(19|20)\d{2}\s*[)）]\s*$/.test(aja ?? '');
    if (!marker || yearTagged) return true;
  }
  return !!acn && !!bcn && normAlias(acn) === normAlias(bcn)
    && a.year === b.year && a.type === b.type && (a.episodes ?? 0) === (b.episodes ?? 0);
}
