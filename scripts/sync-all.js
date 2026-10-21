/**
 * 一键同步。给定时任务用。
 *
 * 同步频率的依据（见 REQUIREMENTS.md §2-D）：
 *   新番    每天 —— Bangumi 周导出（ingest-bgm.js，有新 dump 才下载）；AOD 上游已归档，改成月度
 *   放送表  每天 —— 番剧会换档，当季信息变化快
 *   中文名  每天 —— 随 ingest-bgm 以 Bangumi 为准（不再模糊匹配）
 *   系列    每月 —— 要全量重算，几分钟，不适合每天跑
 *   NSFW    每天 —— 一条 UPDATE、秒级；原来放在月度里，新番最长 30 天不被「隐藏 NSFW」挡住（#30）
 *
 * 用法：
 *   node scripts/sync-all.js               # 日常。距上次月度 >=30 天时会自动把月度补上
 *   node scripts/sync-all.js --monthly     # 强制立刻跑月度那三步
 *   node scripts/sync-all.js --no-monthly  # 强制跳过（排查时用，别写进定时任务）
 */
import { spawnSync } from 'node:child_process';
import { planMonthly, MONTHLY_DAYS } from './sync-plan.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../src/lib/server/envFile.js';

// 定时任务不经过 run-app，没人替它读 ~/.j-anime.env —— 里面的 J_ANIME_BACKUP_MIRROR
// 因此从来没生效过（#9）。必须在 import db.js 之前读：paths.js 在被 import 的那一刻
// 就定下了 J_ANIME_DATA。子脚本经 spawnSync 继承 process.env。
loadEnvFile();
const { getDb } = await import('../src/lib/server/db.js');

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 月度任务自己判断该不该跑 —— 不再依赖「有人记得手动跑 --monthly」。
 *
 * ⚠️ 这是一个真实的静默故障：launchd 里只装了一个 job（每天 04:30 跑裸的
 * sync-all.js），`--monthly` 只写在 deploy/README.md 里。实测 data/sync.log
 * 里「月度全量」出现 0 次 —— 也就是 mark-nsfw.js 和 build-franchise.js
 * 从部署那天起【一次都没跑过】。后果是每天新灌进来的番：
 *   · is_nsfw 恒为建表默认值 0 → 设置里的「隐藏 NSFW」对新番完全无效
 *   · 永远不进 franchise → 详情页「同系列」只能走那条回退查询
 *
 * 为什么不加第二个 plist 而是记在库里：加 plist 要主人重跑 install-sync.sh，
 * 忘了就等于没修；而且 launchd 的 StartCalendarInterval 撞上关机/休眠的行为
 * 不好预期（每天那个 job 已经因为 04:30 网络没起来整段失败过两次）。
 * 记 meta.last_monthly_at 则是：谁先跑到、距上次超过 30 天，谁就把它做掉，
 * 关机几天也只是晚几天，不会整轮跳过。
 */
const db = getDb();
const metaGet = (k) => db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value ?? null;
const metaSet = (k, v) => db.prepare(
  `INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, v);

const lastMonthly = metaGet('last_monthly_at');
// --no-monthly 排查时用，别在定时任务里加
const { monthly, forced } = planMonthly(lastMonthly, process.argv);
/**
 * 每一步的结果都记下来，整轮结束写一条 sync_all 汇总（#4）。
 * 原来失败只打一行日志就继续，sync_log 里 171 条全是 ok —— 失败的脚本通常直接
 * exit(1)，根本走不到写日志那一行；同步可以连挂一周而设置页上看不出来。
 */
const steps = [];
const startedAt = new Date();
const STEP_MS = 45 * 60_000, TOTAL_MS = 110 * 60_000;
const run = (script, ...args) => {
  const name = `${script} ${args.join(' ')}`.trim();
  process.stdout.write(`\n▶ ${name}\n`);
  const t = Date.now();
  // 每步限时，并给整轮留 10 分钟写汇总：计划任务 2 小时到点会连 sync-all 一起杀掉，那样 sync_log 连一条失败记录都没有
  // （原来某一步卡住 = 整晚无声无息，2026-10-21 审核）。ingest-bgm 要下 ~425MB，单步给 45 分钟
  const left = TOTAL_MS - (Date.now() - startedAt.getTime());
  const r = spawnSync(process.execPath, [join(HERE, script), ...args], { stdio: 'inherit', timeout: Math.max(60_000, Math.min(STEP_MS, left)) });
  if (r.error?.code === 'ETIMEDOUT') console.error(`  ⚠️ ${name} 超时，已结束`);
  const ok = r.status === 0;
  steps.push({ name: script, ok, sec: Math.round((Date.now() - t) / 1000) });
  if (!ok) console.error(`  ⚠️ ${name} 退出码 ${r.status}（继续后面的任务）`);
  return ok;
};

console.log(`🔄 j-anime 同步 —— ${monthly ? '月度全量' : '日常'} · ${new Date().toISOString()}`);
console.log(`   上次月度：${lastMonthly ?? '从未'}`
  + `${monthly ? `（${forced ? '命令行指定' : `距今 ≥ ${MONTHLY_DAYS} 天`}，这次补上）` : ''}`);

// 任何破坏性操作前先备份个人记录。备份没成就整个停下：后面 fix-dup-alias / ingest-bgm 会合并番单（applyAliasDupes），
// 原来返回值没人看，备份失败照样往下改（2026-10-21 审核）
if (!run('backup.js')) {
  db.prepare(`INSERT INTO sync_log (kind,started_at,finished_at,items,status,error)
              VALUES ('sync_all',?,datetime('now'),?,'failed',?)`)
    .run(startedAt.toISOString().slice(0, 19).replace('T', ' '), steps.length, '备份失败，同步中止（没有做任何改动）');
  console.error('\n❌ 备份失败，同步中止');
  process.exit(1);
}

// AOD 上游 2026-07-04 已归档（#1），每天下载 60MB 只会拿到同一份 —— 改成月度才跑一次全量
// （留着它是为了 AOD 独有的数据：MAL/AniList ID、英文标签、制作公司、关联）。新番改由 ingest-bgm 进库。
if (monthly) run('ingest-aod.js', '--refresh');

/**
 * ⚠️ 三步全成功才盖时间戳。任何一步失败就【不盖】，明天再来一次 ——
 * 否则一次断网的失败会把下次月度推到 30 天后，正好复现我们要修的那个故障。
 */
if (monthly) {
  const okAll = [
    run('build-franchise.js'),         // 新番要并进系列，这个只能全量重算
    run('reindex-fts.js')
  ].every(Boolean);
  if (okAll) {
    metaSet('last_monthly_at', new Date().toISOString());
    console.log('  ✅ 月度任务完成，已记时间戳');
  } else {
    console.error('  ⚠️ 月度任务有步骤失败 —— 不记时间戳，下次同步会再试');
  }
}
/**
 * 顺序（#2 换数据源之后）：
 *   AOD 侧的启发式修正 → ingest-bgm（以 Bangumi 为准覆盖：中文名、评分、日期、is_jp、title_ja、折叠）
 *   → 依赖 bgm 数据的派生（NSFW、有效状态、放送表）→ 搜索索引
 * ingest-bgm 必须排在 fix-* 后面：fix-isjp / fix-title-ja 是给「对不上 Bangumi 的 AOD 条目」用的启发式，
 * 对得上的条目以 Bangumi 为准，排在后面就是「最后写的说了算」。
 * enrich-bgm（拿 AOD 标题去 bgm 搜索 API 模糊匹配）已下线 —— 2,750 组错配就是它造成的。
 */
run('fix-bgm-clash.js');               // 剧场版匹到 TV 本篇时会带回本篇的放送日期，先清掉
run('fix-title-ja.js');                // title_ja 是去重的锚，得先修好再去重
run('fix-dup-alias.js');               // 折叠「主标题不同但其实是同一部」的薄壳记录
run('fix-isjp.js');                    // 对不上 Bangumi 的条目：纯汉字日本番漏判 / 国创误判
run('fix-episodes.js');                // AOD 对新番常写 episodes=0，用 bgm 的集数补上
run('ingest-bgm.js');                  // 主数据源：每周新 dump 才下载，每天都重新匹配一遍（秒级）
run('mark-nsfw.js');                   // AOD 标签 OR bgm 的 nsfw 标记
run('fix-status.js');                  // 按 bgm 放送日期 + 集数推有效状态
run('sync-calendar.js');               // 放送表：每天（bgm 新建的条目也能对上了）
run('sync-episodes.js');               // 在播番的分集用 API 刷（今天更新 / 分集列表），要排在放送表后面
run('reindex-fts.js');                 // 全量重建（整体一个事务）：bgm 中文名 / 别名每天都可能变
run('warm-covers.js', '--limit', monthly ? '1500' : '200');  // 预热封面，减少破图

/**
 * 汇总 + 新鲜度（#1、#4）：AOD 上游归档后数据停在 7 月 4 日三个多月，每天照样记 ok。
 * 现在的主数据源是 Bangumi 周导出（每周二），dump 日期超过 STALE_DAYS 天就记成 stale，设置页据此标红。
 */
const STALE_DAYS = 14;
const failed = steps.filter((s) => !s.ok).map((s) => s.name);
const snap = (metaGet('bgm_archive') ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
const ageDays = snap ? Math.floor((Date.now() - Date.parse(snap)) / 86400000) : null;
const stale = ageDays == null || ageDays > STALE_DAYS;
const status = failed.length ? 'partial' : stale ? 'stale' : 'ok';
const error = [failed.length ? `失败：${failed.join('、')}` : '',
               stale ? `元数据快照 ${snap ?? '未知'}（${ageDays ?? '?'} 天前）` : ''].filter(Boolean).join('；') || null;
db.prepare(`INSERT INTO sync_log (kind,started_at,finished_at,items,status,error)
            VALUES ('sync_all',?,datetime('now'),?,?,?)`)
  .run(startedAt.toISOString().slice(0, 19).replace('T', ' '), steps.length, status, error);

if (stale) console.warn(`\n⚠️ Bangumi 数据 ${snap ?? '未知'}，已经 ${ageDays ?? '?'} 天没更新（每周二应有新 dump）`);
if (failed.length) {
  console.error(`\n❌ 同步结束，${failed.length} 步失败：${failed.join('、')}`);
  process.exitCode = 1;   // 让任务计划程序 / launchd 的「上次运行结果」也看得出来
} else {
  console.log('\n✅ 同步结束');
}
