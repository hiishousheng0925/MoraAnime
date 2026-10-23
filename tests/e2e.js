/**
 * 端到端验收：模拟真实用户流程，断言结果而不是只看 HTTP 200。
 * 用法：node tests/e2e.js            （需要 dev server 在 5173）
 */
const BASE = process.env.BASE || 'http://localhost:5173';

/**
 * ⚠️ 安全闸门：本测试会 DELETE user_entry / watch_log / triage。
 * 早先它直接跑在应用数据库上，把主人的番单反复清空且不可恢复。
 * 现在必须经 `npm test`（scripts/test.js）在数据库副本上运行。
 */
import { assertTestCopy } from './copy-gate.js';
assertTestCopy();

/**
 * 多账号（2026-10-19）：打本站的请求统一带上管理员的会话（scripts/test.js 在副本里建的）。
 * 要以访客身份请求时在 init 里给 anon: true；要以别的账号请求时自己给 Cookie 头。
 */
const SESSION = process.env.TEST_SESSION;
const rawFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  const { anon, ...rest } = init;
  const h = new Headers(rest.headers);
  if (SESSION && !anon && String(url).startsWith(BASE) && !h.has('cookie')) h.set('cookie', `j_anime_sid=${SESSION}`);
  return rawFetch(url, { ...rest, headers: h });
};
let pass = 0, fail = 0;
const fails = [];

let skipped = 0;
/** 因环境（而不是代码）无法验证时用它 —— 不计入失败，但要在结果里显式说明 */
const skip = (why) => { skipped++; console.log(`  ⏭️  跳过：${why}`); };

const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(`${name} ${detail}`); console.log(`  ❌ ${name}  ${detail}`); }
};

/**
 * 断线重试一次。
 *
 * 为什么需要：有些断言中间会做上千毫秒的同步计算（比如全表扫的去重检查），
 * 这段时间里服务端把空闲的 keep-alive 连接关掉了，下一个 fetch 复用到死 socket，
 * 直接抛 ECONNRESET —— 表现是「测试跑到某一条就崩，服务端日志却什么都没有」，
 * 很容易误判成服务端挂了。
 */
async function once(fn) {
  try { return await fn(); } catch (e) {
    if (!String(e?.cause?.code ?? '').includes('ECONNRESET')) throw e;
    return fn();
  }
}
async function get(path) {
  const t = performance.now();
  const r = await once(() => fetch(BASE + path));
  const html = await r.text();
  return { status: r.status, html, ms: performance.now() - t };
}
/** 只看响应头 —— 验缓存策略用 */
async function head(path) {
  const r = await once(() => fetch(BASE + path));
  await r.text();
  return { status: r.status, cache: r.headers.get('cache-control') };
}
async function post(path, body) {
  const t = performance.now();
  const r = await once(() => fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }));
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  return { status: r.status, data, ms: performance.now() - t };
}
const has = (html, s) => html.includes(s);
/** 某个 Chip / 链接是否处于选中态（Chip 选中时带 border-accent） */
const chipOn = (html, label) => {
  const i = html.indexOf(label);
  if (i < 0) return false;
  const start = html.lastIndexOf('<a ', i);
  return start >= 0 && html.slice(start, i).includes('border-accent');
};
/** 侧栏首屏是展开还是收起（SSR 渲染出来的 class，不是 JS 跑完之后的） */
const drawerOpen = (html) => {
  const m = html.match(/<aside[^>]*class="([^"]*)"/);
  return !!m && m[1].includes('translate-x-0');
};
const cards = (html) => new Set(html.match(/href="\/anime\/(\d+)"/g) || []).size;
const noErr = (html) => !/sveltekit:error|Internal Error<|<pre class="error/.test(html);
const { readFileSync: readFileSync2 } = await import('node:fs');
// 全部 .svelte 文件 —— 给那些「全站扫一遍」的断言用
const ALL_SVELTE = await (async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const walk = (d) => readdirSync(d).flatMap((f) => {
    const p = `${d}/${f}`;
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.svelte') ? [p] : [];
  });
  return walk('src');
})();

// DB 直连，用于校验落库
const { getDb } = await import('../src/lib/server/db.js');
const db = getDb();
const q = (s, ...p) => db.prepare(s).get(...p);
const dbState = () => ({
  triage: q('SELECT count(*) c FROM triage').c,
  seen: q("SELECT count(*) c FROM triage WHERE verdict='seen'").c,
  entries: q('SELECT count(*) c FROM user_entry').c,
  vague: q('SELECT count(*) c FROM user_entry WHERE is_vague=1').c,
  logs: q('SELECT count(*) c FROM watch_log').c,
  tags: q('SELECT count(*) c FROM user_tag').c
});

console.log('\n━━━ 0. 重置到干净状态 ━━━');
// 页面默认筛选由 scripts/test.js 在复制数据库时统一清掉（环境隔离，不在这里重复）
db.exec('DELETE FROM watch_log; DELETE FROM user_entry; DELETE FROM triage;');
ok(dbState().triage === 0 && dbState().entries === 0, '数据库已清空');

console.log('\n━━━ 1. 冷启动：首页该给出引导 ━━━');
{
  const r = await get('/');
  ok(r.status === 200 && noErr(r.html), '首页 200 且无错误');
  ok(has(r.html, '尚无观看记录'), '显示冷启动引导块');
  ok(has(r.html, '开始快速标记'), '有「开始快速标记」入口');
  ok(cards(r.html) > 0, '冷启动也有番可看', `卡片数=${cards(r.html)}`);
}

console.log('\n━━━ 2. 快速标记：完整流程 ━━━');
let queue1;
{
  const r = await get('/triage');
  ok(r.status === 200 && noErr(r.html), '快速标记页 200');
  // 说明不再直接铺在页面上（UI 自解释），但要能展开查看
  ok(!has(r.html, '怎么用'), '页面上没有大段使用说明');
  /**
   * 操作后果要说，但只在【按钮旁边】说一次。
   * 底部操作栏写着「标了 N 部看过 · 其余 M 部记为没看过」，带实时数字，
   * 就在「下一批」旁边 —— 顶上再放一句静态说明是重复（主人截图指出来的）。
   * 这两条断言守的是：后果必须可见，而且是在操作处可见。
   */
  ok(has(r.html, '部看过') && has(r.html, '下一批'), '操作后果写在按钮旁边');
  // 规则现在收在 InfoTip 弹层里（点「?」展开）。弹层内容服务端不渲染，
  // 只能断言入口存在 —— 页面上不再有大段说明文字，这本身就是要保证的效果。
  ok(has(r.html, 'aria-label="规则"'), '规则收在「?」图标后面');
  ok(!has(r.html, '队列按知名度排序'), '页面上没有铺开的说明段落');
  ok(has(r.html, '记为没看过'), '明确警告了默认行为（其余 N 部记为没看过）');
  // 「判定不影响搜索」这条说明也在弹层里 —— 用源码断言，保证它没被删掉
  const { readFileSync } = await import('node:fs');
  ok(readFileSync('src/routes/triage/+page.svelte', 'utf8').includes('不影响目录与搜索'),
     '「判定不影响搜索」的说明仍在（收于「?」弹层内）');

  // 拿队列
  const rows = db.prepare(`
    SELECT a.id FROM anime a
    LEFT JOIN triage t ON t.anime_id=a.id LEFT JOIN user_entry ue ON ue.anime_id=a.id
    WHERE a.is_stub=0 AND a.is_jp=1 AND a.type='TV' AND a.source_count>=8
      AND a.status='FINISHED' AND t.anime_id IS NULL AND ue.anime_id IS NULL
    ORDER BY a.bgm_collection DESC NULLS LAST, a.source_count DESC LIMIT 6`).all();
  queue1 = rows.map((x) => x.id);
  ok(queue1.length === 6, '能取到队列', `拿到 ${queue1.length}`);

  // 提交：2 看过、1 没听过、3 没看过
  const batch = [
    { id: queue1[0], verdict: 'seen' }, { id: queue1[1], verdict: 'seen' },
    { id: queue1[2], verdict: 'never_heard' },
    { id: queue1[3], verdict: 'not_seen' }, { id: queue1[4], verdict: 'not_seen' },
    { id: queue1[5], verdict: 'not_seen' }
  ];
  const p = await post('/api/triage', { batch, limit: 6 });
  ok(p.status === 200 && p.data.ok, '批量提交成功');
  ok(p.data.batchId > 0, '返回了批次号', `batchId=${p.data.batchId}`);
  ok(p.data.queue?.length === 6, '自动补了下一屏', `补了 ${p.data.queue?.length}`);
  ok(!p.data.queue.some((x) => queue1.includes(x.id)), '新队列不含已判定的番');

  const s = dbState();
  ok(s.triage === 6, 'triage 落库 6 条', `实际 ${s.triage}`);
  ok(s.seen === 2, 'seen 落库 2 条', `实际 ${s.seen}`);
  ok(s.entries === 2, '「看过」生成 2 条番单记录', `实际 ${s.entries}`);
  ok(s.vague === 2, '这 2 条标记为模糊记录', `实际 ${s.vague}`);
}

console.log('\n━━━ 3. 撤销上一批 ━━━');
{
  const p = await post('/api/triage', { op: 'undo', limit: 6 });
  ok(p.status === 200 && p.data.ok, '撤销请求成功');
  ok(p.data.undone === 6, '撤销了 6 条', `实际 ${p.data.undone}`);
  const s = dbState();
  ok(s.triage === 0, 'triage 已清空', `实际 ${s.triage}`);
  ok(s.entries === 0, '模糊番单记录也清掉了', `实际 ${s.entries}`);
  ok(p.data.queue.some((x) => queue1.includes(x.id)), '撤销的番回到了队列里');
}

console.log('\n━━━ 4. 零选择保护（后端仍应接受，但前端会先确认）━━━');
{
  const batch = queue1.slice(0, 3).map((id) => ({ id, verdict: 'not_seen' }));
  const p = await post('/api/triage', { batch, limit: 6 });
  ok(p.data.ok && dbState().seen === 0, '全「没看过」也能提交');
  const r = await get('/triage');
  // 原来这里有个黄框「已判定 N 部，看过为 0 部，清空重来可将其全部放回队列」——
  // 和「重置队列」按钮讲的是同一件事，主人指出头部太乱，已删掉黄框只留按钮
  ok(has(r.html, '重置队列'), '页面上有回退入口');
  ok(!has(r.html, '清空重来'), '不再有重复的黄框提示');
  const before = dbState().triage;
  await post('/api/triage', { op: 'reset', limit: 6 });
  ok(dbState().triage === before, '整库清空的 op:reset 已下线（调了也不清）', `前 ${before} 后 ${dbState().triage}`);
  await post('/api/triage', { op: 'undo', limit: 6 });
  ok(dbState().triage === 0, '撤销把这批放回队列');
}

console.log('\n━━━ 4b. 快速标记建的记录被用户动过之后，撤销不能删它（曾删掉打过分的记录）━━━');
{
  const { setTriage, setEntry } = await import('../src/lib/server/queries.js');
  db.exec('DELETE FROM user_entry; DELETE FROM triage; DELETE FROM watch_log;');
  const q = (await post('/api/triage', { op: 'undo', limit: 4 })).data.queue.map((x) => x.id);
  ok(q.length === 4, '取到 4 部出题', String(q.length));
  const [scored, noted, restatus, untouched] = q;
  await post('/api/triage', { batch: q.map((id) => ({ id, verdict: 'seen' })), limit: 4 });
  const row = (id) => db.prepare('SELECT status, my_score, my_note, is_vague FROM user_entry WHERE anime_id=?').get(id);
  ok(q.every((id) => row(id)?.is_vague === 1), '整批先都是快速标记记录');

  await post('/api/entry', { id: scored, my_score: 9 });
  await post('/api/entry', { id: noted, my_note: '二刷候选' });
  await post('/api/entry', { id: restatus, status: 'on_hold' });
  ok(row(scored).is_vague === 0 && row(noted).is_vague === 0 && row(restatus).is_vague === 0,
     '打分 / 写短评 / 改状态后不再是快速标记记录');
  ok(row(untouched).is_vague === 1, '没动过的仍是快速标记记录');

  const u = await post('/api/triage', { op: 'undo', limit: 4 });
  ok(u.data.undone === 4, '撤销了这一批 4 部', String(u.data.undone));
  ok(row(scored)?.my_score === 9, '打过分的记录还在、分数还在');
  ok(row(noted)?.my_note === '二刷候选', '写过短评的记录还在');
  ok(row(restatus)?.status === 'on_hold', '改过状态的记录还在');
  ok(!row(untouched), '没动过的快速标记记录照常删掉');

  // 兜底：就算 is_vague 没清干净（setEntry 修好之前的历史数据），有分的也删不掉
  db.exec('DELETE FROM user_entry; DELETE FROM triage;');
  setTriage(scored, 'seen', 900);
  db.prepare('UPDATE user_entry SET my_score = 8 WHERE anime_id = ?').run(scored);   // 模拟旧数据：有分但 is_vague=1
  setTriage(scored, 'not_seen', 901);
  ok(row(scored)?.my_score === 8, '判成「没看过」也删不掉有分的旧记录');
  const { backfillTouchedVague } = await import('../src/lib/server/queries.js');
  ok(backfillTouchedVague() === 1 && row(scored).is_vague === 0, '迁移回填清掉旧数据的 is_vague');
  ok(backfillTouchedVague() === 0, '再跑一次回填是空操作');

  // 已有用户自己的记录时，快速标记「看过」不能把它改成快速标记记录
  setEntry(noted, { status: 'watching', current_episode: 3 });
  setTriage(noted, 'seen', 902);
  ok(row(noted).status === 'watching' && row(noted).is_vague === 0, '快速标记不覆盖已有的手动记录');
  db.exec('DELETE FROM user_entry; DELETE FROM triage; DELETE FROM watch_log;');
}

console.log('\n━━━ 5. 标记 + 进度 + 评分 ━━━');
let target;
{
  target = db.prepare(`SELECT id, episodes FROM anime WHERE is_stub=0 AND episodes BETWEEN 12 AND 26
                       AND title_cn IS NOT NULL ORDER BY bgm_collection DESC LIMIT 1`).get();
  ok(!!target, '找到一个测试用番', `id=${target?.id} eps=${target?.episodes}`);

  let p = await post('/api/entry', { id: target.id, status: 'watching' });
  ok(p.data.ok && p.data.entry.status === 'watching', '设为「在看」');

  for (let i = 1; i <= 3; i++) p = await post('/api/entry', { id: target.id, op: 'bump', delta: 1 });
  ok(p.data.entry.current_episode === 3, '+1 三次 → 第 3 集', `实际 ${p.data.entry.current_episode}`);
  ok(p.data.entry.is_vague === 0, '手动记集数后不再是模糊记录');

  p = await post('/api/entry', { id: target.id, op: 'bump', delta: -1 });
  ok(p.data.entry.current_episode === 2, '−1 → 第 2 集', `实际 ${p.data.entry.current_episode}`);

  p = await post('/api/entry', { id: target.id, my_score: 9 });
  ok(p.data.entry.my_score === 9, '评分写入');

  // 看到最后一集应自动变「看完」
  for (let i = 0; i < target.episodes; i++) p = await post('/api/entry', { id: target.id, op: 'bump', delta: 1 });
  ok(p.data.entry.status === 'completed', '看到最后一集自动变「看完」', `实际 ${p.data.entry.status}`);
  ok(p.data.entry.current_episode === target.episodes, '集数不会超过总集数', `实际 ${p.data.entry.current_episode}/${target.episodes}`);
  ok(p.data.entry.my_score === 9, '评分没有被进度更新覆盖');

  // 集数未定（AOD 对在播新番常写 episodes=0）：+1 不能被夹回 0 再判成看完
  const tbd = db.prepare(`SELECT id FROM anime WHERE is_stub=0 AND episodes=0 LIMIT 1`).get();
  ok(!!tbd, '找到一部集数未定的番', String(tbd?.id));
  p = await post('/api/entry', { id: tbd.id, op: 'bump', delta: 1 });
  ok(p.data.entry.status === 'watching' && p.data.entry.current_episode === 1,
     '集数未定的番 +1 → 在看第 1 集（曾直接变「看完 0 集」）', `${p.data.entry.status} ${p.data.entry.current_episode}`);
  p = await post('/api/entry', { id: tbd.id, op: 'bump', delta: 1 });
  ok(p.data.entry.current_episode === 2, '继续 +1 → 第 2 集');
  await post('/api/entry', { id: tbd.id, op: 'clear' });
}

console.log('\n━━━ 5a2. 标「看完」应自动补满集数（曾显示 0/25）━━━');
{
  const { setEntry, setTriage } = await import('../src/lib/server/queries.js');
  db.exec('DELETE FROM user_entry; DELETE FROM triage; DELETE FROM watch_log;');
  const a = db.prepare(`SELECT id, episodes FROM anime WHERE is_stub=0 AND episodes BETWEEN 12 AND 30
    AND coalesce(status_eff, status) = 'FINISHED' ORDER BY bgm_collection DESC LIMIT 1`).get();
  const ep = () => db.prepare('SELECT current_episode c, is_vague v FROM user_entry WHERE anime_id=?').get(a.id);

  setEntry(a.id, { status: 'completed' });
  ok(ep().c === a.episodes, '手动标「看完」→ 集数补满', `${ep().c}/${a.episodes}`);

  setEntry(a.id, { status: 'watching' });
  ok(ep().c === null, '改回「在看」→ 自动补的集数退回未填', String(ep().c));

  setEntry(a.id, { status: 'watching', current_episode: 5 });
  setEntry(a.id, { status: 'completed' });
  ok(ep().c === 5 || ep().c === a.episodes, '已有手填集数时不被覆盖成 0', String(ep().c));

  db.exec('DELETE FROM user_entry; DELETE FROM triage;');
  setTriage(a.id, 'seen', 1);
  // 快速标记「看过」也要补满：统计那边 completed 一律按 coalesce(current_episode, a.episodes)
  // 算，若这里留空，详情页「未填 / 空进度条」和统计的「累计集数」就自相矛盾。
  ok(ep().c === a.episodes, '快速标记「看过」→ 集数也补满', `${ep().c}/${a.episodes}`);
  ok(ep().v === 1, '仍标记为快速标记来的记录（撤销上一批要靠它）');
  const d = await get(`/anime/${a.id}`);
  // 断言要精确到「进度」那一处 —— 页面别处（评分按钮等）也会出现 >0</b>
  const prog = d.html.slice(d.html.indexOf('>进度<'), d.html.indexOf('>进度<') + 400);
  ok(!/<b>0<\/b>/.test(prog), '详情页进度处不显示 0');
  ok(!prog.includes('未填'), '详情页进度不显示「未填」');
  ok(prog.includes(String(a.episodes)), '详情页进度显示满集数', `找 ${a.episodes}`);

  // 历史数据：库里已经存在的空集数记录，靠迁移里的回填补上（scripts/migrate.js 启动时跑）
  db.exec('DELETE FROM user_entry; DELETE FROM triage; DELETE FROM watch_log;');
  const { backfillCompletedEpisodes } = await import('../src/lib/server/queries.js');
  db.prepare(`INSERT INTO user_entry (anime_id,status,current_episode,is_vague) VALUES (?, 'completed', NULL, 1)`).run(a.id);
  ok(backfillCompletedEpisodes() === 1, '回填补上历史的空集数');
  ok(ep().c === a.episodes, '回填后集数是满的', `${ep().c}/${a.episodes}`);
  ok(backfillCompletedEpisodes() === 0, '再跑一次回填是空操作');
  db.exec('DELETE FROM user_entry; DELETE FROM triage; DELETE FROM watch_log;');

  // 还没播完的番：「看完」补到已播集数（2026-10-23 主人报：恶女不才 Bangumi 只播了 11 集、另一个数据源写 12，被补成 12）
  const { airedCount } = await import('../src/lib/server/episodes.js');
  const on = db.prepare(`SELECT id, episodes FROM anime WHERE is_stub=0 AND episodes > 1 AND bgm_id IS NOT NULL
      AND coalesce(status_eff, status) = 'ONGOING' ORDER BY bgm_collection DESC LIMIT 40`).all()
    .map((x) => ({ ...x, ac: airedCount(x.id) })).find((x) => x.ac && x.ac.aired > 0);
  if (on) {
    const cur = () => db.prepare('SELECT current_episode c FROM user_entry WHERE anime_id=?').get(on.id)?.c;
    setEntry(on.id, { status: 'completed' });
    ok(cur() === on.ac.aired, '还没播完的番标「看完」→ 补到已播集数，不是总集数', `${cur()}（已播 ${on.ac.aired} / 共 ${on.episodes}）`);
    setEntry(on.id, { status: 'watching' });
    ok(cur() === null, '改回「在看」→ 补的已播集数也退回未填', String(cur()));
  } else console.log('  ⏭️  库里没有连载中且有分集数据的番，跳过');
  db.exec('DELETE FROM user_entry; DELETE FROM triage; DELETE FROM watch_log;');
}

console.log('\n━━━ 5b. 首页：只做过快速标记（没有在看的）不能是死胡同 ━━━');
{
  db.exec('DELETE FROM watch_log; DELETE FROM user_entry; DELETE FROM triage;');
  const { setTriage } = await import('../src/lib/server/queries.js');
  const ids = db.prepare(`SELECT id FROM anime WHERE is_stub=0 AND is_jp=1 AND type='TV'
    AND source_count>=8 AND status='FINISHED' ORDER BY bgm_collection DESC NULLS LAST LIMIT 5`).all().map((r) => r.id);
  setTriage(ids[0], 'seen', 1); setTriage(ids[1], 'seen', 1);
  setTriage(ids[2], 'not_seen', 1); setTriage(ids[3], 'never_heard', 1);

  const r = await get('/');
  ok(noErr(r.html), '首页无错误');
  ok(cards(r.html) > 0, '⚠️ 关键：不能是 0 张卡片的空白页', `卡片数=${cards(r.html)}`);
  ok(has(r.html, '快速标记进度'), '显示快速标记进度');
  ok(has(r.html, '继续标记'), '有「继续标记」入口');
  ok(has(r.html, '浏览目录'), '有「浏览目录」入口');
  /**
   * 标题从「接下来看什么」改成「推荐」（前者是口语提问式）；
   * 右上角从来源标签（「口味相近」，不能点、又在解释算法）
   * 改成去目录的入口 —— 和「我在追的」右边的「全部 →」同一种东西。
   * 推荐是「挑几个给你看」，看不中就该有地方去翻全部。
   */
  ok(has(r.html, '推荐'), '有推荐区');
  ok(/href="\/catalog"[^>]*>目录/.test(r.html) || /目录 →/.test(r.html),
     '推荐区右上角是去目录的链接');
  ok(!has(r.html, '口味相近') && !has(r.html, '口碑最高'),
     '不再把来源标签印在区块右上角');
  ok(has(r.html, '最近已看过'), '能看到自己标过的番');
  /**
   * 首页区块顺序：推荐 → 我在追的 → 最近已看过（主人定的）。
   * 「我在追的」通常只有两三条，而且侧栏和顶栏已经有「在看 N」的入口，
   * 首屏第一眼给「接下来能看什么」更有用。
   */
  // ⚠️ 只校验【出现了的那些】区块的相对顺序。「我在追的」在某些数据状态下是空的
  // （{#if items.length} 整个不渲染），写死三个都要在就会假失败 ——
  // 实测 dev 那轮碰巧有在看的番所以过了，发布闸门打产物时那一份副本没有，直接挂红。
  const order = ['推荐', '我在追的', '最近已看过']
    .map((t) => [t, r.html.indexOf(t)]).filter(([, i]) => i >= 0);
  ok(order.length >= 2 && order.every(([, i], k) => k === 0 || order[k - 1][1] < i),
     '首页顺序是 推荐 → 我在追的 → 最近已看过',
     order.map(([t, i]) => `${t}@${i}`).join(' < '));
  ok(!has(r.html, '尚无观看记录'), '不再显示冷启动引导（已经标过了）');
}

console.log('\n━━━ 5c. 推荐在任何状态下都不为空 ━━━');
{
  const { recommend } = await import('../src/lib/server/queries.js');
  ok(recommend(12).length === 12, '有标记记录时推荐满 12 条', `实际 ${recommend(12).length}`);
  db.exec('DELETE FROM user_entry; DELETE FROM triage;');
  ok(recommend(12).length === 12, '零记录时推荐也满 12 条（兜底生效）', `实际 ${recommend(12).length}`);
}

console.log('\n━━━ 5d. 清除记录（曾经点了没反应）━━━');
{
  const t2 = db.prepare('SELECT id FROM anime WHERE is_stub=0 LIMIT 1').get();
  await post('/api/entry', { id: t2.id, status: 'plan' });
  ok(dbState().entries === 1, '先加进番单');
  // 旧实现传 status:null，被 ?? 吃掉，等于没生效
  await post('/api/entry', { id: t2.id, status: null });
  ok(dbState().entries === 1, '（回归）status:null 确实清不掉 —— 所以必须有 op=clear');
  const r = await post('/api/entry', { id: t2.id, op: 'clear' });
  ok(r.data.ok && r.data.cleared === true, 'op=clear 返回成功');
  ok(dbState().entries === 0, '记录真的被删掉了');
  const det = await get(`/anime/${t2.id}`);
  ok(det.html.includes('再点一次高亮的状态即可取消') === false || noErr(det.html), '详情页正常');
}

console.log('\n━━━ 6. 首页在有数据后应该有用 ━━━');
{
  await post('/api/entry', { id: target.id, status: 'watching', current_episode: 3 });
  const r = await get('/');
  ok(noErr(r.html), '首页无错误');
  ok(!has(r.html, '先把看过的番标出来'), '不再显示冷启动引导');
  ok(has(r.html, '我在追的'), '显示「我在追的」');
  ok(cards(r.html) > 0, '首页有内容（不是空白页）', `卡片数=${cards(r.html)}`);
  ok(has(r.html, '+1'), '有 +1 按钮');
}

console.log('\n━━━ 7. 详情页 ━━━');
{
  const r = await get(`/anime/${target.id}`);
  ok(r.status === 200 && noErr(r.html), '详情页 200');
  ok(has(r.html, '我的评分'), '有评分区');
  ok(has(r.html, '进度'), '有进度区');
  const r404 = await get('/anime/99999999');
  ok(r404.status === 404, '不存在的 id 返回 404', `实际 ${r404.status}`);
}

console.log('\n━━━ 8. 目录：搜索 / 筛选 / 分页 ━━━');
{
  const base = await get('/catalog');
  ok(base.status === 200 && noErr(base.html), '目录页 200');
  // 每页条数从 60 改成默认 24（一排 8 张 × 3 排，主人要求和番单一致）
  ok(cards(base.html) === 24, '默认一页 24 张', `卡片数=${cards(base.html)}`);

  const jaSearch = await get('/catalog?q=' + encodeURIComponent('鬼滅の刃'));
  ok(cards(jaSearch.html) > 0, '日文搜索有结果', `${cards(jaSearch.html)} 条`);
  const romaji = await get('/catalog?q=Kimetsu');
  ok(cards(romaji.html) > 0, '罗马字搜索有结果', `${cards(romaji.html)} 条`);
  const cn = db.prepare("SELECT title_cn FROM anime WHERE title_cn IS NOT NULL AND length(title_cn)>=4 ORDER BY bgm_collection DESC LIMIT 1").get();
  const cnSearch = await get('/catalog?q=' + encodeURIComponent(cn.title_cn));
  ok(cards(cnSearch.html) > 0, `中文搜索有结果（「${cn.title_cn}」）`, `${cards(cnSearch.html)} 条`);
  // 关键：bgm 新补的中文名（AOD 里原本没有）也必须能搜到
  const fresh = db.prepare(`SELECT a.id, a.title_cn FROM anime a
    WHERE a.title_cn IS NOT NULL AND length(a.title_cn) >= 4
      AND NOT EXISTS (SELECT 1 FROM anime_alias al WHERE al.anime_id=a.id AND al.alias=a.title_cn)
    LIMIT 1`).get();
  if (fresh) {
    const fr = await get('/catalog?q=' + encodeURIComponent(fresh.title_cn));
    ok(cards(fr.html) > 0, `新补中文名可搜（「${fresh.title_cn}」）`, `${cards(fr.html)} 条`);
  } else {
    ok(true, '没有「未进别名表」的中文名（索引是完整的）');
  }
  const junk = await get('/catalog?q=' + encodeURIComponent('zzzz不存在的番zzzz'));
  // 搜索时筛选没生效（没开「应用筛选」），空态说「没有找到」而不是叫人放宽筛选
  ok(has(junk.html, '没有找到') && !has(junk.html, '请放宽筛选条件') && noErr(junk.html), '无结果时优雅显示');
  const punct = await get('/catalog?q=' + encodeURIComponent('#$%^&*'));
  ok(punct.status === 200 && noErr(punct.html), '纯标点搜索不崩', `状态 ${punct.status}`);

  const ongoing = await get('/catalog?status=ONGOING');
  ok(cards(ongoing.html) > 0 && noErr(ongoing.html), '「连载中」筛选有结果');
  const short = await get('/catalog?short=1');
  ok(cards(short.html) > 0 && noErr(short.html), '「泡面番」筛选有结果');
  const combo = await get('/catalog?type=TV&from=2020&to=2024&status=FINISHED&epmax=13&sort=score');
  ok(noErr(combo.html), '组合筛选不崩');
  const p2 = await get('/catalog?p=2');
  ok(cards(p2.html) > 0 && noErr(p2.html), '第 2 页有结果');
  ok(p2.html !== base.html, '第 2 页内容与第 1 页不同');
}

console.log('\n━━━ 8b. 年份下限 1950（默片短片不该出现）━━━');
{
  const { listAnime } = await import('../src/lib/server/queries.js');
  const { YEAR_FLOOR } = await import('../src/lib/constants.js');
  const r = listAnime({ types: ['TV','MOVIE','ONA'], jpOnly: true, yearMin: YEAR_FLOOR, requireYear: true },
                      { limit: 500, sort: 'oldest' });
  const tooOld = r.rows.filter((x) => x.year < YEAR_FLOOR || x.year == null);
  ok(tooOld.length === 0, `没有 ${YEAR_FLOOR} 年前或无年份的条目`, `越界 ${tooOld.length} 条`);
  const oldest = await get('/catalog?sort=oldest');
  ok(!/>19[0-4]\d</.test(oldest.html), '目录页「最早」排序里看不到 1940 年代及更早');
  // ⚠️ 只能检查「渲染出来的卡片」。1917 会出现在年份下拉的水合数据里，
  // 用整页 includes('1917') 判断会误报。
  const shownYears = [...oldest.html.matchAll(/href="\/anime\/\d+"[\s\S]{0,1200}?ink-400">\s*(\d{4})(?:\s|<)/g)]   // 元信息行「2026 · 12 集」（2026-10 起年份和集数拼在同一个 div）
    .map((m) => +m[1]);
  ok(shownYears.length > 0, '能解析出卡片上的年份', `解析到 ${shownYears.length} 个`);
  ok(shownYears.every((y) => y >= YEAR_FLOOR), `卡片年份全部 ≥ ${YEAR_FLOOR}`,
     shownYears.length ? `最小 ${Math.min(...shownYears)}` : '');
  ok(!shownYears.includes(1917), '1917 年那批默片不出现在卡片上');
}

console.log('\n━━━ 8c. 题材筛选 ━━━');
{
  const { listAnime } = await import('../src/lib/server/queries.js');
  const base = listAnime({ types: ['TV'], jpOnly: true, requireYear: true }, { limit: 1 }).total;
  const fan = listAnime({ types: ['TV'], jpOnly: true, requireYear: true, genres: ['奇幻'] }, { limit: 1 }).total;
  const fanRom = listAnime({ types: ['TV'], jpOnly: true, requireYear: true, genres: ['奇幻','爱情'] }, { limit: 1 }).total;
  ok(fan > 0 && fan < base, '单题材筛选生效', `全部 ${base} → 奇幻 ${fan}`);
  ok(fanRom > 0 && fanRom < fan, '多题材是「同时满足」', `奇幻 ${fan} → 奇幻+爱情 ${fanRom}`);
  // 三槽位：必须全部包含(AND) / 至少包含一个(OR) / 排除(NOT)
  const B = { types: ['TV'], jpOnly: true, requireYear: true };
  const cnt = (o) => listAnime({ ...B, ...o }, { limit: 1 }).total;

  const anyTwo = cnt({ genresAny: ['奇幻', '爱情'] });
  ok(anyTwo > fanRom, '「至少包含一个」宽于「必须全部包含」', `${fanRom} → ${anyTwo}`);
  ok(anyTwo > fan, '「至少包含一个」也宽于单个题材', `${fan} → ${anyTwo}`);
  ok(cnt({ genresAny: ['奇幻'] }) === fan, '单个题材时两个槽位结果一致');

  // 混合：校园 且 (喜剧|奇幻)
  const school = cnt({ genres: ['校园'] });
  const mixed = cnt({ genres: ['校园'], genresAny: ['喜剧', '奇幻'] });
  ok(mixed < school, '混合逻辑比单独 AND 槽更窄', `校园 ${school} → 校园且(喜剧|奇幻) ${mixed}`);
  ok(mixed < cnt({ genresAny: ['喜剧', '奇幻'] }), '混合逻辑也比单独 OR 槽更窄');
  const mixedNot = cnt({ genres: ['校园'], genresAny: ['喜剧', '奇幻'], genresNot: ['后宫'] });
  ok(mixedNot < mixed, '再叠加「排除」进一步收窄', `${mixed} → ${mixedNot}`);

  const q3 = '/catalog?g=' + encodeURIComponent('校园') +
             '&any=' + encodeURIComponent('喜剧') + '&any=' + encodeURIComponent('奇幻') +
             '&ng=' + encodeURIComponent('后宫');
  const mp = await get(q3);
  ok(noErr(mp.html) && cards(mp.html) > 0, '三槽位组合页面正常', `${cards(mp.html)} 条`);
  // ⚠️ 筛选面板在 {#if open} 里，服务端不渲染 —— 面板内的文案无法用 HTTP 断言。
  // 能验证的是「已生效标签行」（常驻渲染），它同样能证明三个槽位各自生效。
  ok(mp.html.includes('（任一）') && mp.html.includes('排除 后宫'),
     '已生效标签按槽位区分显示（AND 直接显示名称 / OR 带「任一」/ NOT 带「排除」）');
  ok(mp.html.includes('校园'), 'AND 槽的题材出现在已生效标签里');

  // 同一题材只能落在一个槽位
  const both = await get('/catalog?g=' + encodeURIComponent('喜剧') + '&any=' + encodeURIComponent('喜剧'));
  ok(noErr(both.html), '同题材同时出现在两个槽位时不崩');

  // 旧链接兼容：gm=or
  const legacy = cnt({ genres: [], genresAny: ['奇幻', '爱情'] });
  const legacyPage = await get('/catalog?g=' + encodeURIComponent('奇幻') +
                               '&g=' + encodeURIComponent('爱情') + '&gm=or');
  ok(noErr(legacyPage.html), '旧的 gm=or 链接仍然可用');
  ok(legacy === anyTwo, 'gm=or 等价于放进「至少包含一个」槽');

  const noHarem = listAnime({ types: ['TV'], jpOnly: true, requireYear: true, genresNot: ['后宫'] }, { limit: 1 }).total;
  ok(noHarem > 0 && noHarem < base, '排除题材生效', `全部 ${base} → 排除后宫 ${noHarem}`);
  const r = await get('/catalog?g=' + encodeURIComponent('奇幻'));
  ok(cards(r.html) > 0 && noErr(r.html), '题材筛选页正常', `${cards(r.html)} 条`);
  const r2 = await get('/catalog?ng=' + encodeURIComponent('后宫'));
  ok(cards(r2.html) > 0 && noErr(r2.html), '排除题材页正常');
}

console.log('\n━━━ 8d. 更新日筛选（bgm 放送表）━━━');
{
  const { listAnime } = await import('../src/lib/server/queries.js');
  let any = 0;
  for (let wd = 1; wd <= 7; wd++) any += listAnime({ weekday: wd, jpOnly: true }, { limit: 1 }).total;
  ok(any > 0, '放送表数据已灌入', `七天合计 ${any} 部`);
  const r = await get('/catalog?wd=3');
  ok(noErr(r.html), '按更新日筛选不崩');
}

console.log('\n━━━ 8e. 标题回退：不该出现纯假名标题（有罗马字时）━━━');
{
  const { dispTitle } = await import('../src/lib/format.js');
  const kana = /^[぀-ヿ\s・！？]+$/;
  const { getDb } = await import('../src/lib/server/db.js');
  const rows = getDb().prepare(`SELECT title, title_ja, title_cn FROM anime
    WHERE title_cn IS NULL AND title_ja IS NOT NULL AND title IS NOT NULL LIMIT 200`).all();
  const bad = rows.filter((r) => kana.test(dispTitle(r)));
  ok(bad.length === 0, '没有中文名时优先显示罗马字而不是假名', `仍显示假名 ${bad.length} 条`);
}

console.log('\n━━━ 8f. 分页（曾经「点下一页还是第一页」）━━━');
{
  const ids = (h) => [...new Set((h.match(/href="\/anime\/(\d+)"/g) || []))];
  const nextHref = (h) => {
    // 文字前允许有标签：手机上「下一页」包在 max-sm:hidden 的 span 里，只露箭头
    const m = h.match(/<a href="([^"]+)"[^>]*>(?:\s|<[^>]*>)*下一页/);
    return m ? m[1].replace(/&amp;/g, '&') : null;
  };

  // ── 直接单元测 makeHref：根因就在这里（无条件 delete('p') 把刚设的页码抹了）
  // 从纯模块导入 —— urlState.js 引了 $app/navigation，在 Node 里跑不起来
  const { makeHref } = await import('../src/lib/urlBuild.js');
  const to = makeHref('/catalog', new URLSearchParams('type=TV&g=%E5%A5%87%E5%B9%BB'));
  const paged = new URL('http://x' + to({ p: 2 })).searchParams;
  ok(paged.get('p') === '2', '⚠️ 关键：显式翻页时 p 不被重置', `p=${paged.get('p')}`);
  ok(paged.get('type') === 'TV' && paged.getAll('g').length === 1, '翻页时筛选条件保留');
  const to3 = makeHref('/catalog', new URLSearchParams('type=TV&p=3'));
  ok(!new URL('http://x' + to3({ type: ['OVA'] })).searchParams.has('p'),
     '改筛选时页码回到第 1 页');
  ok(new URL('http://x' + to3({ p: 5 })).searchParams.get('p') === '5', 'p=5 能设进去');

  // ── 端到端：真的点「下一页」
  for (const start of ['/catalog', '/catalog?type=TV',
                       '/catalog?g=' + encodeURIComponent('奇幻') + '&status=FINISHED&sort=score']) {
    const h1 = (await get(start)).html;
    const nx = nextHref(h1);
    ok(!!nx, `${start} 有下一页链接`);
    if (!nx) continue;
    ok(new URL('http://x' + nx).searchParams.get('p') === '2', `${start} 下一页带 p=2`);
    const h2 = (await get(nx)).html;
    const a = ids(h1), b = ids(h2);
    ok(b.length > 0 && a.filter((x) => b.includes(x)).length === 0,
       `${start} 两页内容无重叠`, `${a.length} vs ${b.length}`);
    // 筛选条件必须原样保留
    const q0 = new URL('http://x' + start).searchParams;
    const q1 = new URL('http://x' + nx).searchParams;
    const lost = [...q0.keys()].filter((k) => q0.getAll(k).join() !== q1.getAll(k).join());
    ok(lost.length === 0, `${start} 翻页保留全部筛选`, lost.join(','));
  }

  // ── 排行榜分页
  const rk = (await get('/ranking?decade=2010')).html;
  // 原来排行榜自己拼「1–30 / 31–60」那排按钮，现在统一走 Pager（上一页/下一页 + 页码输入）
  // HTML 里 & 是 &amp;，所以先还原再匹配 —— 上一版正则漏了这点，测出来 0 个链接
  const pl = [...rk.replace(/&amp;/g, '&').matchAll(/<a href="([^"]*[?&]p=\d+[^"]*)"/g)].map((m) => m[1]);
  ok(pl.length >= 1, '排行榜有分页链接', `${pl.length} 个`);
  ok(/下一页/.test(rk), '排行榜用的是共用分页组件');
  if (pl.length >= 2) {
    ok(new URL('http://x' + pl[1]).searchParams.get('decade') === '2010', '排行榜翻页保留年代筛选');
    const b = ids((await get(pl[1])).html);
    ok(ids(rk).filter((x) => b.includes(x)).length === 0, '排行榜两页无重叠');
  }
}

console.log('\n━━━ 9. 我的番单 / 排行榜 ━━━');
{
  for (const st of ['watching', 'plan', 'completed', 'on_hold', 'dropped']) {
    const r = await get('/mine?status=' + st);
    ok(r.status === 200 && noErr(r.html), `番单 tab「${st}」正常`);
  }
  const rk = await get('/ranking');
  ok(rk.status === 200 && noErr(rk.html), '排行榜 200');
  ok(cards(rk.html) > 0, '排行榜有内容', `${cards(rk.html)} 条`);
  const rk2 = await get('/ranking?type=MOVIE&decade=2010');
  ok(noErr(rk2.html), '排行榜筛选不崩');

  // ⚠️ bgm 用 rank=0 表示未进榜，曾经被当成第 0 名顶到榜首
  const { listAnime } = await import('../src/lib/server/queries.js');
  const rows = listAnime({ types: ['TV'], jpOnly: true, rankedOnly: true }, { limit: 30, sort: 'score' }).rows;
  ok(rows.every((r) => r.bgm_rank > 0), '排行榜里没有 rank=0（未进榜）的条目');
  ok(rows.every((r) => (r.bgm_votes ?? 0) >= 100), '榜上条目都有足够票数',
     `最少 ${Math.min(...rows.map((r) => r.bgm_votes ?? 0))} 票`);
  const scores = rows.map((r) => r.bgm_score);
  ok(scores[0] >= scores[scores.length - 1], '分数大致由高到低', `${scores[0]} → ${scores[scores.length-1]}`);
  ok(scores[0] >= 8, '榜首是高分番', `榜首 ${scores[0]}`);

  // 我的番单筛选
  const { setEntry, stats } = await import('../src/lib/server/queries.js');
  const some = getDb().prepare(`SELECT id FROM anime WHERE is_stub=0 AND title_cn IS NOT NULL
    AND year >= 2015 ORDER BY bgm_collection DESC LIMIT 6`).all();
  for (const x of some) setEntry(x.id, { status: 'completed' });
  const mine = await get('/mine?status=completed');
  ok(cards(mine.html) === some.length, '番单显示全部已看', `${cards(mine.html)}/${some.length}`);
  ok(mine.html.includes('>题材<'), '番单有题材筛选');
  ok(mine.html.includes('年份'), '番单有年份筛选');
  const y = getDb().prepare(`SELECT a.year FROM user_entry ue JOIN anime a ON a.id=ue.anime_id
    WHERE ue.status='completed' AND a.year IS NOT NULL LIMIT 1`).get().year;
  const filtered = await get(`/mine?status=completed&from=${y}&to=${y}`);
  ok(cards(filtered.html) > 0 && cards(filtered.html) <= some.length, '番单按年份筛选生效',
     `${y} 年 ${cards(filtered.html)} 部`);

  // 2026-10 UI 大改：卡片显示我的评分、「看完」不再印 12/12、「继续看」书架、页头均分和统计页同口径
  setEntry(some[0].id, { status: 'completed', my_score: 8 });
  setEntry(some[1].id, { status: 'watching', current_episode: 2 });
  const done = await get('/mine?status=completed');
  ok(done.html.includes('★ 8.0'), '番单卡片显示我的评分（一位小数）');
  ok(!/看完 \d+\/\d+/.test((await get('/mine')).html), '「看完」不再带 N/N 进度');
  const all = await get('/mine');
  ok(all.html.includes('继续看') && all.html.includes(`href="/anime/${some[1].id}/watch"`),
     '「全部」顶部有继续看书架，直达观看页');
  ok(!(await get('/mine?status=completed')).html.includes('继续看'), '单一状态页签没有书架');
  const avg = stats().avgScore;
  ok(avg != null && all.html.includes(`>${avg.toFixed(1)}<`), '页头均分和统计页同口径', `统计页 ${avg}`);
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');
}

console.log('\n━━━ 10. 性能：每个路由都要 < 300ms ━━━');
{
  const routes = ['/', '/triage', '/catalog', '/catalog?q=' + encodeURIComponent('战'),
                  '/catalog?p=3', '/mine', '/ranking', `/anime/${target.id}`];
  for (const rt of routes) {
    await get(rt);                       // 预热
    const times = [];
    for (let i = 0; i < 3; i++) times.push((await get(rt)).ms);
    const avg = times.reduce((a, b) => a + b) / times.length;
    ok(avg < 300, `${rt}  ${avg.toFixed(0)}ms`, avg >= 300 ? '⚠️ 太慢' : '');
  }
}


console.log('\n━━━ 12. 导出 / 导入 往返还原（P0 缺口）━━━');
{
  db.exec('DELETE FROM user_entry; DELETE FROM triage; DELETE FROM watch_log; DELETE FROM user_tag;');
  const { setEntry, setTriage } = await import('../src/lib/server/queries.js');
  const ids = db.prepare(`SELECT id FROM anime WHERE is_stub=0 AND title_cn IS NOT NULL
    ORDER BY bgm_collection DESC LIMIT 5`).all().map((r) => r.id);
  setEntry(ids[0], { status: 'completed', current_episode: 12, my_score: 9, my_note: '短评带,逗号和"引号' });
  setEntry(ids[1], { status: 'watching', current_episode: 3 });
  setEntry(ids[2], { status: 'plan' });
  setEntry(ids[3], { status: 'dropped', current_episode: 2, my_score: 4 });
  setEntry(ids[4], { status: 'completed', is_vague: 1 });
  setTriage(ids[4], 'seen', 1);

  const snap = () => db.prepare(`SELECT anime_id,status,current_episode,my_score,my_note,is_vague
    FROM user_entry ORDER BY anime_id`).all();
  const before = snap();

  const dump = await (await fetch(BASE + '/api/export')).json();
  ok(dump.app === 'j-anime' && dump.counts.entries === 5, '导出 JSON 结构正确', JSON.stringify(dump.counts));

  db.exec('DELETE FROM user_entry; DELETE FROM triage; DELETE FROM watch_log; DELETE FROM user_tag;');
  const r = await post('/api/import', { payload: dump, replace: true });
  ok(r.data.ok, '导入成功');
  ok(r.data.unresolved?.length === 0, '没有定位不到的条目');
  ok(JSON.stringify(snap()) === JSON.stringify(before), '⚠️ 关键：所有字段逐一还原（状态/集数/评分/短评/模糊标记）');
  ok(!('tags' in dump), '「我的标签」已下线，备份不再导出 tags');

  const csv = await get('/api/export?format=csv');
  const lines = csv.html.trim().split('\n');
  ok(lines.length === 6, 'CSV 行数正确（1 表头 + 5 条）', `实际 ${lines.length}`);
  // fetch 的 .text() 会按规范吃掉 BOM，所以必须直接看字节
  const csvBytes = new Uint8Array(await (await fetch(BASE + '/api/export?format=csv')).arrayBuffer());
  ok(csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
     'CSV 带 BOM（Excel 打开中文不乱码）', [...csvBytes.slice(0, 3)].join(','));
  ok(lines.some((l) => l.includes('""引号')), 'CSV 正确转义了引号与逗号');
  const bad = await post('/api/import', { payload: { app: 'other' } });
  ok(bad.status === 400, '拒绝非本应用的备份文件');
  db.exec('DELETE FROM user_entry; DELETE FROM triage; DELETE FROM watch_log; DELETE FROM user_tag;');
}

console.log('\n━━━ 12b. 备份 v2：观看站 / 手排顺序 / 手动关联 / 设置也要能还原；清空前自动备份 ━━━');
{
  const { setEntry, moveInSeries, linkAnime } = await import('../src/lib/server/queries.js');
  const { pruneBackups, saveBackup } = await import('../src/lib/server/backup.js');
  const { existsSync, readdirSync, writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  db.exec('DELETE FROM user_entry; DELETE FROM manual_relation; DELETE FROM watch_site;');
  const fm = db.prepare(`SELECT fm.anime_id FROM franchise_member fm JOIN franchise fr ON fr.id=fm.franchise_id
    WHERE fr.size BETWEEN 3 AND 8 ORDER BY fr.id, fm.release_order LIMIT 2`).all().map((r) => r.anime_id);
  const [x, y] = db.prepare(`SELECT id FROM anime WHERE is_stub=0 AND anilist_id IS NOT NULL
    ORDER BY bgm_collection DESC LIMIT 2`).all().map((r) => r.id);
  setEntry(x, { status: 'completed', my_score: 8 });
  moveInSeries(fm[1], 'up');
  linkAnime(x, y);
  db.prepare("INSERT INTO watch_site (name,url,ord) VALUES ('测试站点','https://example.com/s?q={q}',0)").run();
  db.prepare("INSERT OR REPLACE INTO setting (key,value) VALUES ('test_key','v1')").run();

  const dump = await (await fetch(BASE + '/api/export')).json();
  ok(dump.version === 2, '备份格式升到 v2');
  ok(dump.watchSites.length === 1 && dump.seriesOrder.length > 0 && dump.relations.length === 1
     && dump.settings.some((s) => s.key === 'test_key'), '导出里有观看站 / 手排顺序 / 手动关联 / 设置',
     JSON.stringify({ w: dump.watchSites.length, o: dump.seriesOrder.length, r: dump.relations.length }));

  db.exec(`DELETE FROM user_entry; DELETE FROM manual_relation; DELETE FROM watch_site;
           UPDATE franchise_member SET user_order=NULL; DELETE FROM setting WHERE key='test_key';`);
  const r = await post('/api/import', { payload: dump, replace: true });
  ok(r.data.ok && r.data.watchSites === 1 && r.data.relations === 1, '四类数据导入回来',
     JSON.stringify({ w: r.data.watchSites, o: r.data.seriesOrder, r: r.data.relations, s: r.data.settings }));
  ok(db.prepare('SELECT count(*) c FROM franchise_member WHERE user_order IS NOT NULL').get().c === dump.seriesOrder.length,
     '手排顺序还原');
  ok(db.prepare("SELECT value FROM setting WHERE key='test_key'").get()?.value === 'v1', '设置还原');

  // 清空前必须先自动备份，而且写进测试自己的目录（scripts/test.js 设了 J_ANIME_BACKUPS）
  ok(!!r.data.safety && existsSync(r.data.safety), '清空导入前自动留了一份备份', r.data.safety);
  ok(!!process.env.J_ANIME_BACKUPS && r.data.safety.startsWith(process.env.J_ANIME_BACKUPS),
     '自动备份没写进正式备份目录', r.data.safety);

  // v1 的旧备份文件照样能导入（没有那四个键）
  const v1 = { ...dump, version: 1 };
  for (const k of ['watchSites', 'seriesOrder', 'relations', 'settings']) delete v1[k];
  const r1 = await post('/api/import', { payload: v1 });
  ok(r1.data.ok && r1.data.entries === dump.entries.length, 'v1 旧备份照样能导入');

  // prune 只删自己的文件 —— 镜像目录可能是共用的同步盘
  const dir = mkdtempSync(join(tmpdir(), 'j-anime-prune-'));
  writeFileSync(join(dir, 'someone-else.json'), '{}');
  for (let i = 0; i < 3; i++) writeFileSync(join(dir, `j-anime-2026-01-0${i + 1}T00-00-00.json`), '{}');
  ok(pruneBackups(dir, 1) === 2, '只清掉多余的 j-anime 备份');
  ok(readdirSync(dir).includes('someone-else.json'), '目录里别人的 json 没被删');
  ok(readdirSync(dir).includes('j-anime-2026-01-03T00-00-00.json'), '留下的是最新那份');
  ok(/j-anime-.*-before-import\.json$/.test(saveBackup(dir, dump, 'before-import')), '带标签的备份文件名');
  rmSync(dir, { recursive: true, force: true });   // 原来不删，每跑一次 e2e 在 %TEMP% 留一个（攒了 155 个）

  db.exec(`DELETE FROM user_entry; DELETE FROM manual_relation; DELETE FROM watch_site;
           UPDATE franchise_member SET user_order=NULL; DELETE FROM setting WHERE key='test_key';`);
}

console.log('\n━━━ 12c. api/entry 校验取值（非法 status 会让记录从番单和统计里消失）━━━');
{
  const a = db.prepare('SELECT id FROM anime WHERE is_stub=0 LIMIT 1').get().id;
  for (const [body, why] of [
    [{ id: a, status: 'finished' }, '不存在的状态'],
    [{ id: a, my_score: 11 }, '评分超过 10'],
    [{ id: a, my_score: 7.45 }, '评分超过一位小数'],
    [{ id: a, my_score: 0.5 }, '评分低于 1'],
    [{ id: a, my_score: '8' }, '字符串评分'],
    [{ id: a, current_episode: -1 }, '负的集数'],
    [{ id: a, current_episode: '3' }, '字符串集数'],
    [{ id: a, op: 'bump', delta: 'abc' }, '字符串 delta（曾被拼成 "0abc"）'],
    [{ id: 'x', status: 'plan' }, '非数字 id']
  ]) {
    const r = await post('/api/entry', body);
    ok(r.status === 400, `拒绝${why}`, `HTTP ${r.status}`);
  }
  ok(!db.prepare('SELECT 1 FROM user_entry WHERE anime_id=?').get(a), '被拒的请求一条都没写进去');
  const okr = await post('/api/entry', { id: a, status: 'plan', my_score: null, my_note: '' });
  ok(okr.status === 200 && okr.data.entry.status === 'plan', '合法的照常写入');
  const dec = await post('/api/entry', { id: a, my_score: 8.4 });
  ok(dec.status === 200 && dec.data.entry.my_score === 8.4, '一位小数的评分照常写入', JSON.stringify(dec.data?.entry?.my_score));
  await post('/api/entry', { id: a, op: 'clear' });
}

console.log('\n━━━ 13. 封面本地缓存（破图根因）━━━');
{
  db.exec('UPDATE anime SET cover_local_path=NULL, cover_dead=0 WHERE id IN (SELECT id FROM anime ORDER BY bgm_collection DESC LIMIT 1)');
  const t = db.prepare('SELECT id, picture FROM anime WHERE picture IS NOT NULL ORDER BY bgm_collection DESC LIMIT 1').get();

  // 这一组要真的去外网抓图。有些网络（公司/酒店）会放过 TCP 握手、
  // 看到域名再掐掉连接 —— 那时候失败是环境问题，不该报成代码坏了。
  // 所以先探一次上游，不通就跳过并说明原因。
  const upstreamUp = await (async () => {
    try {
      const c = AbortSignal.timeout(6000);
      const r = await fetch(t.picture, { method: 'HEAD', signal: c });
      return r.ok || r.status === 405;
    } catch { return false; }
  })();
  if (!upstreamUp) {
    skip(`封面上游不可达（${new URL(t.picture).host}），跳过 3 条联网断言 —— 当前网络在按域名过滤`);
  } else {
  const r1 = await get(`/cover/${t.id}`);
  ok(r1.status === 200, '首次请求能取到封面', `${r1.ms.toFixed(0)}ms`);
  const cached = db.prepare('SELECT cover_local_path FROM anime WHERE id=?').get(t.id).cover_local_path;
  ok(!!cached, '已落盘并记录路径', cached ?? '');
  const r2 = await get(`/cover/${t.id}`);
  ok(r2.status === 200 && r2.ms < r1.ms, '二次请求走本地更快', `${r1.ms.toFixed(0)}ms → ${r2.ms.toFixed(0)}ms`);
  }
  const r3 = await get('/cover/99999999');
  ok(r3.status === 404, '不存在的 id 返回 404');   // 这条不联网，任何网络下都该过
}

console.log('\n━━━ 14. 放送表 / 季度浏览 ━━━');
{
  // 默认口径：不带参数进来就是「本季全部」—— 番单空的时候「我在追的」是空屏
  const def = await get('/schedule');
  ok(def.status === 200 && noErr(def.html), '放送表默认页 200');
  ok(cards(def.html) > 0, '默认就有内容（说明默认是本季全部）', `${cards(def.html)} 部`);
  ok(chipOn(def.html, '本季全部'), '默认高亮「本季全部」');
  ok(!chipOn(def.html, '我在追的'), '默认不高亮「我在追的」');
  ok(def.html.indexOf('本季全部') < def.html.indexOf('我在追的'), '「本季全部」排在「我在追的」前面');

  const mine = await get('/schedule?scope=mine');
  ok(mine.status === 200 && noErr(mine.html), '放送表（我在追的）200');
  ok(chipOn(mine.html, '我在追的') && !chipOn(mine.html, '本季全部'), '显式 scope=mine 时高亮切过去');
  ok(def.html.includes('我在追的') && def.html.includes('本季全部'), '两个 tab 都在');

  // 日历条（2026-10-21 第 8 条压成一行 / 两行）：七天 + 全周，恰好一个选中；手机上日期不印，靠 aria-label 读出
  const strip = def.html.match(/<nav aria-label="星期"[\s\S]*?<\/nav>/)?.[0] ?? '';
  const dayLabels = [...strip.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]).filter((l) => l !== '星期');
  ok(dayLabels.length === 7 && dayLabels.every((l) => /周[一二三四五六日] \d{1,2}\.\d{1,2} · /.test(l)),
     '日历条七格的 aria-label 都带星期 + 日期 + 部数', dayLabels.join(' | '));
  ok((strip.match(/aria-current="true"/g) ?? []).length === 1 && dayLabels.filter((l) => l.startsWith('今天 · ')).length === 1,
     '日历条恰好一格选中、一格标「今天」');
  const all = await get('/schedule?wd=all');
  const allStrip = all.html.match(/<nav aria-label="星期"[\s\S]*?<\/nav>/)?.[0] ?? '';
  ok(/aria-current="true"[^>]*>全周</.test(allStrip.replace(/<!--[^>]*-->/g, '')), 'wd=all 时选中的是「全周」');

  const se = await get('/seasons?season=all');   // 默认已改成只显示当前季，见 14j
  ok(se.status === 200 && noErr(se.html), '季度浏览 200');
  // 2026-10 UI 大改：分节标题只写「冬季」（年份在 hero 里），改按 data-season 数块
  ok(['WINTER', 'SPRING', 'SUMMER', 'FALL'].every((x) => se.html.includes(`data-season="${x}"`)), 'season=all 时四个季度都渲染');
  ok(cards(se.html) > 0, '季度浏览有内容', `${cards(se.html)} 部`);
  const se2 = await get('/seasons?year=2015&type=MOVIE');
  ok(noErr(se2.html), '换年份+类型不崩');

  // 门槛「全部」必须真的是全部：非重复条目 source_count 最小是 1，
  // 之前「全部」写成 >=2，实测 2026 夏季 125 部里藏了 39 部只被一家站收录的。
  const { seasonGrid } = await import('../src/lib/server/queries.js');
  const n = (min) => Object.values(seasonGrid(2026, { types: ['TV'], minSources: min }))
    .reduce((t, list) => t + list.length, 0);
  ok(n(1) >= n(2) && n(2) >= n(4) && n(4) >= n(8), '门槛越高结果越少',
     `1→${n(1)} 2→${n(2)} 4→${n(4)} 8→${n(8)}`);
  ok(n(1) === n(0), '「全部」(>=1) 等于不设门槛', `${n(1)} vs ${n(0)}`);
  const opts = readFileSync2('src/routes/seasons/+page.svelte', 'utf8');
  ok(/MIN_OPTS = \[\[1, '全部'\]/.test(opts), '门槛的「全部」档位是 1 而不是 2');
}

console.log('\n━━━ 14b. 侧栏首屏状态（不能闪一下）━━━');
{
  // 之前状态存 localStorage，SSR 读不到 → 首屏按收起渲染，JS 跑起来再展开，
  // 每次刷新都能看见「收起 → 弹出」那一下。改存 cookie 后服务端就知道该渲染成什么。
  const raw = await fetch(`${BASE}/`);
  ok(drawerOpen(await raw.text()), '无 cookie 时首屏就是展开的');

  const withCookie = async (v) => {
    const r = await fetch(`${BASE}/`, { headers: { Cookie: `j_drawer=${v}` } });
    return drawerOpen(await r.text());
  };
  ok(!(await withCookie('0')), 'cookie=0 首屏就是收起的');
  ok(await withCookie('1'), 'cookie=1 首屏就是展开的');

  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/routes/+layout.svelte', 'utf8');
  ok(!src.includes('localStorage'), '侧栏状态不再用 localStorage（那是首屏闪跳的根因）');
}

console.log('\n━━━ 15. 统计 / 时间线 ━━━');
{
  const { setEntry, stats, timeline } = await import('../src/lib/server/queries.js');
  const ids = db.prepare(`SELECT id FROM anime WHERE is_stub=0 AND year>=2015
    ORDER BY bgm_collection DESC LIMIT 4`).all().map((r) => r.id);
  ids.forEach((id, i) => setEntry(id, { status: 'completed', my_score: 7 + i % 4 }));
  const r = await get('/stats');
  ok(r.status === 200 && noErr(r.html), '统计页 200');
  for (const t of ['番单总数', '小时', '我的平均分',   // 2026-10 首屏改成 hero：主数字是「N 小时」 '作品年份分布',
                   '题材分布', '评分分布', '时间线'])
    ok(r.html.includes(t), `统计页有「${t}」`);
  ok(r.html.includes('记录活动'), '有活动热力图');
  const tl = timeline({ limit: 50 });
  ok(tl.days.length > 0, '时间线有数据（按天分组）', `${tl.days.length} 天 / ${tl.total} 条`);
  // 分页：每页 10 条，两页内容不能重复
  const p1 = timeline({ limit: 10, offset: 0 }).days.flatMap((d) => d.items.map((x) => x.id));
  const p2 = timeline({ limit: 10, offset: 10 }).days.flatMap((d) => d.items.map((x) => x.id));
  ok(p1.length <= 10, '第一页最多 10 条', `${p1.length} 条`);
  ok(!p1.some((x) => p2.includes(x)), '第二页和第一页不重复');
  const st = await get('/stats');
  ok(st.html.includes('共 ') || tl.total === 0, '时间线标题显示总条数');
  if (tl.total > 10) {
    ok(st.html.includes('下一页'), '有下一页按钮');
    const st2 = await get('/stats?tl=2');
    ok(st2.status === 200 && noErr(st2.html), '?tl=2 能打开');
    ok(st2.html.includes('上一页'), '第二页有上一页按钮');
    // 越界页码要夹到最后一页，不能显示「99999 / 13」和一片空白
    const far = await get('/stats?tl=99999');
    ok(far.status === 200 && !/99999\s*\/\s*\d/.test(far.html), '越界页码被夹到范围内');
    ok(/href="\/anime\/\d+"/.test(far.html), '夹紧后仍有内容');
  }
  const src = readFileSync2('src/routes/catalog/+page.svelte', 'utf8');
  ok(src.includes('Pager'), '目录页也用共用的 Pager（原来内联写了一份）');
  // 时间线在页面中段，翻页回顶部等于把人甩走。
  // 断言看源码而不是 HTML —— 日志不满两页时根本不渲染分页条
  // 2026-10 UI 大改：时间线拆成 stats/Timeline.svelte
  const ssrc = readFileSync2('src/routes/stats/Timeline.svelte', 'utf8');
  ok(/<Pager[^>]*noScroll/.test(ssrc), '时间线分页传了 noScroll（不回顶部）');
  ok(!/<Pager[^>]*noScroll/.test(src), '目录页不传 noScroll（翻页仍回顶部，要看新的第一行）');
  ok(readFileSync2('src/lib/ui/Pager.svelte', 'utf8').includes('data-sveltekit-noscroll'),
     'Pager 用的是 SvelteKit 的 noscroll 机制');
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');
}

console.log('\n━━━ 15b. 统计口径一致性 ━━━');
{
  const { setEntry, stats } = await import('../src/lib/server/queries.js');
  // 找 3 部年份互不相同、且有制作公司和标签的番，分别标成 看完 / 弃番 / 想看
  const cand = db.prepare(`SELECT a.id, a.year, a.episodes FROM anime a
    WHERE a.is_stub=0 AND a.year IS NOT NULL AND a.episodes >= 12
      AND EXISTS (SELECT 1 FROM anime_studio s WHERE s.anime_id=a.id AND s.role='studio'
                  AND s.studio_norm IS NOT NULL AND s.studio_norm != '')
      AND EXISTS (SELECT 1 FROM anime_tag t WHERE t.anime_id=a.id)
    ORDER BY a.bgm_collection DESC LIMIT 60`).all();
  const pick = [];
  for (const c of cand) if (!pick.some((x) => x.year === c.year)) pick.push(c);
  const [done, drop, plan] = pick;
  ok(!!plan, '测试样本齐（3 部不同年份）');

  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');
  setEntry(done.id, { status: 'completed' });
  setEntry(drop.id, { status: 'dropped', current_episode: 3 });
  setEntry(plan.id, { status: 'plan' });
  const st = stats();

  ok(st.total === 3, '番单总数含想看', `${st.total}`);
  ok(st.watchedCount === 2, '看过数不含想看', `${st.watchedCount}`);
  // 核心回归：分布类图表必须用同一套口径 —— 弃番要么处处都算，要么处处都不算
  const years = st.byYear.map((x) => x.year);
  ok(years.includes(done.year) && years.includes(drop.year) && !years.includes(plan.year),
     '年份分布含弃番、不含想看', years.join(','));
  const inList = (id) => db.prepare(`SELECT s.studio_norm k FROM anime_studio s
    WHERE s.anime_id=? AND s.role='studio' AND s.studio_norm != ''`).all(id).map((x) => x.k);
  const keys = st.studios.map((x) => x.studio);
  ok(inList(drop.id).some((k) => keys.includes(k)), '制作公司含弃番（和年份图同口径）');
  ok(!inList(plan.id).some((k) => keys.includes(k) && !inList(done.id).concat(inList(drop.id)).includes(k)),
     '制作公司不含只属于想看的公司');
  ok(st.byType.reduce((n, x) => n + x.c, 0) === 2, '类型构成也用同口径', `${st.byType.reduce((n, x) => n + x.c, 0)}`);

  // 集数：看完没填进度按总集数补；弃番填了 3 就算 3；想看不算
  ok(st.episodes === done.episodes + 3, '集数口径正确', `${st.episodes} = ${done.episodes}+3`);

  // 「在看」没填进度不能按总集数算 —— 否则一部 24 集的在看会被当成全看完
  setEntry(drop.id, { status: 'watching', current_episode: null });
  ok(stats().episodes === done.episodes, '在看未填进度算 0 集', `${stats().episodes}`);

  // 制作公司展示名：首字母大写，链接值是 studio_norm（目录页筛的就是这个字段）
  const s0 = stats().studios[0];
  ok(/^[A-Z0-9]/.test(s0.label), '公司名首字母大写', s0.label);
  ok(s0.studio === s0.studio.toLowerCase(), '链接值用 studio_norm（小写）', s0.studio);
  const { listAnime } = await import('../src/lib/server/queries.js');
  ok(listAnime({ studio: s0.studio, types: null }).total > 0, '公司链接筛得到结果');

  // 题材必须按番剧去重，不能拿各标签计数取 max
  const gmod = await import('../src/lib/genres.js');
  const g = stats().genres[0];
  if (g) {
    const tags = gmod.GENRE_MAP[g[0]];
    const real = db.prepare(`SELECT count(DISTINCT ue.anime_id) c FROM user_entry ue
      JOIN anime_tag t ON t.anime_id=ue.anime_id
      WHERE ue.status <> 'plan' AND t.tag IN (${tags.map(() => '?').join(',')})`).get(...tags).c;
    ok(g[1] === real, '题材计数=去重后的番剧数', `${g[0]} ${g[1]} vs ${real}`);
  }
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');
}

console.log('\n━━━ 15c. 观看日志的动作类型 ━━━');
{
  const { setEntry, bumpEpisode, clearEntry } = await import('../src/lib/server/queries.js');
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');
  const id = db.prepare(`SELECT id FROM anime WHERE is_stub=0 AND episodes >= 12
    ORDER BY bgm_collection DESC LIMIT 1`).get().id;
  const acts = () => db.prepare('SELECT action, episode FROM watch_log ORDER BY id').all();

  setEntry(id, { status: 'watching' });
  ok(acts().at(-1).action === 'status_change', '新建记录记 status_change');
  setEntry(id, { current_episode: 5 });
  ok(acts().at(-1).action === 'watch_ep' && acts().at(-1).episode === 5,
     '只改进度记 watch_ep 并带集数', JSON.stringify(acts().at(-1)));
  const n = acts().length;
  setEntry(id, { current_episode: 5 });
  ok(acts().length === n, '值没变不写日志（时间线不再被重复项灌满）');
  setEntry(id, { status: 'completed' });
  const last = acts().at(-1);
  ok(last.action === 'status_change' && last.episode === null,
     '改状态记 status_change 且不记自动补的集数', JSON.stringify(last));
  bumpEpisode(id, -1);
  ok(acts().at(-1).action === 'watch_ep', '±1 按钮记 watch_ep');
  clearEntry(id);
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');
}

console.log('\n━━━ 14k. 我的默认筛选 + 状态标签对比度 ━━━');
{
  // 「设为默认」并进了「我的筛选」：默认是某套保存组合的属性（存引用，不是快照）
  const { addFilter, delFilter, listFilters, setDefaultFilter, getDefaultFilter } =
    await import('../src/lib/server/queries.js');
  db.exec('DELETE FROM saved_filter');

  const bare = await fetch(`${BASE}/catalog`, { redirect: 'manual' });
  ok(bare.status === 200, '一套都没标默认时，目录直接 200（用系统默认，不重定向）', String(bare.status));

  addFilter('测试组合', 'type=TV&from=2020&to=2020');
  const f1 = listFilters()[0];
  ok(!getDefaultFilter(), '刚保存的组合不会自动变成默认');
  const stillBare = await fetch(`${BASE}/catalog`, { redirect: 'manual' });
  ok(stillBare.status === 200, '只是保存、没标默认 → 目录不受影响', String(stillBare.status));

  setDefaultFilter(f1.id);
  const hit = await fetch(`${BASE}/catalog`, { redirect: 'manual' });
  ok(hit.status === 302, '标了默认后无参数进入会重定向', String(hit.status));
  ok((hit.headers.get('location') || '').includes('from=2020'), '重定向到那套组合',
     hit.headers.get('location'));

  // 存引用不是快照：改那套组合，默认跟着变
  db.prepare('UPDATE saved_filter SET filter_json = ? WHERE id = ?').run('type=OVA&from=2011&to=2011', f1.id);
  const moved = await fetch(`${BASE}/catalog`, { redirect: 'manual' });
  ok((moved.headers.get('location') || '').includes('from=2011'), '改组合后默认跟着变（存的是引用）',
     moved.headers.get('location'));

  // 「重置」指向无参数 URL → 又落到默认上；?raw=1 回系统默认
  const raw = await fetch(`${BASE}/catalog?raw=1`, { redirect: 'manual' });
  ok(raw.status === 200, 'raw=1 回到系统默认（不重定向）', String(raw.status));

  // 删掉默认那套 → 自动回落到系统默认，不能指向一个不存在的 id
  delFilter(f1.id);
  ok(!getDefaultFilter(), '删掉默认那套后自动回落到系统默认');
  ok((await fetch(`${BASE}/catalog`, { redirect: 'manual' })).status === 200,
     '回落后目录恢复正常');

  // 主人实测存过「2027夏 + 更新中·已完结」，而 2027 全年都是未上映 → 必然空屏
  addFilter('空结果的默认', 'from=2027&to=2027&season=SUMMER&status=ONGOING&status=FINISHED');
  setDefaultFilter(listFilters()[0].id);
  const dead = await get('/catalog');
  // 2026-10 UI 大改：空屏改用 EmptyState（标题即状态，不带说明句），出口就是「回到系统默认」那枚胶囊
  ok(dead.html.includes('没有符合条件的番剧'), '空结果的默认会得到空屏');
  ok(dead.html.includes('回到系统默认'), '空屏给了「回到系统默认」入口');
  const s2 = await get('/catalog?q=' + encodeURIComponent('刀剑神域'));
  ok(cards(s2.html) > 0, '这套默认下搜索仍有结果', `${cards(s2.html)} 条`);

  // 切默认后当前页面必须跟着变。
  // ⚠️ 之前只验了后端和重定向，没验交互 —— 主人点「系统默认」的 ★，
  // ★ 移了但内容没变，因为地址栏还带着旧筛选参数，invalidateAll 只是
  // 重渲染同一个 URL。修法是切完跳到基础 URL。
  addFilter('切换用', 'from=2011&to=2011');
  const swId = listFilters()[0].id;
  setDefaultFilter(swId);
  const onA = await fetch(`${BASE}/catalog`, { redirect: 'manual' });
  ok((onA.headers.get('location') || '').includes('from=2011'), '默认在 A 时重定向到 A');
  setDefaultFilter(null);
  const onSys = await fetch(`${BASE}/catalog`, { redirect: 'manual' });
  ok(onSys.status === 200, '清掉默认后回系统默认（不重定向）', String(onSys.status));
  // 两页都是满屏 60 张，所以比卡片数分不出来 —— 比首屏的 id 集合
  const idsOf = (html) => [...new Set((html.match(/href="\/anime\/(\d+)"/g) || []))].join();
  const sysIds = idsOf((await get('/catalog')).html);
  const aIds = idsOf((await get('/catalog?from=2011&to=2011')).html);
  ok(sysIds !== aIds, '系统默认和那套组合看到的内容确实不同');
  delFilter(swId);

  // 界面：列表第一项是内置的「系统默认」，每套有 ★ 切换
  const sf = readFileSync2('src/lib/ui/SaveFilter.svelte', 'utf8');
  ok(sf.includes('系统默认'), '「我的筛选」列表第一项是系统默认');
  ok(sf.includes("op: 'default'"), '列表里能直接切换默认');
  ok(sf.includes('summarize'), '每套显示条件摘要（不然存几套就分不清）');
  ok(/goto\('\/catalog'/.test(sf), '切换默认后跳到基础 URL（否则页面不跟着变）');
  ok(/h-8 w-8/.test(sf), '★ / ✕ 是 32px 的方块按钮（原来太小按不准）');
  ok(!sf.includes('先选一些筛选条件') && !sf.includes('点名字应用'),
     '面板里没有那两句说明');
  const csv = readFileSync2('src/routes/catalog/+page.svelte', 'utf8');
  ok(!csv.includes('PageDefault'), '目录页不再有独立的「默认」入口（已并入我的筛选）');

  // 季度浏览的「默认」已删 —— 它的天然默认「当前年+当前季」会自己跟着时间走，
  // 存快照反而把年份冻住（在 2026夏 设了默认，2027 年点进去还是 2026夏）
  const ssv = readFileSync2('src/routes/seasons/+page.svelte', 'utf8');
  ok(!ssv.includes('PageDefault') && !/label="默认"/.test(ssv),
     '季度浏览没有「默认」胶囊');
  const now = new Date();
  const curY = now.getFullYear();
  const se = await fetch(`${BASE}/seasons`, { redirect: 'manual' });
  ok(se.status === 200, '季度浏览不会被任何默认重定向', String(se.status));
  ok((await get('/seasons')).html.includes(String(curY)),
     '季度浏览默认落在当前年（会自己跟着时间走）');

  db.exec('DELETE FROM saved_filter');

  // 状态标签：亮色模式下曾是 text-emerald-300 on bg-emerald-500/20，对比度 1.19:1
  const cst = readFileSync2('src/lib/constants.js', 'utf8');
  ok(cst.includes('STATUS_TONE') && cst.includes('STATUS_BADGE'),
     '状态配色抽到了 constants（原来两处各写一份）');
  for (const f of ['src/lib/PosterCard.svelte', 'src/routes/anime/[id]/+page.svelte']) {
    const src = readFileSync2(f, 'utf8');
    // 详情页 2026-10 起只有「已完结 / 连载中」是胶囊，用 constants 的 STATUS_PILL（淡底 + accent-ink / live-ink）
    ok(/STATUS_(?:BADGE|TONE|PILL)/.test(src), `${f} 用共用的配色`);
    ok(!/text-emerald-300|bg-emerald-500\/20/.test(src), `${f} 不再用低对比度那套`);
  }

  // 封面角标压在任意封面图上，底色必须是固定色。用主题色 + 写死的字色就会翻车：
  // 泡面角标原来是 bg-warm/85 + text-black，而 warm 在亮色主题是深棕 #8a5200。
  const { STATUS_TONE, STATUS_BADGE } = await import('../src/lib/constants.js');
  const tones = Object.values(STATUS_TONE);
  ok(tones.every((t) => /^bg-[a-z]+-\d{3} text-white$/.test(t)),
     '详情页状态标签是「实色底 + 白字」', tones.join(' / '));
  ok(new Set(tones).size === 3, '四种状态用三种颜色（已完结和未知同色）', String(new Set(tones).size));
  // 封面角标：底色一律和「TV」那个一致，彩色只出现在文字上 —— 彩色底调半透明会翻车
  // （sky-700/70 落在浅色封面上配白字只有 3.3:1），不透明又和别的角标深浅不一。
  const badges = Object.values(STATUS_BADGE);
  ok(badges.every((t) => /^bg-(?:[a-z]+-9\d0|\[#[0-9a-f]{6}\])\/70 text-white$/.test(t)),
     '封面状态角标是「深色底 /70 + 白字」', badges.join(' / '));
  // 2026-10 UI 大改：「连载中」改成封面右上角的绿色小圆点，不再是文字角标 → 剩「未上映」「已完结 / 未知」两种颜色
  ok(!('ONGOING' in STATUS_BADGE) && new Set(badges).size === 2, '封面文字角标两种颜色（连载中是小圆点）', String(new Set(badges).size));
  ok(/bg-live/.test(readFileSync2('src/lib/PosterCard.svelte', 'utf8')), '连载中画成 bg-live 小圆点');
  // 先剥注释：解释这条规则的注释本身就写着 bg-warm + text-black，会把自己测挂
  const card = readFileSync2('src/lib/PosterCard.svelte', 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const themed = card.match(/bg-(?:warm|accent)[^"']*\s+(?:[^"']*\s)?text-(?:black|white)/g) ?? [];
  ok(themed.length === 0, '封面角标不拿主题色配写死的黑白字', themed.join(' / '));
  // 透明度要一致，否则同一张封面上几个角标深浅不齐（评分那个原来是 /75，泡面是 /85）
  // 排除 bg-accent：左下「我的状态」用的是主题色，中间调的颜色降到 /70
  // 之后会被封面带着走（亮色主题 + 浅封面只有 2.3:1），只能维持接近不透明。
  const alphas = new Set([...card.matchAll(/bg-(?!accent)[a-z]+(?:-\d{3})?\/(\d+)/g)].map((m) => m[1]));
  const badgeAlphas = new Set(badges.map((t) => t.match(/\/(\d+)/)[1]));
  ok(alphas.size === 1 && alphas.has('70'), '封面四角的角标同一个透明度', [...alphas].join(' / '));
  ok(badgeAlphas.size === 1 && badgeAlphas.has('70'), '状态角标也是同一个透明度',
     [...badgeAlphas].join(' / '));
}

console.log('\n━━━ 14n. 把「没看过」放回队列 ━━━');
{
  const { triageQueue, setTriage, nextBatchId, triageStats, notSeenCount, resetNotSeen } =
    await import('../src/lib/server/queries.js');
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log; DELETE FROM triage;');

  // 一屏 24 部，勾 1 部看过、其余记为没看过 —— 和用户实际操作一致
  const q = triageQueue({ limit: 24 });
  const bid = nextBatchId();
  q.forEach((a, i) => setTriage(a.id, i === 0 ? 'seen' : 'not_seen', bid));
  const years = [...new Set(q.map((a) => a.year))];

  ok(notSeenCount() === q.length - 1, '数得出有多少部记为没看过',
     `${notSeenCount()} / ${q.length - 1}`);
  ok(triageStats().notSeen === q.length - 1, 'stats 里带这个数字（按钮上要显示）');

  // 判定过的默认不再出现 —— 这正是「漏标了就再也见不到」的成因
  const after = triageQueue({ limit: 24 });
  ok(!after.some((a) => q.some((x) => x.id === a.id)), '判定过的整批都离开了队列');

  const n = resetNotSeen();
  ok(n === q.length - 1, '放回的部数 = 记为没看过的部数', String(n));
  ok(db.prepare("SELECT count(*) c FROM triage WHERE verdict='seen'").get().c === 1,
     '「看过」的判定一条没动');
  ok(db.prepare('SELECT count(*) c FROM user_entry WHERE is_vague=1').get().c === 1,
     '「看过」那部的番单记录也在');
  const back = triageQueue({ limit: 24 });
  ok(back.some((a) => a.id === q[1].id), '记为没看过的回到了队列');
  ok(!back.some((a) => a.id === q[0].id), '标了看过的不会回来（它已经在番单里）');
  ok(notSeenCount() === 0, '放回后没有残留');

  // 按年份限定：只放回那一年的
  const bid2 = nextBatchId();
  q.forEach((a, i) => { if (i > 0) setTriage(a.id, 'not_seen', bid2); });
  const y = years[0];
  const inYear = q.filter((a, i) => i > 0 && a.year === y).length;
  ok(notSeenCount({ yearMin: y, yearMax: y }) === inYear, `${y} 年有 ${inYear} 部记为没看过`);
  const n2 = resetNotSeen({ yearMin: y, yearMax: y });
  ok(n2 === inYear, '按年份重置只放回那一年的', `${n2} / ${inYear}`);
  ok(notSeenCount() === q.length - 1 - inYear, '其他年份的判定还留着',
     `${notSeenCount()} / ${q.length - 1 - inYear}`);

  db.exec('DELETE FROM user_entry; DELETE FROM triage;');

  // 「放回队列」必须一直在页面上 —— 写成「有记录才显示」时，空库下这个功能找不到
  const tp = await get('/triage');
  ok(tp.html.includes('重置队列'), '没有记录时「重置队列」也在（只是禁用）');
  ok(/disabled/.test(tp.html.slice(tp.html.indexOf('重置队列') - 400, tp.html.indexOf('重置队列'))),
     '没有记录时它是禁用的');
  // 年份改用目录页那个折叠胶囊 —— 原来铺一长排 13+ 个胶囊，头部太挤
  ok(tp.html.includes('>年份<'), '年份是折叠胶囊（和目录页同一个组件）');
  ok(!tp.html.includes('数字为待判定部数'), '不再有铺开的一长排年份');
  // 重置按钮的样式抄了五份（目录/番单/季度浏览/排行榜各一份 9 行标记，
  // 快速标记那份还写成了 rounded-full 的椭圆，和别的方角对不上）
  const RESET_PAGES = ['catalog', 'mine', 'seasons', 'ranking', 'triage'];
  const notShared = RESET_PAGES
    .filter((p) => !readFileSync2(`src/routes/${p}/+page.svelte`, 'utf8').includes('<ResetButton'));
  ok(notShared.length === 0, '五个页面的重置按钮用同一个组件', notShared.join(', '));
  const handwritten = RESET_PAGES
    .filter((p) => /hover:border-red-500\/60/.test(readFileSync2(`src/routes/${p}/+page.svelte`, 'utf8')));
  ok(handwritten.length === 0, '没有页面再手写那套样式', handwritten.join(', '));
  // 剥注释：组件的注释里就写着「原来是 rounded-full 的椭圆」，会把自己测挂
  const rb = readFileSync2('src/lib/ui/ResetButton.svelte', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  // 2026-10-21：尺寸统一抽到 ui/bar.js 的 BAR_BOX（胶囊 / 搜索框 / 重置同高同圆角），圆角从 lg 换成 xl
  const fp = readFileSync2('src/lib/ui/bar.js', 'utf8');
  const barBox = fp.match(/BAR_BOX = `([^`]*)`/)?.[1] ?? '';
  ok(rb.includes('BAR_BOX') && /rounded-xl/.test(barBox) && !/rounded-full/.test(rb + barBox),
     '重置按钮是方角（和筛选胶囊同一份 BAR_BOX）而不是椭圆');
  // 主人 2026-10-21 第 5 条：筛选栏一排控件同高 —— 胶囊、搜索框、搜索键、我的筛选、重置、开关都取 BAR_H / BAR_BOX
  const usesBar = ['FilterPill', 'SearchBox', 'SaveFilter', 'ResetButton', 'Toggle']
    .filter((c) => !/\{BAR_(H|BOX)\}/.test(readFileSync2(`src/lib/ui/${c}.svelte`, 'utf8')));
  ok(usesBar.length === 0, '筛选栏控件都用同一份高度', usesBar.join(', '));
  ok(!/\bh-(9|11)\b/.test(readFileSync2('src/lib/ui/SearchBox.svelte', 'utf8')), '搜索框不再自己写死 44px');

  // 封面高低不齐的根因：网格列 1fr 的最小尺寸是 min-content，而 <img> 的 min-content
  // 是原图宽度（库里混着 225 和 350 两种），撑宽的那列 aspect-2/3 算出来就更高
  const tsrc = readFileSync2('src/routes/triage/+page.svelte', 'utf8');
  ok(/class="group flex min-w-0/.test(tsrc), '快速标记的格子有 min-w-0');

  /**
   * 本地 state 同步 data 时必须认准来源，不能裸写 `$effect(() => { queue = data.queue })`。
   * run() 里的 invalidate('app:stats') 会重跑根布局的 load，本页 load 没重跑，
   * 但合并出来的 data 对象是新的 —— 裸 effect 会把刚从 API 拿到的新队列
   * 覆盖回 page load 那份旧队列。实测表现：点「下一批」侧栏数字变了
   * （4645→4621），卡片和「已判定 216」一动不动，刷新才对。
   * 客户端响应式这类 bug e2e 打不到（HTTP 层看不见），只能在源码层守。
   */
  ok(/syncedFrom/.test(tsrc) && /if \(data\.queue === syncedFrom\) return;/.test(tsrc),
     '本地队列同步认准 page load 的数组引用（父层数据变化不覆盖本地状态）');
  ok(!/line-clamp/.test(tsrc), '快速标记的标题不截断（截了没法判断看过没看过）');
  const csrc = readFileSync2('src/lib/PosterCard.svelte', 'utf8');
  ok(/class="group block min-w-0[\s"]/.test(csrc), '卡片组件也有 min-w-0');

  /**
   * 角标不能互相挡（旧卡片的状态带压在封面底部，把左下「N集」和右下评分整条挡掉 ——
   * 主人截图实测）。海报卡片：集数挪到封面下面的元信息行，封面底部只有「我的状态」（左）和分数（右）。
   */
  ok(!/absolute left-1(?:\.5)? bottom-1/.test(csrc), '封面左下不再单独放集数角标');
  ok(/\{a\.episodes\} 集/.test(csrc), '集数在封面下面的元信息行');
  ok(/justify-between[\s\S]{0,400}\{#if mine\}[\s\S]{0,900}scoreText/.test(csrc), '我的状态和分数在底部两端，不叠在一起');
  ok(!(await import('node:fs')).existsSync('src/lib/AnimeCard.svelte'), '旧卡片组件已删（全站统一海报卡片）');

  db.exec('DELETE FROM user_entry; DELETE FROM watch_log; DELETE FROM triage;');
}

console.log('\n━━━ 14k2. 每个喂封面卡片的查询都带齐卡片要的字段 ━━━');
{
  /**
   * 统计页「评分最高」的查询漏了 bgm_score，海报卡片上一个分数都不显示（主人 2026-10-18 截图）。
   * 卡片拿不到字段不会报错，只是悄悄少显示 —— 所以在这里把每个数据源过一遍。
   * 先造一条番单记录：番单 / 首页「最近看的」/ 统计都要有数据才测得到
   */
  const q = await import('../src/lib/server/queries.js');
  const pick = db.prepare('SELECT id FROM anime WHERE is_stub=0 AND bgm_score IS NOT NULL ORDER BY bgm_votes DESC LIMIT 1').get().id;
  db.prepare("INSERT OR REPLACE INTO user_entry (anime_id,status,current_episode,my_score) VALUES (?, 'completed', 1, 9)").run(pick);
  db.prepare("INSERT INTO watch_log (anime_id,episode,action) VALUES (?, 1, 'watch_ep')").run(pick);
  const NEED = ['id', 'title', 'title_cn', 'type', 'year', 'episodes', 'is_short', 'status_eff', 'picture', 'thumbnail',
    'cover_dead', 'bgm_score', 'bgm_votes', 'my_status', 'current_episode'];
  const sources = {
    '目录': q.listAnime({}, { limit: 2 }).rows,
    '番单': q.listAnime({ watch: 'active' }, { limit: 2 }).rows,
    '首页推荐': q.recommend(2),
    '首页最近看的': q.recentlySeen(2),
    '季度浏览': Object.values(q.seasonGrid(new Date().getFullYear())).flat().slice(0, 2),
    '统计评分最高': q.stats().top
  };
  for (const [k, rows] of Object.entries(sources)) {
    const miss = rows.length ? NEED.filter((f) => !(f in rows[0])) : ['（没有数据，测不到）'];
    ok(miss.length === 0, `${k} 的卡片字段齐全`, miss.join(', '));
  }
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');
}

console.log('\n━━━ 14l. 撤销上一批：整批回队列，提示要说清 ━━━');
{
  const { triageQueue, setTriage, nextBatchId, undoLastBatch } = await import('../src/lib/server/queries.js');
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log; DELETE FROM triage;');

  const q = triageQueue({ limit: 24 });
  ok(q.length > 1, '取到一批队列', `${q.length} 部`);
  const bid = nextBatchId();
  // 只勾第一部为「看过」，其余记为「没看过」—— 用户实际的操作方式
  q.forEach((a, i) => setTriage(a.id, i === 0 ? 'seen' : 'not_seen', bid));

  ok(db.prepare('SELECT count(*) c FROM triage').get().c === q.length, '整批都落了判定');
  ok(db.prepare('SELECT count(*) c FROM user_entry WHERE is_vague=1').get().c === 1,
     '只有勾过的那部进了番单');

  const r = undoLastBatch();
  ok(r.undone === q.length, `撤销回报的是整批部数（${q.length}）而不是勾过的部数`, String(r.undone));
  ok(r.seen === 1, '回报里单独带 seen，前端才能把提示写清楚', String(r.seen));
  ok(db.prepare('SELECT count(*) c FROM triage').get().c === 0, '判定全清了');
  ok(db.prepare('SELECT count(*) c FROM user_entry WHERE is_vague=1').get().c === 0,
     '勾过的那部的番单记录也一起删了');
  const q2 = triageQueue({ limit: 24 });
  ok(q2.some((a) => a.id === q[0].id), '勾过的那部回到了队列');

  const src = readFileSync2('src/routes/triage/+page.svelte', 'utf8');
  ok(src.includes('一批 = 一整屏'), '规则里说明了「一批 = 一整屏」');
  ok(src.includes('含标为看过的'), '提示区分了整批数与勾过的数');
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log; DELETE FROM triage;');
}

console.log('\n━━━ 14m. 制作公司筛选：点得动，名字是正常大小写 ━━━');
{
  const { facets, listAnime } = await import('../src/lib/server/queries.js');
  const st = facets().studios;
  ok(st.length > 20, 'facet 里有制作公司', `${st.length} 家`);
  ok(st.every((s) => s.studio === s.studio.toLowerCase()), '链接值是 studio_norm（小写）');
  ok(st.filter((s) => /^[A-Z]/.test(s.label)).length > st.length * 0.9,
     '展示名首字母大写（原来整列是 toei animation 这种小写）',
     st.slice(0, 3).map((s) => s.label).join(' / '));
  ok(!st.some((s) => /co\.,?\s*ltd|inc\./i.test(s.label)), '展示名不带公司后缀');

  // 点了要真能筛到
  const one = st[0];
  ok(listAnime({ studio: one.studio, types: null }).total > 0,
     `按「${one.label}」能筛到结果`, one.studio);

  // ⚠️ 起因：整列写成 <button href={...}>，<button> 不认 href，点了没反应
  const src = readFileSync2('src/routes/catalog/+page.svelte', 'utf8');
  const seg = src.slice(src.indexOf('label="制作公司"'), src.indexOf('label="我的"'));
  ok(!/<button[^>]*href=/.test(seg), '公司列表用 <a href> 而不是 <button href>');
  ok(/<a href=\{to\(\{ studio:/.test(seg), '每一家都是可导航的链接');

  const page = await get('/catalog?raw=1');
  ok(page.html.includes(st[0].label), '页面上渲染的是大小写正常的名字', st[0].label);
}

console.log('\n━━━ 14w. 侧栏数字要跟着操作走 ━━━');
{
  /**
   * 实测：快速标记点「下一批」后，页头写着「待判定 480」而侧栏还挂着 504。
   * 侧栏和页头的数字都在根布局的 load 里算，而「下一批」是 API 调用、不导航，
   * 布局的 load 不会自动重跑。
   * 用 depends('app:stats') + invalidate('app:stats') 精准重跑那一个 load ——
   * 不用 invalidateAll()，否则会把刚从接口拿到的新队列一起重置掉。
   */
  const lay = readFileSync2('src/routes/+layout.server.js', 'utf8');
  ok(/depends\('app:stats'\)/.test(lay), '布局 load 声明了 app:stats 依赖');
  const tp = readFileSync2('src/routes/triage/+page.svelte', 'utf8');
  ok(/invalidate\('app:stats'\)/.test(tp), '快速标记提交后让它重跑');
  ok(!/invalidateAll\(\)/.test(tp), '不用 invalidateAll（会冲掉接口返回的新队列）');

  // 数字本身的口径：侧栏的「待标记」= 快速标记页的「待判定」
  const { triageStats } = await import('../src/lib/server/queries.js');
  const before = triageStats().remaining;
  const q = (await import('../src/lib/server/queries.js')).triageQueue({ limit: 3 });
  const { setTriage, nextBatchId } = await import('../src/lib/server/queries.js');
  const bid = nextBatchId();
  for (const a of q) setTriage(a.id, 'not_seen', bid);
  ok(triageStats().remaining === before - q.length, '判定 3 部后待判定少 3',
     `${before} → ${triageStats().remaining}`);
  const { undoLastBatch } = await import('../src/lib/server/queries.js');
  undoLastBatch();
  ok(triageStats().remaining === before, '撤销后回到原值');
}

console.log('\n━━━ 14v. 集数：AOD 写 0 时用 bgm 的补上 ━━━');
{
  /**
   * 实测：「相反的你和我」2026 夏季那条 AOD 给的 episodes=0、bgm_eps=12，
   * 于是卡片上没有「N集」角标。而 episodes 还被进度条、统计的累计集数、
   * 「集数 ≤」筛选、标「看完」时自动补满一起用着 —— 是 0 就等于这些功能失效。
   */
  const a = db.prepare(`SELECT id FROM anime WHERE is_stub=0 AND episodes > 0 LIMIT 1`).get();
  db.prepare('UPDATE anime SET episodes = 0, bgm_eps = 24 WHERE id = ?').run(a.id);
  const before = await get(`/anime/${a.id}`);
  ok(!/>24集</.test(before.html), '补之前卡片/详情页没有集数');

  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['scripts/fix-episodes.js'],
    { env: { ...process.env, J_ANIME_DB: process.env.J_ANIME_DB }, encoding: 'utf8' });
  ok(r.status === 0, 'fix-episodes 跑得通', r.stderr?.slice(0, 120));
  const got = db.prepare('SELECT episodes FROM anime WHERE id = ?').get(a.id).episodes;
  ok(got === 24, '用 bgm 的集数补上了', String(got));

  // 幂等 + 不覆盖 AOD 已有的值
  db.prepare('UPDATE anime SET episodes = 13, bgm_eps = 24 WHERE id = ?').run(a.id);
  spawnSync(process.execPath, ['scripts/fix-episodes.js'], { env: process.env, encoding: 'utf8' });
  ok(db.prepare('SELECT episodes FROM anime WHERE id = ?').get(a.id).episodes === 13,
     'AOD 已经有集数时不覆盖');

  const eb = readFileSync2('scripts/enrich-bgm.js', 'utf8');
  ok(/episodes = CASE WHEN coalesce\(episodes,0\) = 0/.test(eb),
     '中文名补全时也顺手补集数（新番不用等下一次修正）');
  ok(/fix-episodes\.js/.test(readFileSync2('scripts/sync-all.js', 'utf8')),
     'fix-episodes 串进了每天的同步');
}

console.log('\n━━━ 14u. 题材筛选：一份列表 + 三态 ━━━');
{
  // 原来 51 个题材铺三遍（必须全部包含 / 至少包含一个 / 排除）= 153 枚胶囊，
  // 面板七百多像素还要滚。现在一份列表，点击循环 未选 → 包含 → 排除。
  const gp = readFileSync2('src/lib/ui/GenrePicker.svelte', 'utf8');
  ok(/未选 → 包含 → 排除/.test(gp), '组件里写明了三态循环');
  ok(/全部满足/.test(gp) && /任一满足/.test(gp), '包含方式是二选一');
  for (const f of ['src/routes/catalog/+page.svelte', 'src/routes/mine/+page.svelte']) {
    const src = readFileSync2(f, 'utf8');
    ok(/<GenrePicker/.test(src), `${f} 用共用的题材组件`);
    ok(!/const SLOTS = \[/.test(src), `${f} 不再有三槽位的旧实现`);
  }

  // URL 参数没变 —— 以前存的筛选组合和分享链接必须仍然有效
  const { pickGenres } = await import('../src/lib/server/loaderUtil.js');
  const sp = (q) => new URLSearchParams(q);
  ok(pickGenres(sp('g=动作&g=冒险')).genres.join() === '动作,冒险', '「全部满足」写 g');
  ok(pickGenres(sp('any=动作&any=冒险')).genresAny.join() === '动作,冒险', '「任一满足」写 any');
  ok(pickGenres(sp('ng=后宫')).genresNot.join() === '后宫', '排除写 ng');
  ok(pickGenres(sp('gm=or&g=动作')).genresAny.join() === '动作', '老的 gm=or 链接仍然认');

  /**
   * 包含方式要有独立的落脚点（gm=or）。
   * 之前是从「值写在 g 还是 any 里」反推的 —— 一个题材都没选时两边都是空，
   * 切换模式生成的是同一个 URL，主人实测「点『任一满足』没反应」。
   */
  const { buildHref } = await import('../src/lib/urlBuild.js');
  ok(buildHref('/catalog', '', { g: null, any: [], ng: [], gm: 'or' }) === '/catalog?gm=or',
     '空选择时切到「任一满足」也会改 URL');
  ok(buildHref('/catalog', 'gm=or', { g: [], any: null, ng: [], gm: null }) === '/catalog',
     '再切回「全部满足」把 gm 清掉');
  ok(pickGenres(sp('gm=or')).genresAny.length === 0, '只有 gm=or 没选题材时不加任何条件');
  const gpsrc = readFileSync2('src/lib/ui/GenrePicker.svelte', 'utf8');
  ok(/gm === 'or'/.test(gpsrc), '组件从 gm 读包含方式');

  /**
   * 两个页面的题材顺序必须一致。番单原来按「我有多少部」降序排，
   * 于是同一个组件在两页看起来像两套列表（主人问「为什么其中一个没有卖肉」——
   * 其实都有，只是位置差太远），而且条数一变位置就跟着动。
   */
  const mineSrc = readFileSync2('src/routes/mine/+page.svelte', 'utf8');
  ok(/GENRE_NAMES\.filter\(\(g\) => myCount\[g\]\)/.test(mineSrc),
     '番单的题材列表按 GENRE_NAMES 的固定顺序（只是自己有的排前面）');
  ok(!/myGenres\.map\(\(\[g\]\) => g\)/.test(mineSrc), '不再按条数排序');
  const { GENRE_NAMES } = await import('../src/lib/genres.js');
  ok(GENRE_NAMES.length === 51 && GENRE_NAMES.includes('卖肉'),
     '题材清单只有一份（51 个，含卖肉）', String(GENRE_NAMES.length));
  for (const f of ['src/routes/catalog/+page.svelte', 'src/routes/mine/+page.svelte'])
    ok(/gm=\{pg\.url\.searchParams\.get\('gm'\)\}/.test(readFileSync2(f, 'utf8')),
       `${f} 把 gm 传给题材组件`);

  // 三态在服务端的效果：包含 / 排除 分别真的收窄了结果
  const { listAnime } = await import('../src/lib/server/queries.js');
  const n = (f) => listAnime({ hideNsfw: false, requireYear: true, jpOnly: true, ...f },
    { limit: 1, offset: 0, sort: 'newest' }).total;
  const base = n({});
  const withAction = n({ genres: ['动作'] });
  const withoutAction = n({ genresNot: ['动作'] });
  ok(withAction < base && withoutAction < base, '包含和排除都收窄结果',
     `全部 ${base} · 含动作 ${withAction} · 排除动作 ${withoutAction}`);
  ok(withAction + withoutAction <= base, '两边加起来不超过全部（同一部番不会两边都算）',
     `${withAction} + ${withoutAction} vs ${base}`);
}

console.log('\n━━━ 14t. 筛选器的计数必须和点进去的结果一致 ━━━');
{
  const { rebuildFacets, facets, listAnime } = await import('../src/lib/server/queries.js');
  rebuildFacets();
  /**
   * 实测过的坑：2028/2029 那几条全是 is_jp=0（中国动画「龙族」、欧美片「Boo」「Sunny」），
   * 而年份计数没按 is_jp 过滤 —— 胶囊上写着 2028=4、2029=2，点进去 0 部。
   */
  const ys = facets().years;
  // 换成 Bangumi 数据源后 2028+ 有真实公告的日本番了（刀剑神域 -Integral Domain- 2028）——
  // 要守的不变式是「胶囊上的数 = 点进去的部数」，不再是「2028+ 一个都没有」
  const far = ys.filter((y) => y.year >= 2028);
  ok(far.every((y) => y.c === listAnime({ yearMin: y.year, yearMax: y.year, jpOnly: true, skipYearWindow: true },
       { limit: 1 }).total),
     '2028+ 的年份胶囊计数和点进去的结果一致', far.map((y) => `${y.year}=${y.c}`).join(','));
  for (const y of [2023, 2026]) {
    const f = ys.find((x) => x.year === y)?.c ?? 0;
    const n = listAnime({ hideNsfw: false, requireYear: true, jpOnly: true, yearMin: y, yearMax: y, statuses: null },
      { limit: 1, offset: 0, sort: 'newest' }).total;
    ok(f === n, `${y} 年：胶囊数字 = 点进去的结果数`, `${f} vs ${n}`);
  }
  const src = readFileSync2('src/lib/server/queries/catalog.js', 'utf8');
  ok(/const BASE = 'a\.is_stub = 0 AND a\.is_jp = 1'/.test(src), 'facet 的基准口径抽成一处');

  // 状态文案只有一处定义（主人把「更新中」改成「连载中」时，首页那处曾漏改）
  const { STATUS_CN } = await import('../src/lib/constants.js');
  ok(STATUS_CN.ONGOING === '连载中', '在播状态叫「连载中」', STATUS_CN.ONGOING);
  // 第三次踩同一个坑了：解释「从更新中改名」的注释本身含旧文案，必须剥注释
  const strip = (t) => t.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/[^\n]*/gm, ' ');
  const hard = ALL_SVELTE.filter((f) => /更新中/.test(strip(readFileSync2(f, 'utf8'))));
  ok(hard.length === 0, '没有页面写死旧文案「更新中」', hard.join(', '));
  ok(/STATUS_CN\.ONGOING/.test(readFileSync2('src/routes/+page.svelte', 'utf8')),
     '首页那处也走 STATUS_CN 而不是写死');
}

console.log('\n━━━ 14s. 显示年份窗口（设置页配置）━━━');
{
  const { yearWindow, setSetting, listAnime, seasonYears, triageStats } =
    await import('../src/lib/server/queries.js');
  const { yearFacets } = await import('../src/lib/server/loaderUtil.js');
  const { YEAR_HARD_MIN, YEAR_HARD_MAX } = await import('../src/lib/constants.js');

  const win = () => yearWindow();
  const cat = (extra = {}) => listAnime({ hideNsfw: false, requireYear: true, jpOnly: true, ...extra },
    { limit: 1, offset: 0, sort: 'newest' }).total;

  db.exec("DELETE FROM user_setting WHERE key IN ('year_min','year_max')");
  const d = win();
  ok(d.min === 1950 && d.max === new Date().getFullYear() + 1,
     '缺省窗口是「1950 – 明年」（和以前的行为一致）', `${d.min}-${d.max}`);
  const all = cat();

  setSetting('year_min', 2000); setSetting('year_max', 2010);
  ok(win().min === 2000 && win().max === 2010, '设置生效');
  const narrow = cat();
  ok(narrow < all, '目录只出窗口内的', `${narrow} < ${all}`);
  const yf = yearFacets();
  ok(yf.every((y) => y.year >= 2000 && y.year <= 2010), '年份筛选栏的选项跟着窗口', `${yf.length} 个`);
  ok(seasonYears().every((y) => y.year >= 2000 && y.year <= 2010), '季度浏览的年份导航跟着窗口');
  const poolNarrow = triageStats().pool;

  setSetting('year_min', 1950); setSetting('year_max', 2050);
  ok(triageStats().pool > poolNarrow, '快速标记出题池也跟着窗口', `${triageStats().pool} > ${poolNarrow}`);

  // 番单和统计是主人自己的记录，不该因为改窗口就消失
  const a = db.prepare("SELECT id FROM anime WHERE is_stub=0 AND year <= 1999 AND year IS NOT NULL LIMIT 1").get();
  db.exec('DELETE FROM user_entry');
  db.prepare("INSERT INTO user_entry (anime_id,status) VALUES (?,'completed')").run(a.id);
  setSetting('year_min', 2020); setSetting('year_max', 2027);
  ok(listAnime({ watch: 'completed', hideNsfw: false, requireYear: false, skipYearWindow: true },
     { limit: 5, offset: 0, sort: 'mine' }).total === 1, '番单不受窗口影响（skipYearWindow）');
  ok(cat() < all, '同一时刻目录确实被窗口收窄了');
  db.exec('DELETE FROM user_entry');

  // 越界值要被夹住 —— 这个值会拼进 SQL（queries/triage.js: POOL）
  setSetting('year_min', 1000); setSetting('year_max', 9999);
  ok(win().min === YEAR_HARD_MIN && win().max === YEAR_HARD_MAX,
     '越界的设置被夹到 1950–2050', `${win().min}-${win().max}`);
  setSetting('year_min', 2030); setSetting('year_max', 2000);
  ok(win().max >= win().min, '上限小于下限时不会翻过来', `${win().min}-${win().max}`);
  db.exec("DELETE FROM user_setting WHERE key IN ('year_min','year_max')");

  const st = readFileSync2('src/routes/settings/+page.svelte', 'utf8');
  ok(/<RangeSlider/.test(st) && /year_window/.test(st), '设置页用区间滑块配年份');
  // 一根轨道两个滑块，且组件自己夹住「起点不超过终点」
  // 又一次剥注释：组件的注释里就写着 <input type="range">，不剥会把自己测挂
  const rs = readFileSync2('src/lib/ui/RangeSlider.svelte', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  ok((rs.match(/type="range"/g) ?? []).length === 1 && /#each \['from', 'to'\]/.test(rs),
     '两个滑块共用一条轨道（同一个 input 模板渲染两次）');
  ok(/Math\.min\(v, to\)/.test(rs) && /Math\.max\(v, from\)/.test(rs),
     '组件内部夹住：起点不会超过终点');
}

console.log('\n━━━ 14r. 分页组件统一 + 控件要有底色 ━━━');
{
  // ① 五个分页页面必须用同一个组件（排行榜原来自己写了一排「1–30 / 31–60」）
  const PAGED = ['catalog', 'mine', 'seasons', 'ranking', 'stats'];
  // 统计页的时间线（含分页）拆成了 stats/Timeline.svelte
  const pagedSrc = (p) => readFileSync2(p === 'stats' ? 'src/routes/stats/Timeline.svelte' : `src/routes/${p}/+page.svelte`, 'utf8');
  const missing = PAGED.filter((p) => !pagedSrc(p).includes('<Pager'));
  ok(missing.length === 0, '五个分页页面都用共用 Pager', missing.join(', '));
  const rk = readFileSync2('src/routes/ranking/+page.svelte', 'utf8');
  ok(!/data\.per \+ 1\}–/.test(rk), '排行榜不再自己拼「1–30」那排按钮');

  const pg = readFileSync2('src/lib/ui/Pager.svelte', 'utf8');
  ok(/type="number"/.test(pg), '页码可以直接输入（655 页点不过来）');
  ok(/<Select/.test(pg), '每页条数是下拉（站内 Select 组件，不是原生 select）');
  ok(/bg-ink-900/.test(pg) && /bg-ink-950/.test(pg),
     '按钮有实底、禁用态另一个底色（原来只有边框，浅色主题里和背景同色）');

  // ② 季度浏览的分页：单季 116 部要切成 5 页
  const s1 = await get('/seasons?year=2026&season=SUMMER&type=TV');
  // hero 的扇形封面（data-fan）也链到详情，不算网格里的卡
  const gridCards = (html) => (html.match(/<a(?![^>]*data-fan)[^>]*href="\/anime\//g) ?? []).length;
  const n1 = gridCards(s1.html);
  ok(n1 === 24, '季度浏览默认一页 24 张', String(n1));
  ok(s1.html.includes('/ ') && /第[\s\S]{0,120}页/.test(s1.html), '季度浏览有分页栏');
  const s2 = await get('/seasons?year=2026&season=SUMMER&type=TV&p=2');
  const n2 = gridCards(s2.html);
  ok(n2 > 0 && s2.html !== s1.html, '第二页有内容且和第一页不同', `${n1} / ${n2}`);
  const s3 = await get('/seasons?year=2026&season=SUMMER&type=TV&ps=50');
  ok(gridCards(s3.html) === 50, 'ps=50 生效');

  // ③ 有边框的控件必须有底色 —— 浅色主题下 ink-950 就是页面底色，只剩线条
  const noBg = [];
  for (const f of ALL_SVELTE) {
    const src = readFileSync2(f, 'utf8');
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
      const cls = m[1];
      if (!cls.includes('border-ink-') || /\bbg-/.test(cls) || cls.includes('card')) continue;
      if (/border-[tblr]\b/.test(cls)) continue;              // 纯分隔线
      if (!/\b(px-|py-|p-|[wh]-\d)/.test(cls)) continue;      // 不是控件
      noBg.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  ok(noBg.length === 0, '没有「只有边框没有底色」的控件', noBg.slice(0, 6).join(', '));

  // ④ 统计页那行状态胶囊删了（和上面的数字卡片重复，主人指出「不需要看完按键」）
  const st = readFileSync2('src/routes/stats/+page.svelte', 'utf8');
  ok(!/href="\/mine\?status=\{k\}"/.test(st), '统计页不再有状态胶囊那一行');
}

console.log('\n━━━ 14q. 一排 8 张 / 每页条数 / 加载条 / 封面死链判定 ━━━');
{
  // ① 封面网格只有一套列数（首页和统计原来是 6 列，和目录/番单对不上）
  const { CARD_GRID } = await import('../src/lib/ui/grid.js');
  ok(/lg:grid-cols-8/.test(CARD_GRID), '一排 8 张（lg 断点）', CARD_GRID);
  const cg = readFileSync2('src/lib/ui/CardGrid.svelte', 'utf8');
  ok(cg.includes('CARD_GRID') && !/grid-cols-6'/.test(cg), 'CardGrid 只用共用的列数');
  for (const f of ['src/routes/+page.svelte', 'src/routes/stats/+page.svelte'])
    ok(!/cols="sm"/.test(readFileSync2(f, 'utf8')), `${f} 不再用 6 列那套`);
  ok(/CARD_GRID/.test(readFileSync2('src/routes/triage/+page.svelte', 'utf8')),
     '快速标记页也引共用列数（原来内联抄了一份）');
  /**
   * <button> 的内容默认垂直居中，而网格行高由最高的格子（标题占三行的那个）决定 ——
   * 标题短的格子里封面会往下沉，一排封面的上边缘参差不齐。必须 flex flex-col。
   */
  // 2026-10 UI 大改：后面追加了过渡 / 淡出的 class，只要求前缀这几个还在
  ok(/class="group flex min-w-0 flex-col text-left[\s"]/.test(
       readFileSync2('src/routes/triage/+page.svelte', 'utf8')),
     '快速标记的格子是 flex 列（按钮内容默认垂直居中，会把封面压下去）');

  // ② 每页条数
  const { pickPer } = await import('../src/lib/server/loaderUtil.js');
  const sp = (q) => new URLSearchParams(q);
  ok(pickPer(sp(''), 24).per === 24 && pickPer(sp(''), 24).perIsDefault, '没给 ps → 用各页默认值');
  ok(pickPer(sp('ps=50'), 24).per === 50 && !pickPer(sp('ps=50'), 24).perIsDefault, 'ps=50 生效');
  ok(pickPer(sp('ps=7'), 24).per === 24, '清单外的值当没给（挡住 ?ps=100000）');
  ok(pickPer(sp('ps=abc'), 10).per === 10, '乱写也当没给');

  const c1 = await get('/catalog?raw=1');
  ok((c1.html.match(/href="\/anime\//g) ?? []).length >= 24, '目录默认一页 24 张（8×3）',
     String((c1.html.match(/href="\/anime\//g) ?? []).length));
  ok(c1.html.includes('每页'), '目录的分页栏有「每页」选择');
  const c2 = await get('/catalog?raw=1&ps=30');
  ok((c2.html.match(/href="\/anime\//g) ?? []).length > (c1.html.match(/href="\/anime\//g) ?? []).length,
     'ps=30 比默认 24 多');

  // 番单原来一次取 300 条、没有分页
  const mp = readFileSync2('src/routes/mine/+page.svelte', 'utf8');
  ok(/<Pager/.test(mp), '番单也有分页了');
  // 页码必须和末页夹一次 —— 只做 Math.max(1, p) 会让超出末页的请求返回空列表
  for (const f of ['src/routes/mine/+page.server.js', 'src/routes/catalog/+page.server.js']) {
    const src = readFileSync2(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    ok(/page > pages/.test(src) && /page = pages/.test(src), `${f} 的页码越界会退回末页`);
  }
  // activeCount 要算上 myScore，否则只开「未评分」时空状态会误报「此分类暂无内容」
  {
    const src = readFileSync2('src/routes/mine/+page.svelte', 'utf8');
    const m = src.match(/const activeCount = \$derived\(([\s\S]*?)\n  \);/);
    ok(!!m && /f\.myScore/.test(m[1].replace(/\/\/[^\n]*/g, '')), 'activeCount 把 myScore 算进来');
  }
  ok(!/limit: 300/.test(readFileSync2('src/routes/mine/+page.server.js', 'utf8')),
     '番单不再一次取 300 条');

  // ③ 加载条
  const lay = readFileSync2('src/routes/+layout.svelte', 'utf8');
  ok(/navigating/.test(lay), '根布局用 navigating 显示加载条');
  ok(/loadbar/.test(readFileSync2('src/app.css', 'utf8')), '加载条的动画定义在 app.css');

  // ④ 封面：网络不通不该被当成死链
  const cov = readFileSync2('src/routes/cover/[id]/+server.js', 'utf8');
  ok(/AbortSignal\.timeout/.test(cov), '抓封面有超时（断网时一屏 60 张会占满连接）');
  ok(/503/.test(cov) && /no-store/.test(cov), '网络类错误返回 503 + no-store，下次还会重试');
  const marks = (cov.match(/UPDATE anime SET cover_dead\s*=\s*1/g) ?? []).length;
  ok(marks === 2, '只有两处会标死链：没有图片地址、以及确认链接坏了', String(marks));
}

console.log('\n━━━ 14p. 时间线的文案要和实际动作对得上 ━━━');
{
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log; DELETE FROM triage;');
  const a = db.prepare(`SELECT id, episodes FROM anime WHERE is_stub=0 AND episodes BETWEEN 12 AND 26 LIMIT 1`).get();
  const log = (ep, action, detail) => db.prepare(
    'INSERT INTO watch_log (anime_id,episode,action,detail) VALUES (?,?,?,?)').run(a.id, ep, action, detail);
  db.prepare("INSERT INTO user_entry (anime_id,status,current_episode) VALUES (?,'completed',?)").run(a.id, a.episodes);

  // 进度拖到底也是 watch_ep —— 写「看了一集」就是错的（主人实测：12 集的番写着「看了一集 · 第 12 集」）
  log(a.episodes, 'watch_ep', 'completed');
  let h = (await get('/stats')).html;
  ok(!h.includes('看了一集'), '进度到头时不写「看了一集」');
  ok(h.includes('看完'), '进度到头写「看完」');

  db.exec('DELETE FROM watch_log');
  log(3, 'watch_ep', 'watching');
  h = (await get('/stats')).html;
  ok(/看到\s*第 3 集/.test(h.replace(/<[^>]*>/g, '')), '没到头写「看到第 N 集」');

  db.exec('DELETE FROM watch_log');
  log(null, 'status_change', 'plan');
  h = (await get('/stats')).html;
  ok(h.includes('改为想看'), 'status_change 写清改成了什么', '改为想看');
  ok(!h.includes('改了状态'), '不再是笼统的「改了状态」');

  db.exec('DELETE FROM user_entry; DELETE FROM watch_log; DELETE FROM triage;');
}

console.log('\n━━━ 14o. 产地判定 / 别名去重 / 未评分筛选 ━━━');
{
  // ① is_jp 只看假名会漏掉纯汉字标题的日本番（化物語、暗殺教室、風夏…）
  const { pickTitleJa } = await import('../src/lib/server/text.js');
  ok(pickTitleJa(['Fuuka', 'ふつつか', 'ふつつかな悪女ではございますが'], 'X')
       === 'ふつつかな悪女ではございますが', 'title_ja 取最长的假名别名，不是第一个');
  // 没有假名别名时退回汉字标题 —— 怪獣8号 / 闇芝居 那类全汉字标题原来 title_ja 是 NULL，
  // 而中文名补全的队列条件是 title_ja IS NOT NULL，那 1,163 条永远进不了队列
  ok(pickTitleJa(['Only Latin'], '風夏') === '風夏', '没有假名时用汉字标题');
  ok(pickTitleJa(['Kaijuu 8-gou', '怪獣8号 第2期'], 'Kaijuu 8-gou') === '怪獣8号 第2期',
     '汉字别名能当日文标题');
  ok(pickTitleJa(['Only Latin'], 'Only Latin') === null, '真的没有 CJK 才返回 null');
  const ing = readFileSync2('scripts/ingest-aod.js', 'utf8');
  ok(/japanese production/.test(ing), 'is_jp 判据带上 AOD 的产地标签');
  ok(/pickTitleJa/.test(ing), 'ingest 用共用的 pickTitleJa');

  // 拉丁占比那道兜底筛不能跨到中文那一档 —— 实测 21 条中招：
  // 攻殻機動隊 STAND ALONE COMPLEX（拉丁占比 0.46）被筛掉 → title_ja =「攻壳机动队」
  const { pickTitleJa: pick2 } = await import('../src/lib/server/text.js');
  ok(pick2(['攻殻機動隊 STAND ALONE COMPLEX', '攻壳机动队 STAND ALONE COMPLEX', '攻壳机动队', '攻壳'],
     'Koukaku Kidoutai: Stand Alone Complex') === '攻殻機動隊 STAND ALONE COMPLEX',
     '拉丁占比高的日文标题也赢过中文名（不跨简体档）');
  // 「四色战记」（简体专用字 战/记）必须输掉。氷/冰 分不开是已知限度：
  // 「国」是日文新字体也用的字、不在简体专用字表里，于是两条同罚分同长度，
  // 只剩字典序（冰 U+51B0 < 氷 U+6C37）。差一个字不影响搜 bgm，不值得为它加字表例外。
  ok(pick2(['RWBY 氷雪帝国', 'RWBY 冰雪帝国', '四色战记 冰雪帝国'], 'RWBY: Hyousetsu Teikoku')
     .startsWith('RWBY '), '带简体专用字的中文名输给不带的（四色战记 出局）');
  ok(pick2(['.hack//境界线'], '.hack//Liminality') === '.hack//境界线',
     '整档都是中文时才挑中文（AOD 里确实没有日文标题）');
  // 同一道兜底筛的另一条腿：不能挑到短得离谱的缩写。实测「まほいく」（4 字）
  // 赢过「魔法少女育成計画 restart」（拉丁占比 0.44 被筛），拿缩写搜 bgm 搜不到
  ok(pick2(['まほいく', '魔法少女育成計画 restart', '魔法少女育成計画restar'],
     'Mahou Shoujo Ikusei Keikaku: Restart') === '魔法少女育成計画 restart',
     '缩写别名赢不过全名（拉丁占比这道筛有 0.6 长度门槛）');
  ok(pick2(['ふうこい', '夫婦以上、恋人未満。'], 'Fuufu Ijou Koibito Miman') === '夫婦以上、恋人未満。',
     '同上：ふうこい 赢不过全名');

  // ② 别名去重：同一部番两条主标题不同的记录
  const { findAliasDupes, normAlias } = await import('../src/lib/server/dedup.js');
  ok(normAlias("The Ogre's Bride") === normAlias('The Ogre’s Bride'), '归一化吃掉直/弯引号差异');
  ok(normAlias('Ao Ashi') === normAlias('aoashi'), '归一化吃掉空格和大小写');

  const a = db.prepare(`SELECT id, year, type, episodes FROM anime WHERE is_stub=0 AND title_ja IS NOT NULL
    AND year IS NOT NULL AND source_count >= 8 LIMIT 1`).get();
  const ja = db.prepare('SELECT title_ja FROM anime WHERE id=?').get(a.id).title_ja;
  // 造一条薄壳：同年同类型、同日文标题、只 1 个站、集数 0
  const shell = db.prepare(`INSERT INTO anime (uid,title,title_ja,type,year,status,source_count,episodes,is_stub,is_jp)
    VALUES ('test:shell', 'Totally Different English Title', ?, ?, ?, 'FINISHED', 1, 0, 0, 1) RETURNING id`)
    .get(ja, a.type, a.year).id;
  db.prepare('INSERT INTO anime_alias (anime_id,alias,has_kana,is_cjk,src) VALUES (?,?,1,1,?)')
    .run(shell, ja, 'test');
  const pairs = findAliasDupes(db);
  const hit = pairs.find((x) => x.loser === shell);
  ok(!!hit, '同日文标题 + 同年同类型 + 只 1 个站 → 判为重复');
  ok(hit?.winner === a.id, '留下的是站点数多的那条', String(hit?.winner));
  // 反例：胖条目不能被折
  // 集数要和参照条目真不同（写死 12 会撞上：药屋 第三季 的 1 集占位修成 12 集后，判据⑤ 本该折它）
  db.prepare('UPDATE anime SET source_count = 9, episodes = ? WHERE id = ?').run((a.episodes || 12) * 3 + 1, shell);
  ok(!findAliasDupes(db).some((x) => x.loser === shell),
     '胖条目不折（东宝那 5 支音乐短片各有 10 个站，是真不同的作品）');
  db.exec(`DELETE FROM anime_alias WHERE anime_id = ${shell}; DELETE FROM anime WHERE id = ${shell};`);

  // 归一化必须吃掉三种波浪号。实测漏了全角 ～(U+FF5E) 时，ヘルモード 那部的
  // 六条记录（三条写 ~、三条写 ～）被当成不同的番，目录里一部番出现五张卡。
  const { normJa } = await import('../src/lib/server/dedup.js');
  ok(normJa('ヘルモード ~やり込み~') === normJa('ヘルモード ～やり込み～'), '三种波浪号归一化后相等');
  ok(normJa('マリッジトキシン (2027)') === normJa('マリッジトキシン'), '结尾的年份后缀不算');

  // 造四条同名记录，验四条判据
  const base = db.prepare(`SELECT id, year, type FROM anime WHERE is_stub=0 AND year IS NOT NULL LIMIT 1`).get();
  const mk = (ja, cn, src, eps, mal, year, type) => db.prepare(`INSERT INTO anime
    (uid,title,title_ja,title_cn,type,year,status,source_count,episodes,mal_id,is_stub,is_jp)
    VALUES ('t:' || ?, ?, ?, ?, ?, ?, 'FINISHED', ?, ?, ?, 0, 1) RETURNING id`)
    .get(String(Math.random()), 'T' + Math.random(), ja, cn, type ?? 'TV', year ?? 2026, src, eps, mal).id;
  const fatId = mk('テスト用架空番組タイトル はじまりの章', '测试番', 9, 12, 111, 2026, 'TV');
  const thinA = mk('テスト用架空番組タイトル', null, 1, 0, null, 2026, 'TV');                    // 前缀
  const thinB = mk('テスト用架空番組タイトル 第2期', null, 1, 0, null, 2026, 'TV');               // 前缀但带季数标记
  const thinC = mk('テスト用架空番組タイトル はじまりの章', null, 1, 3, null, 2027, 'TV');         // 跨年 1 年、同类型
  const thinD = mk('テスト用架空番組タイトル はじまりの章', null, 1, 3, null, 2030, 'MOVIE');      // 跨年又跨类型
  const p2 = findAliasDupes(db);
  const folded = new Set(p2.filter((x) => x.winner === fatId).map((x) => x.loser));
  ok(folded.has(thinA), '① 薄壳标题是正主的前缀 → 折');
  ok(!folded.has(thinB), '② 多出来的是季数标记（第2期）→ 不折（同年分割播不是重复）');
  ok(folded.has(thinC), '③ 日文标题相同、同类型、年份差 1 → 折（上游年份写歪）');
  ok(!folded.has(thinD), '④ 跨年又跨类型 → 不折（一休さん 1975 TV vs 1976 剧场版）');
  for (const id of [fatId, thinA, thinB, thinC, thinD]) db.prepare('DELETE FROM anime WHERE id=?').run(id);

  // 判据④：去掉结尾括号后同名。「弱虫ペダル (劇場版)」和「弱虫ペダル」是同一部
  const parenFat = mk('テスト用括弧変体タイトル (劇場版)', null, 9, 1, 222, 2026, 'MOVIE');
  const parenThin = mk('テスト用括弧変体タイトル', null, 1, 1, null, 2026, 'MOVIE');
  // 护栏：保留方带系列限定词时不能折 —— 实测「みなみけ (新シリーズ)」1 集
  // 想吞掉「みなみけ」13 集，方向正好反了
  const seriesFat = mk('テスト用系列限定タイトル (新シリーズ)', null, 9, 1, 333, 2026, 'TV');
  const seriesThin = mk('テスト用系列限定タイトル', null, 1, 13, null, 2026, 'TV');
  const p3 = findAliasDupes(db);
  ok(p3.some((x) => x.winner === parenFat && x.loser === parenThin),
     '④ 去掉结尾括号后同名 + 同年同类型 → 折');
  ok(!p3.some((x) => x.loser === seriesThin),
     '④ 保留方带「新シリーズ」→ 不折（那是续作，不能吞掉本篇）');
  // 全名归一化后相同的那类归判据①，不能从判据④ 溜进来（否则会连带折掉
  // 120 多对两边都只 1-2 站的薄壳，里面夹着「26 集吞 52 集」的反向合并）
  const sameFat = mk('テスト用同名薄殻タイトル', null, 2, 26, null, 2026, 'ONA');
  const sameThin = mk('テスト用同名薄殻タイトル', null, 1, 52, null, 2026, 'ONA');
  ok(!findAliasDupes(db).some((x) => x.loser === sameThin),
     '④ 全名相同、两边都是薄壳 → 不折（判据① 的地盘，保留方也得是胖条目）');

  // 折叠必须站得住：repairOrphans 不能把刚折掉的条目又放回可见。
  // 实测漏了 dup_of 这条判据时，折 31 条当场被放回 26 条，每天同步来回震荡。
  const { applyAliasDupes: apply2, repairOrphans: repair2 } = await import('../src/lib/server/dedup.js');
  const { dedupKey: dk2 } = await import('../src/lib/server/text.js');
  apply2(db, [{ winner: parenFat, loser: parenThin }]);
  repair2(db, dk2);
  ok(db.prepare('SELECT is_stub FROM anime WHERE id=?').get(parenThin).is_stub === 1,
     '折掉的条目不会被 repairOrphans 放回可见（dup_of 就是归属）');
  db.prepare('UPDATE anime SET dup_of = NULL WHERE id = ?').run(parenThin);
  ok(repair2(db, dk2).some((x) => x.id === parenThin),
     '清掉 dup_of 后又成了孤儿 → 放回可见（判据本身没退化）');

  // 折叠时两边都有番单记录：合并，不能把输家那条（可能有分有短评）直接删掉（#8）
  db.prepare('UPDATE anime SET is_stub = 0 WHERE id = ?').run(parenThin);
  db.prepare(`INSERT INTO user_entry (anime_id,status,is_vague,updated_at) VALUES (?, 'completed', 1, '2026-01-01')`).run(parenFat);
  db.prepare(`INSERT INTO user_entry (anime_id,status,current_episode,my_score,my_note,updated_at)
              VALUES (?, 'watching', 5, 8, '折叠前写的短评', '2025-01-01')`).run(parenThin);
  db.prepare(`INSERT INTO watch_log (anime_id,action,detail) VALUES (?, 'status_change', 'watching')`).run(parenThin);
  const fold = apply2(db, [{ winner: parenFat, loser: parenThin }]);
  const kept = db.prepare('SELECT * FROM user_entry WHERE anime_id = ?').get(parenFat);
  ok(fold.merged.length === 1, '两边都有记录时走合并');
  ok(kept.my_score === 8 && kept.my_note === '折叠前写的短评' && kept.status === 'watching' && kept.is_vague === 0,
     '保留方拿到了用户动过的那条（分数 / 短评 / 状态都在）', JSON.stringify(kept));
  ok(!db.prepare('SELECT 1 FROM user_entry WHERE anime_id = ?').get(parenThin), '输家的记录并过去后删掉');
  ok(db.prepare('SELECT count(*) c FROM watch_log WHERE anime_id = ?').get(parenFat).c === 1, '观看日志一起迁过去');
  db.prepare('DELETE FROM user_entry WHERE anime_id IN (?, ?)').run(parenFat, parenThin);
  db.prepare('DELETE FROM watch_log WHERE anime_id IN (?, ?)').run(parenFat, parenThin);
  for (const id of [parenFat, parenThin, seriesFat, seriesThin, sameFat, sameThin])
    db.prepare('DELETE FROM anime WHERE id=?').run(id);

  /**
   * 判据⑤：日文名严格相等 + 同年同类型 + 集数相容 + 无外部 ID 冲突 → 折，
   * 【不要求输家是薄壳】。库里那批两边都 3-10 站的真重复（魔法の姉妹ルルットリリィ
   * src10 ← Magical Sisters Lulutto Lilly src3）判据① 碰不到。
   */
  const mk2 = (ja, romaji, src, eps, mal, cn) => db.prepare(`INSERT INTO anime
    (uid,title,title_ja,title_cn,type,year,status,source_count,episodes,mal_id,is_stub,is_jp)
    VALUES ('t5:' || ?, ?, ?, ?, 'TV', 2026, 'FINISHED', ?, ?, ?, 0, 1) RETURNING id`)
    .get(String(Math.random()), romaji, ja, cn ?? null, src, eps, mal).id;
  const JA5 = 'テスト用判据五架空タイトル';
  const w5 = mk2(JA5, 'Test Judgement Five', 9, 12, 555);
  const l5 = mk2(JA5, 'Test Judgement Five Romaji', 6, 12, null);        // 胖输家，该折
  const clash5 = mk2(JA5, 'Test Judgement Five Other', 6, 12, 556);      // ID 冲突，不折
  const eps5 = mk2(JA5 + 'エプス', 'Test J5 Eps A', 9, 12, null);
  const eps5b = mk2(JA5 + 'エプス', 'Test J5 Eps B', 6, 13, null);        // 集数都非 0 且不同，不折
  const part5 = mk2(JA5 + 'パート', 'Test J5 Part', 9, 12, null);
  const part5b = mk2(JA5 + 'パート', 'Test J5 Part II', 6, 12, null);     // 分部号不同，不折
  const p5 = findAliasDupes(db);
  const fold5 = new Set(p5.map((x) => x.loser));
  ok(fold5.has(l5), '⑤ 日文名相等 + 集数相同 + 无 ID 冲突 → 折（输家不必是薄壳）');
  ok(!fold5.has(clash5), '⑤ 外部 ID 取值冲突 → 不折（东宝那 5 支短片各有自己的 MAL ID）');
  ok(!fold5.has(eps5b), '⑤ 集数都非 0 且不同 → 不折（らんま1/2 熱闘編 143集 vs 161集）');
  ok(!fold5.has(part5b),
     '⑤ 罗马字分部号不同 → 不折（千歳くん 上下半季、鬼滅の刃 無限城編 Part 2 vs Part 3）');
  for (const id of [w5, l5, clash5, eps5, eps5b, part5, part5b])
    db.prepare('DELETE FROM anime WHERE id=?').run(id);

  // ③ 未评分筛选
  const { listAnime } = await import('../src/lib/server/queries.js');
  db.exec('DELETE FROM user_entry');
  const three = db.prepare('SELECT id FROM anime WHERE is_stub=0 AND is_jp=1 AND episodes>0 LIMIT 2').all();
  db.prepare("INSERT INTO user_entry (anime_id,status,my_score) VALUES (?,'completed',8)").run(three[0].id);
  db.prepare("INSERT INTO user_entry (anime_id,status) VALUES (?,'completed')").run(three[1].id);
  const cnt = (f) => listAnime({ hideNsfw: false, requireYear: false, ...f }, { limit: 9, offset: 0, sort: 'mine' }).total;
  ok(cnt({ watch: 'completed' }) === 2, '看完 2 部');
  ok(cnt({ watch: 'completed', myScore: 'none' }) === 1, '「未评分」筛出没打分的那 1 部');
  ok(cnt({ watch: 'completed', myScore: 'has' }) === 1, '「已评分」筛出打了分的那 1 部');
  ok(cnt({ myScore: 'none' }) === 1, '「未评分」不会把全库没记录的番算进来');
  db.exec('DELETE FROM user_entry');
  for (const f of ['src/routes/mine/+page.svelte', 'src/routes/catalog/+page.svelte'])
    ok(/未评分/.test(readFileSync2(f, 'utf8')), `${f} 的评分面板有「未评分」`);
}

console.log('\n━━━ 14g. 去重：同一部番不该在目录里出现好几张一样的卡 ━━━');
{
  const { dedupKey } = await import('../src/lib/server/text.js');

  // ── 写法归一（normTitle 只去空格标点，抹不平这些）──
  const k = (t) => dedupKey(t, 2026);
  ok(k('Yoroi Shin Den Samurai Troopers') === k('Yoroi-Shinden Samurai Troopers'),
     '断词不同视为同一部');
  ok(k('Yoroi Shin Den Samurai Troopers') === k('Yoroi Shin Den Samurai Troopers (2026)'),
     '(年份) 后缀被抹掉');
  const s2 = ['Part 2', 'Part II', '2nd Cour', 'Dai 2 Cour', 'Season 2']
    .map((x) => k(`Yoroi Shin Den Samurai Troopers ${x}`));
  ok(new Set(s2).size === 1, '序数与分割标记的五种写法归一', s2[0]);
  ok(k('TOMICA & TOM Season 2') === k('Tomica to Tom (TV) Season 2'),
     '「と」的 & / to 两种写法归一');

  // ── 但分季必须仍然是不同的键 ──
  ok(k('Tomica & Tom') !== k('Tomica & Tom Season 2'), '第一季和第二季不能合成一个');
  ok(k('Steins;Gate') !== k('Steins;Gate 0'), '《命运石之门 0》不是《命运石之门》');

  // ── 库里的不变式 ──
  for (const col of ['mal_id', 'anilist_id']) {
    const dup = db.prepare(`SELECT count(*) c FROM (
      SELECT ${col} FROM anime WHERE is_stub=0 AND ${col} IS NOT NULL
      GROUP BY ${col} HAVING count(*) > 1)`).get().c;
    ok(dup === 0, `同一个 ${col} 不会挂在两个可见条目上`, `${dup} 个`);
  }

  /**
   * 每条被隐藏的都要能归并到一个可见条目 —— 否则就是真丢内容了。
   *
   * 不能只按「归一化标题 + 年份 + 类型」比：按别名去重（server/dedup.js）配对的
   * 两条主标题往往完全不同（Oni no Hanayome / The Ogre's Bride），
   * 所以三种身份任一条对得上就算归并成功：归一化标题、日文标题、中文名。
   * dup_of 也算 —— 判据④（括号变体）配对的两条【故意】全名对不上：
   * 「弱虫ペダル (劇場版)」和「弱虫ペダル」，只有 dup_of 记着归属。
   */
  const { normJa, normAlias } = await import('../src/lib/server/dedup.js');
  const COLS = 'id, dup_of, title, title_ja, title_cn, year, type, mal_id, anilist_id, anidb_id';
  const stubs = db.prepare(`SELECT ${COLS} FROM anime WHERE is_stub=1`).all();
  const vis = db.prepare(`SELECT ${COLS} FROM anime WHERE is_stub=0`).all();
  const byTitle = new Set(vis.map((r) => `${dedupKey(r.title, r.year)}|${r.year ?? ''}|${r.type}`));
  const byJa = new Set(vis.filter((r) => r.title_ja).map((r) => normJa(r.title_ja)));
  const byCn = new Set(vis.filter((r) => r.title_cn).map((r) => normAlias(r.title_cn)));
  // 外部 ID 也算有归属：MAL/AniList 上是同一条，内容就没丢
  // （实测 Girls & Panzer Movie Specials 和「少女与战车 剧场版」共用 mal_id=32740）
  const ID_COLS = ['mal_id', 'anilist_id', 'anidb_id'];
  const byId = new Set(vis.flatMap((r) => ID_COLS.filter((k) => r[k]).map((k) => `${k}:${r[k]}`)));
  const alive = new Set(vis.map((r) => r.id));
  const orphan = stubs.filter((r) =>
    !(r.dup_of && alive.has(r.dup_of))
    && !byTitle.has(`${dedupKey(r.title, r.year)}|${r.year ?? ''}|${r.type}`)
    && !(r.title_ja && byJa.has(normJa(r.title_ja)))
    && !(r.title_cn && byCn.has(normAlias(r.title_cn)))
    && !ID_COLS.some((k) => r[k] && byId.has(`${k}:${r[k]}`)));
  ok(orphan.length === 0, '每条隐藏条目都有对应的可见条目（没丢内容）',
     orphan.slice(0, 3).map((r) => r.title).join(' / '));

  // 守卫：官方 ID 不同的不能合。《我们无法学习》一二季只差一个「!」
  const bene = db.prepare(`SELECT count(*) c FROM anime WHERE is_stub=0 AND year=2019
    AND title LIKE 'Bokutachi wa Benkyou ga Dekinai%'`).get().c;
  ok(bene >= 2, '《我们无法学习》一二季都还在（守卫生效）', `${bene} 条`);

  // 起因场景：2026 年那部被上游拆成 7 条的
  const yoroi = db.prepare(`SELECT count(*) c FROM anime WHERE is_stub=0 AND year=2026
    AND title LIKE '%Samurai Troopers%'`).get().c;
  ok(yoroi <= 2, 'Yoroi 从 5 张卡收到 2 张（本篇 + 第二期）', `${yoroi} 张`);
}

console.log('\n━━━ 14h. 中文名的季数要和罗马字对得上 ━━━');
{
  const { fixCnSeason, seasonOrd } = await import('../src/lib/server/text.js');

  // bgm 对分季的粒度和 AOD 不同，一个 bgm 条目常匹配到多个 AOD 条目 ——
  // 目录里出现过三张「间谍过家家 第二季」，年份却是 2022 / 2023 / 2025
  for (const [cn, ro, want] of [
    ['间谍过家家 第二季', 'Spy x Family',          '间谍过家家'],
    ['间谍过家家 第二季', 'Spy x Family Season 2', '间谍过家家 第二季'],
    ['间谍过家家 第二季', 'Spy x Family Season 3', '间谍过家家 第三季'],
    ['86 -不存在的战区-', '86',                     '86 -不存在的战区-'],
    ['86 -不存在的战区-', '86 Part 2',              '86 -不存在的战区- 第2部分'],
    ['胆大党',            'Dandadan 2nd Season',   '胆大党 第二季'],
    ['12岁 第二季',       '12-sai.: Chicchana Mune no Tokimeki', '12岁']
  ]) ok(fixCnSeason(cn, ro) === want, `「${cn}」+「${ro}」→「${want}」`, fixCnSeason(cn, ro));

  ok(seasonOrd('Aggressive Retsuko (ONA) 4th Season') === 4, '4th Season → 4');
  ok(seasonOrd('第三季') === 3, '第三季 → 3');
  ok(seasonOrd('Ao Ashi') === 1, '没有标记 → 1');

  /**
   * 季数和分部号（Part / Cour）是两回事，必须分开解析。
   * 原来 seasonOrd 把 part 也当季数，两个后果：
   *   「4th Season Part 2」算成第 2 季 → 中文名成「第2部分」，丢了「第四季」
   *   「2nd Season Part 2」和「2nd Season」算出同一个数 → 两条同名，
   *     主人搜「关于我转生变成」看到两张「…第二季」，以为是重复条目
   *     （史莱姆第二季是分割播出：2021 冬 12 集 + 2021 夏 12 集，两条都对）
   */
  const { partOrd } = await import('../src/lib/server/text.js');
  for (const [t, wantS, wantP] of [
    ['Tensei shitara Slime Datta Ken 2nd Season',        2, 0],
    ['Tensei shitara Slime Datta Ken 2nd Season Part 2', 2, 2],
    ['Tensei shitara Slime Datta Ken 4th Season Part 2', 4, 2],
    ['Shingeki no Kyojin Season 3 Part 2',               3, 2],
    ['Tensei Shitara Slime datta Ken Dai 4 Ki (Part 2)', 4, 2],
    // 同一个 II 不能被两边各数一次：seasonOrd 要先把 Part 段摘掉
    ['Lupin III: Part II',                               1, 2],
    ['One-Punch Man 3: Part II',                         1, 2],
    ['86 Part 2',                                        1, 2],
    ['Overlord IV',                                      4, 0]
  ]) ok(seasonOrd(t) === wantS && partOrd(t) === wantP,
        `「${t}」→ 季 ${wantS} / 部 ${wantP}`, `季 ${seasonOrd(t)} / 部 ${partOrd(t)}`);

  // 分割播出的两段中文名必须区分得开，否则目录里看着就是重复条目
  const s2 = fixCnSeason('关于我转生变成史莱姆这档事 第二季', 'Tensei shitara Slime Datta Ken 2nd Season Part 2');
  ok(s2 === '关于我转生变成史莱姆这档事 第二季 第2部分', '季数和分部号都写上', s2);
  const dupCn = db.prepare(`SELECT count(*) c FROM (
    SELECT title_cn, year, type FROM anime WHERE is_stub=0 AND title_cn IS NOT NULL
      AND year IS NOT NULL AND title LIKE '%Part 2%'
    GROUP BY title_cn, year, type HAVING count(*) > 1)`).get().c;
  ok(dupCn === 0, '带 Part 2 的条目不会和同年同类型的另一条同名', `${dupCn} 组`);

  /**
   * 库里的不变式：中文名的季数要和罗马字一致 ——
   * 但【只在罗马字明确写了季数的条目上】要求，和 scripts/fix-cn-season.js 的范围对齐。
   *
   * 为什么不全库要求：fixCnSeason 认季数靠启发式，对这几类会算错，
   * 硬套等于凭空造季数：
   *   「Lupin III: Part II」「Chain Chronicle ... Part 1」—— 只有分部号没有季数，
   *      那个 II 到底是分段还是季数说不清
   *   「Mushoku Tensei II」「Diamond no Ace act II -Second Season-」—— 中缀罗马数字
   *      和英文序数词 seasonOrd 认不出来，硬算会把已有的「第二季」丢掉
   *   「Honkai Impact 3rd」「Tu Bian Yingxiong X」—— 版本号写进了作品名
   * 实测全库硬套会改坏 28 条。要抓的是「同一季分两段却同名」那类，
   * 判据就是罗马字同时写了季数和分部号。
   */
  // 匹配时已经校验过季数的（bgm_match_rule 含「季」）中文名来自对应那一季的 bgm 条目，是权威的 ——
  // 「第三季 反击篇」就是 Part II，罗马字的启发式反而认不出（#2）
  const bad = db.prepare(`SELECT title, title_cn FROM anime WHERE title_cn IS NOT NULL
      AND coalesce(bgm_match_rule,'') NOT LIKE '%季%'`).all()
    .filter((r) => seasonOrd(r.title) > 1 && partOrd(r.title) > 1)
    .filter((r) => fixCnSeason(r.title_cn, r.title) !== r.title_cn);
  ok(bad.length === 0, '库里没有季数对不上的中文名',
     bad.slice(0, 3).map((r) => `${r.title_cn} / ${r.title}`).join(' · '));

  // 起因场景
  const spy = db.prepare(`SELECT title_cn FROM anime WHERE is_stub=0
    AND title LIKE 'Spy x Family%' AND type='TV' ORDER BY year, season`).all().map((r) => r.title_cn);
  ok(new Set(spy).size === spy.length, 'SPY×FAMILY 各季中文名互不相同', spy.join(' / '));
}

console.log('\n━━━ 14c. 排序：三页同一套 + 季度按时间而不是字母 ━━━');
{
  const { listAnime } = await import('../src/lib/server/queries.js');
  const { SORT_OPTS, DEFAULT_SORT, SEASON_SORT_OPTS } = await import('../src/lib/constants.js');

  ok(DEFAULT_SORT === 'newest', '默认排序是「最新」（年份+季度 新→旧）', DEFAULT_SORT);
  ok(SORT_OPTS.some(([v]) => v === DEFAULT_SORT), '默认值在选项表里');
  ok(!SEASON_SORT_OPTS.some(([v]) => ['newest', 'oldest'].includes(v)),
     '季度浏览不提供最新/最早（块内年份季度相同，是空操作）');

  // ⚠️ season 是文本，`ORDER BY season DESC` 是按字母排 ——
  // 实测得到 WINTER → UNDEFINED → SUMMER → SPRING → FALL，完全不是时间顺序
  const ORD = { WINTER: 1, SPRING: 2, SUMMER: 3, FALL: 4 };
  const { rows } = listAnime({ types: ['TV'], jpOnly: true, requireYear: true },
                             { limit: 200, sort: 'newest' });
  const seq = rows.filter((r) => r.year && ORD[r.season]).map((r) => r.year * 10 + ORD[r.season]);
  ok(seq.length > 50, 'newest 取到足够样本', `${seq.length} 条`);
  ok(seq.every((v, i) => i === 0 || seq[i - 1] >= v), 'newest 严格按 年份*10+季度序号 递减',
     seq.slice(0, 6).join(' → '));

  const asc = listAnime({ types: ['TV'], jpOnly: true, requireYear: true },
                        { limit: 200, sort: 'oldest' }).rows
    .filter((r) => r.year && ORD[r.season]).map((r) => r.year * 10 + ORD[r.season]);
  ok(asc.every((v, i) => i === 0 || asc[i - 1] <= v), 'oldest 严格递增', asc.slice(0, 6).join(' → '));

  // 三页都用同一个 SortPill
  const { readFileSync } = await import('node:fs');
  for (const f of ['catalog', 'mine', 'seasons'])
    ok(readFileSync(`src/routes/${f}/+page.svelte`, 'utf8').includes('SortPill'),
       `/${f} 用共用的 SortPill`);
  ok(!readFileSync('src/lib/constants.js', 'utf8').includes('MINE_SORT_OPTS'),
     '番单专用的排序表已删（曾把「最新」叫成「年份新」）');
}

console.log('\n━━━ 14i. 目录默认：类型排除 ONA/SP + 完结状态多选 ━━━');
{
  const { DEFAULT_TYPES, ALL_TYPES } = await import('../src/lib/constants.js');
  ok(!DEFAULT_TYPES.includes('ONA') && !DEFAULT_TYPES.includes('SPECIAL'),
     '默认类型排除 ONA 和 SP', DEFAULT_TYPES.join('·'));
  ok(DEFAULT_TYPES.every((t) => ALL_TYPES.includes(t)), '默认类型都是合法值');

  const { pickTypes, pickStatus } = await import('../src/lib/server/loaderUtil.js');
  const sp = (q) => new URLSearchParams(q);
  ok(pickTypes(sp(''), DEFAULT_TYPES).typesAreDefault, '没给 type → 默认态');
  ok(pickTypes(sp('type=all'), DEFAULT_TYPES).typesAreAll, 'type=all → 全部类型');
  ok(pickTypes(sp('type=all'), DEFAULT_TYPES).types === null, 'type=all 不加类型条件');
  ok(pickTypes(sp('type=TV&type=OVA'), DEFAULT_TYPES).types.join() === 'TV,OVA', '显式多选生效');

  const d = pickStatus(sp(''));
  ok(d.statusIsDefault && !d.statuses.includes('UPCOMING'),
     '没给 status → 默认给出「除未上映以外」三种（让 chip 自己亮着，不用文字解释）',
     d.statuses.join('·'));
  ok(pickStatus(sp('status=all')).statuses === null, 'status=all → 不加状态条件（四种全含）');
  ok(pickStatus(sp('status=ONGOING&status=FINISHED')).statuses.join() === 'ONGOING,FINISHED',
     '完结状态可多选');
  ok(pickStatus(sp('status=bogus')).statusIsDefault, '乱写的 status 当没给');

  // 只剩一项时不许取消 —— 取消会把参数从 URL 删掉，loader 就回落到自己的默认值，
  // 表现为「只选了更新中，再点它一下，反而三档全亮」。
  // 走纯函数而不是抓 HTML：筛选面板是点开才渲染的，SSR 的 HTML 里没有这些 chip。
  const { toggleIn } = await import('../src/lib/urlBuild.js');
  ok(toggleIn(['ONGOING', 'FINISHED'], 'ONGOING').join() === 'FINISHED', '还有别的选中时可以取消');
  ok(toggleIn(['ONGOING'], 'UPCOMING').join() === 'ONGOING,UPCOMING', '点别的项是追加');
  const mc = readFileSync2('src/lib/ui/MultiChip.svelte', 'utf8');
  // 取消唯一选中的那项 → 直接切到 allValue（「全部」），而不是变成空选择：
  // 参数从 URL 消失后 loader 会回落到自己的默认值，点一下反而多选上两三项。
  ok(/only \? allValue :/.test(mc), '取消最后一项 → 自动切到「全部」');
  ok(!/至少要选一项/.test(mc), '不再弹「至少要选一项」的 toast');

  // 连点同一个 chip 会一直弹 —— 同屏最多留最新的 5 条，否则从右下角铺到页面顶部
  const { pushCapped, MAX_TOASTS } = await import('../src/lib/toastQueue.js');
  ok(MAX_TOASTS === 5, '同屏 toast 上限是 5', String(MAX_TOASTS));
  let q = [];
  for (let i = 1; i <= 9; i++) q = pushCapped(q, { id: i, text: 't' + i });
  ok(q.length === 5, '弹 9 条只留 5 条', String(q.length));
  ok(q.map((x) => x.id).join() === '5,6,7,8,9', '留下的是最新的 5 条', q.map((x) => x.id).join());
  /**
   * 同文本同色要去重。实测：主人对着同一个不合法的输入连点五次「添加」，
   * 屏上堆了五条一模一样的红条 —— 封顶只挡住「铺满整页」，没挡住「同一句刷五遍」。
   */
  let dq = [];
  for (let i = 1; i <= 5; i++) dq = pushCapped(dq, { id: i, text: '同一句', tone: 'error' });
  ok(dq.length === 1, '同一句连点五次只留一条', String(dq.length));
  ok(dq[0].id === 5, '留下的是最新那条（换新 id → 换新计时）', String(dq[0].id));
  dq = pushCapped(dq, { id: 6, text: '另一句', tone: 'error' });
  ok(dq.length === 2, '不同文本不去重', String(dq.length));
  dq = pushCapped(dq, { id: 7, text: '同一句', tone: 'ok' });
  ok(dq.length === 3, '同文本不同色不去重（红/灰是两种意思）', String(dq.length));
  const ts = readFileSync2('src/lib/toast.svelte.js', 'utf8');
  ok(ts.includes('pushCapped'), 'toast 走的是带上限的队列');

  // 季度浏览的年份缺省是「当前年」，所以那页不该有年份「全部」——
  // 它永远亮不起来（year 一直有值），点了只会跳回当前年
  const sy = await get('/seasons?year=2015');
  ok(!/href="\/seasons"[^>]*>\s*全部/.test(sy.html), '季度浏览没有骗人的年份「全部」');
  const yp = readFileSync2('src/lib/ui/YearPill.svelte', 'utf8');
  ok(yp.includes('showYearAll'), 'YearPill 支持关掉年份「全部」');

  // 界面上不该有多余的选项和教学式说明 —— 主人明确要求过
  const src = readFileSync2('src/routes/catalog/+page.svelte', 'utf8');
  ok(!src.includes('>已上映<'), '没有「已上映」这个冗余选项（= 更新中+已完结）');
  ok(!src.includes('>默认<'), '类型里没有「默认」这个冗余选项（默认可自己配）');
  ok(!src.includes('ONA=网络动画'), '没有 ONA/SP 的名词解释');
  ok(!src.includes('可多选 · 默认不含未上映'), '没有「可多选/默认不含未上映」这类说明');
  ok(src.includes('MultiChip'), '类型与完结状态都用共用的 MultiChip');

  // 高亮口径（2026-10 UI 大改分两档）：默认在缩小结果的筛选（默认的类型排除了 ONA/SP，
  // 默认的完结状态排除了未上映）要看得出 —— 写出摘要 + accent 小点，但不是满蓝框（满蓝框 = 用户改过）；
  // 题材「全部」不缩小结果，什么都不标
  const bare = await get('/catalog');
  const pill = (html, label) => {
    const i = html.indexOf(`>${label}</span>`);
    if (i < 0) return null;
    const start = html.lastIndexOf('<button', i);
    const end = html.indexOf('</button>', i);
    return start >= 0 ? html.slice(start, end) : null;
  };
  const quiet = (b) => !!b && !b.includes('border-accent') && b.includes('rounded-full bg-accent');
  ok(quiet(pill(bare.html, '类型')), '默认态下「类型」胶囊标出小点、不满蓝（它排除了 ONA/SP）');
  ok(quiet(pill(bare.html, '放送')), '默认态下「放送」胶囊标出小点、不满蓝（它排除了未上映）');
  const g = pill(bare.html, '题材');
  ok(!!g && !g.includes('border-accent') && !g.includes('rounded-full bg-accent'), '「题材」全部时不高亮（没有缩小结果）');
  const tv = await get('/catalog?type=TV');
  ok(pill(tv.html, '类型')?.includes('border-accent'), '改过类型 → 满蓝框');

  // 2027 年全是未上映，默认状态不含它 → 选了 2027 必然 0 部。空屏要给出口
  const empty = await get('/catalog?from=2027&to=2027');
  ok(empty.html.includes('没有符合条件的番剧'), '2027 + 默认状态 → 空结果');
  ok(/含未上映 [\d,]+ 部/.test(empty.html), '空态给出「含未上映 N 部」的一键出口');
  const relaxed = await get('/catalog?from=2027&to=2027&status=all');
  ok(/href="\/anime\/\d+"/.test(relaxed.html), '点进去确实有内容');
}

console.log('\n━━━ 14j. 季度浏览：默认当前年+当前季，年份胶囊显示选中值 ━━━');
{
  const now = new Date();
  const curY = now.getFullYear();
  const CUR_SEASON = ['WINTER', 'WINTER', 'WINTER', 'SPRING', 'SPRING', 'SPRING',
                      'SUMMER', 'SUMMER', 'SUMMER', 'FALL', 'FALL', 'FALL'][now.getMonth()];
  const def = await get('/seasons');
  ok(def.status === 200 && noErr(def.html), '季度浏览默认页 200');
  // 2026-10 UI 大改：单季时 hero 就是标题、不再有分节标题，改按 data-season 数块
  const blocks = [...def.html.matchAll(/data-season="(\w+)"/g)].map((m) => m[1]);
  ok(new Set(blocks).size === 1, '默认只显示一个季度块', blocks.join(','));
  ok(blocks[0] === CUR_SEASON, `默认就是当前季（${CUR_SEASON}）`, blocks[0]);

  const all = await get('/seasons?season=all');
  ok(new Set([...all.html.matchAll(/data-season="(\w+)"/g)].map((m) => m[1])).size === 4,
     'season=all 回到四季网格');

  // 主人 2026-10-21 第 3 条：切换条的选中语言和放送表日历条一致 ——
  // 选中 = accent 实色（is-on），本季但没选中 = accent 描边（is-now，年份后写「本季」）
  const stripChips = (html) => {
    const nav = html.slice(html.indexOf('aria-label="切换季度"'), html.indexOf('</nav>', html.indexOf('aria-label="切换季度"')));
    return [...nav.matchAll(/<a [^>]*class="chip[^"]*"[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
  };
  const defStrip = stripChips(def.html);
  const defOn = defStrip.filter((c) => c.includes('aria-current="page"'));
  ok(defOn.length === 1 && /\bis-on\b/.test(defOn[0]) && defOn[0].includes('本季'),
     '默认页：选中的就是本季那格，实色 + 写着「本季」', defOn.map((c) => c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).join(' / '));
  const allStrip = stripChips(all.html);
  const nowChip = allStrip.filter((c) => /\bis-now\b/.test(c));
  ok(nowChip.length === 1 && nowChip[0].includes('本季') && !nowChip[0].includes('aria-current'),
     '四季总览：本季那格没选中时是描边（is-now），和选中（全年）区分开');
  ok(allStrip.filter((c) => /\bis-on\b/.test(c)).length === 1 && allStrip.find((c) => /\bis-on\b/.test(c)).includes('全年'),
     '四季总览：选中的是「全年」那格');

  // 年份胶囊要显示选中的年份 —— 季度浏览永远有年份，藏起来就看不出选了哪年
  const pill = (html) => {
    const i = html.indexOf('年份');
    return html.slice(i, i + 220).replace(/<[^>]+>/g, '|').split('|').map((x) => x.trim()).filter(Boolean);
  };
  ok(pill(def.html).some((x) => x.startsWith(String(curY))), '年份胶囊显示了选中年份', pill(def.html).slice(0, 3).join(' '));
  const y2020 = await get('/seasons?year=2020&season=SPRING');
  ok(pill(y2020.html).includes('2020春'), '换年份后胶囊跟着变', pill(y2020.html).slice(0, 3).join(' '));
}

console.log('\n━━━ 14x. 搜索结果也按「最新」排 ━━━');
{
  /**
   * 原来搜索走的是「相关度」：`fts && !f.sort ? 'source_count DESC, year DESC' : SORTS[sort]`。
   * 两个问题：
   *   ① f.sort 这个字段从来没被赋值过（f 是筛选对象，排序走第二个参数），
   *      于是 `!f.sort` 恒为真 —— 只要带搜索词，排序选项就完全失效，
   *      主人在搜索状态下点「最新」「人气」「评分」结果一动不动。
   *   ② 主人要的是「所有筛选输入栏查询时，排序默认最新到最旧」。
   */
  const yrs = (rows) => rows.map((r) => r.year).filter((y) => y != null);
  const desc = (a) => a.every((y, i) => i === 0 || a[i - 1] >= y);

  const r = await get('/catalog?q=' + encodeURIComponent('史莱姆') + '&status=all');
  const ys = [...r.html.matchAll(/>((?:19|20)\d{2})</g)].map((m) => +m[1]);
  ok(ys.length > 2, '搜索有结果', `${ys.length} 个年份`);
  ok(desc(ys), '搜索结果按年份新 → 旧', ys.slice(0, 8).join(' '));

  // 排序选项在搜索状态下要真的生效（原来被相关度分支吞掉）
  const { listAnime } = await import('../src/lib/server/queries/catalog.js');
  const newest = yrs(listAnime({ q: '史莱姆' }, { limit: 20, sort: 'newest' }).rows);
  const oldest = yrs(listAnime({ q: '史莱姆' }, { limit: 20, sort: 'oldest' }).rows);
  ok(desc(newest), '搜索 + sort=newest 年份降序', newest.slice(0, 6).join(' '));
  ok(oldest.every((y, i) => i === 0 || oldest[i - 1] <= y),
     '搜索 + sort=oldest 年份升序（说明排序确实生效）', oldest.slice(0, 6).join(' '));
}

console.log('\n━━━ 14e. 目录默认排除未上映（逃生口要留着）━━━');
{
  const { listAnime } = await import('../src/lib/server/queries.js');
  const BASEF = { types: ['TV', 'MOVIE', 'ONA'], jpOnly: true, requireYear: true, yearMin: 1950 };
  const up = (rows) => rows.filter((r) => (r.status_eff ?? r.status) === 'UPCOMING').length;

  const def = listAnime({ ...BASEF, excludeUpcoming: true }, { limit: 60, sort: 'newest' });
  ok(up(def.rows) === 0, '默认首屏没有未上映', `${up(def.rows)} 部`);
  ok(def.rows[0]?.year <= new Date().getFullYear(), '默认首屏第一部不是未来年份', String(def.rows[0]?.year));

  const all = listAnime(BASEF, { limit: 60, sort: 'newest' });
  ok(up(all.rows) > 0, 'status=all 能看到未上映（逃生口 1）', `${up(all.rows)} 部`);
  ok(all.total > def.total, '含未上映时总数更多', `${all.total} > ${def.total}`);

  const only = listAnime({ ...BASEF, status: 'UPCOMING' }, { limit: 60, sort: 'newest' });
  ok(only.total > 0 && up(only.rows) === only.rows.length,
     'status=UPCOMING 只出未上映（逃生口 2）', `${only.total} 部`);

  // 搜具体番名时不能因为默认排除而搜不到 —— 那会像是坏了
  // 搜索必须绕过全部收窄条件。原来只在 typesAreDefault 时绕过 ——
  // 主人把「2026夏+更新中·已完结」存成默认筛选后条件变成显式的，绕过就失效了，
  // 搜「刀剑神域」得 0 部
  const HARD = { types: ['TV', 'MOVIE', 'OVA'], yearMin: 2026, yearMax: 2026, season: 'SUMMER',
                 statuses: ['ONGOING', 'FINISHED'], requireYear: true, jpOnly: true };
  ok(listAnime(HARD, { limit: 1 }).total > 0, '不搜索时这套筛选本身有结果');
  for (const kw of ['刀剑神域', 'Kimetsu', '鬼滅の刃'])
    ok(listAnime({ ...HARD, q: kw }, { limit: 5 }).total > 0,
       `搜「${kw}」绕过全部筛选`, `${listAnime({ ...HARD, q: kw }, { limit: 5 }).total} 部`);

  /**
   * 「全部」必须真的是全部 —— 筛选栏六枚胶囊能设的字段一个都不许漏。
   * 实测漏了 watch：搜「叹气」时「我的 = 未标记」还挂着，已经看完的
   * 《叹气的亡灵想隐退 第2部分》被筛掉，两部只出一部（主人截图报的）。
   */
  const EVERY = { ...HARD, watch: 'none', myScore: 'none', genres: ['奇幻'], genresAny: ['喜剧'],
                  genresNot: ['奇幻'], scoreMin: 9.9, votesMin: 99999, epMax: 1,
                  studio: 'not-a-real-studio', weekday: 7, isShort: 1, rankedOnly: true,
                  tag: 'not-a-real-tag', status: 'UPCOMING' };
  ok(listAnime(EVERY, { limit: 1 }).total === 0, '这套「不可能同时成立」的筛选本身是 0 部');
  for (const kw of ['刀剑神域', '鬼滅の刃'])
    ok(listAnime({ ...EVERY, q: kw }, { limit: 5 }).total > 0,
       `搜「${kw}」把筛选栏能设的字段全部卸掉`, `${listAnime({ ...EVERY, q: kw }, { limit: 5 }).total} 部`);

  // 开关：默认关 → 搜索忽略筛选；qf=1 → 筛选叠到搜索结果上
  ok(listAnime({ ...HARD, q: '刀剑神域', applyFilters: true }, { limit: 5 }).total === 0,
     'qf 开启后筛选重新生效（这套筛选下搜不到）');

  /**
   * 番单页的 watch 是【分类】（想看/在看/看完）而不是筛选栏给的，
   * 所以它靠 scopeKeys 豁免 —— 在「看完」里搜索不能把整个库都翻出来。
   */
  const mineLike = { q: '史莱姆', skipYearWindow: true, scopeKeys: ['watch'] };
  const inDone = listAnime({ ...mineLike, watch: 'completed' }, { limit: 60 }).total;
  const noScope = listAnime({ ...mineLike, watch: 'completed', scopeKeys: [] }, { limit: 60 }).total;
  ok(inDone < noScope, 'scopeKeys 保住番单的分类（搜索没把 watch 卸掉）', `${inDone} < ${noScope}`);
  ok(readFileSync2('src/routes/mine/+page.server.js', 'utf8').includes("scopeKeys = ['watch']"),
     '番单页声明了 watch 是页面作用域');
  const csrc = readFileSync2('src/routes/catalog/+page.svelte', 'utf8');
  ok(csrc.includes('label="应用筛选"'), '有「应用筛选」开关');
  ok(csrc.includes('muted={data.filtersMuted}'), '搜索时筛选栏置灰');
  /**
   * 开关要在筛选栏【里面】、排在「重置」之后，不能单独占一行浮在上面 ——
   * 它管的就是那一排，同一行才看得出管辖关系。
   * 那句「搜索结果不受下面的筛选影响」也删了：和开关状态是同一件事、
   * 还是反着说的（双重否定），而且和整排置灰重复。
   */
  const bar = csrc.slice(csrc.indexOf('use:edgeFade class="mt-3 flex flex-wrap items-center'));
  ok(bar.indexOf('<Toggle') > bar.indexOf('<ResetButton') && bar.indexOf('<ResetButton') > 0,
     '开关排在「重置」之后（筛选栏最后一枚）');
  // 先剥注释 —— 解释这条规则的注释本身就写着那句话，会把自己测挂
  const csrcNoComment = csrc.replace(/<!--[\s\S]*?-->/g, ' ');
  ok(!csrcNoComment.includes('搜索结果不受下面的筛选影响'), '不再写那句双重否定的说明');

  // 「重置」原来按 sort !== 'popular' 判断，可目录默认排序是「最新」—— 什么都没改它也一直挂着
  const resetIn = (html) => /<a href="\/catalog"[^>]*>(?:(?!<\/a>)[\s\S])*重置<\/a>/.test(html);
  ok(!resetIn((await get('/catalog?raw=1')).html), '目录默认状态不显示「重置」');
  ok(resetIn((await get('/catalog?sort=popular')).html), '改了排序才显示「重置」');

  const searched = await get('/catalog?q=' + encodeURIComponent('刀剑神域'));
  ok(searched.html.includes('opacity-40'), '搜索页的筛选栏渲染成置灰（这就是「没生效」的信号）');
  ok(searched.html.includes('应用筛选'), '搜索时才出现这个开关');
  const noQ = await get('/catalog');
  ok(!noQ.html.includes('应用筛选'), '没搜索时不显示这个开关（它没有意义）');

  // 界面上不放说明文字，靠 chip 的选中态表达「默认不含未上映」——
  // 「已上映」那个选项也去掉了（它就等于 更新中+已完结）
  const src = (await import('node:fs')).readFileSync('src/routes/catalog/+page.svelte', 'utf8');
  ok(src.includes('>全部<'), '状态筛选里有「全部」');
  ok(!src.includes('>已上映<') && !src.includes('默认不含未上映'), '没有冗余选项和说明文字');
}

console.log('\n━━━ 14f. 状态推导：UNDEFINED 季度不能掉进「更新中」━━━');
{
  const Y = new Date().getFullYear();
  const bad = db.prepare(`SELECT count(*) c FROM anime WHERE is_stub=0
    AND year > ? AND coalesce(status_eff,status) IN ('ONGOING','FINISHED')`).get(Y).c;
  ok(bad === 0, '未来年份的番不会被标成更新中/已完结', `${bad} 条`);

  // 起因：AOD 有 season='UNDEFINED'，它是真值，会让季度推导分支跑起来，
  // 而 START['UNDEFINED'] 是 undefined → NaN → 两个比较都 false → 掉进 else 判成 ONGOING
  const undef = db.prepare(`SELECT count(*) c FROM anime WHERE is_stub=0
    AND season = 'UNDEFINED' AND year > ? AND coalesce(status_eff,status) = 'ONGOING'`).get(Y).c;
  ok(undef === 0, 'UNDEFINED 季度 + 未来年份不会是更新中', `${undef} 条`);

  const upcoming = db.prepare(`SELECT count(*) c FROM anime WHERE is_stub=0
    AND coalesce(status_eff,status)='UPCOMING'
    AND season IN ('WINTER','SPRING','SUMMER','FALL')
    AND year < ?`).get(Y).c;
  ok(upcoming === 0, '往年的番不会还挂着未上映', `${upcoming} 条`);

  /**
   * 上一条的成因：bgm 的 subject 是整部作品，粒度和 AOD 对不上 ——
   * 2025 秋的单集特番《ドリームログ》匹到 2026-10-17 首播的 10 集《Dreamland》，
   * 带回来的未来日期让它挂上「未上映」。判据同 enrich-bgm 的 epsClash /
   * fix-bgm-clash：两边集数都已知且差 4 倍以上，就不该留着 bgm 日期。
   */
  // 例外是 Bangumi 匹配时确认过「同一部作品、只是数集口径不同」的（齐木楠雄 AOD 120 段 / bgm 24 集）：
  // 规则里有「型」+「年」、且有「名」或「原」，见 bangumiMatch.js 的 sameWork
  const clash = db.prepare(`SELECT count(*) c FROM anime
    WHERE coalesce(episodes,0) > 0 AND coalesce(bgm_eps,0) > 0
      AND max(episodes, bgm_eps) >= 4 * min(episodes, bgm_eps)
      AND (bgm_air_start IS NOT NULL OR bgm_air_end IS NOT NULL)
      AND NOT (coalesce(bgm_match_rule,'') LIKE '%型%' AND bgm_match_rule LIKE '%年%'
               AND (bgm_match_rule LIKE '%名%' OR bgm_match_rule LIKE '%原%'))`).get().c;
  ok(clash === 0, '集数量级对不上的番不会留着 bgm 放送日期', `${clash} 条`);
}

console.log('\n━━━ 14w2. bgm 匹配：别名不能自我强化、跨语言不能比 ━━━');
{
  /**
   * 主人报《异世界药局》的中文名显示成「异世界舅舅」。查出三个叠在一起的问题：
   *
   * ① 别名自我强化的循环。命中后我们把 bgm 的 name_cn 插进 anime_alias（给搜索用，
   *    src='bgm'）。而取候选名时不分来源，于是下一轮 --retry 拿这个【自己写的错名字】
   *    去比，和那个错条目完全同名（s=1.00），把错误坐实、再也纠不回来。
   *
   * ② 简体专用字表手工维护，漏了「药」「际」。于是《異世界薬局》的 title_ja
   *    被存成台译「奇幻世界药局」（6 字，比「異世界薬局」5 字长，而长度排在
   *    简体降权前面），拿它去搜 bgm 搜不到正确条目。
   *
   * ③ 跨语言比相似度。bgm 的 name 是日文原名、name_cn 是中文译名，
   *    拿日文标题去和中文译名比，共享的汉字前缀会凭空造出相似度：
   *      《魔法少女アイ》↔ bgm 1262《魔法少女リリカルなのは》
   *        日↔日 = 0.40（正确拒掉）· 日↔中「魔法少女奈叶」= 0.60（错误接受）
   *    「魔法少女」「異世界」「劇場版」这类前缀在日文里极常见，短标题尤其容易翻车。
   */
  const src = readFileSync2('scripts/enrich-bgm.js', 'utf8');
  ok(/coalesce\(src, ''\) != 'bgm'/.test(src),
     '取候选名时排掉 bgm 来源的别名（否则错误会自我强化）');
  ok(/kindOf/.test(src) && /k !== 'any' && k !== tk/.test(src),
     '只在文字种类相容时比相似度（不做日↔中的跨语言比较）');

  const { SIMPLIFIED } = await import('../src/lib/server/text.js');
  // 字表改成从数据推导（scripts/gen-simplified.js），手工维护必漏
  for (const ch of ['药', '际', '异', '说', '电', '剧'])
    ok(SIMPLIFIED.test(ch), `「${ch}」判为简体专用`);
  for (const ch of ['薬', '国', '学', '体', '恋', '斗', '来'])
    ok(!SIMPLIFIED.test(ch), `「${ch}」判为日文也用（不能误判成中文）`);

  const { pickTitleJa } = await import('../src/lib/server/text.js');
  // 简体降权必须压在长度前面 —— 台译「奇幻世界药局」比日文原题长一个字
  const got = pickTitleJa(['Isekai Yakkyoku', '奇幻世界药局', '异世界药局', '異世界薬局'], 'Isekai Yakkyoku');
  ok(got === '異世界薬局', '更长的中文名不会赢过更短的日文原题', got);

  // 库里的不变式：两部不同的番不该显示同一个中文名（同年同类型）
  const pair = db.prepare(`SELECT title_cn FROM anime WHERE id IN (
    SELECT id FROM anime WHERE title LIKE 'Isekai Yakkyoku%' OR title LIKE 'Isekai Ojisan%')`).all()
    .map((r) => r.title_cn);
  ok(new Set(pair).size === pair.length, '《异世界药局》和《异世界舅舅》中文名不同', pair.join(' / '));

  /**
   * ④ 错误匹配留下的别名会永久污染搜索。
   * 原来 enrich-bgm 写新中文名时【只插不删】，于是主人搜「异世界舅舅」
   * 还能搜出《异世界药局》—— 那条 [bgm] 异世界舅舅 是错匹配写进去的，
   * 改对 title_cn 之后它还在别名表里，reindex 又把它收进 FTS。
   *
   * 只删【基础名不同】的：只差季数标记的要留着（别名「终究、与你相恋。」
   * 对应中文名「… 第二季」，搜基础名能找到全部季）。
   * 实测全库 517 条不一致里，只有 2 条属于该删的。
   */
  ok(/delBgmAlias/.test(src) && /aliasBase\(old\.alias\) !== aliasBase/.test(src),
     '写新中文名前删掉基础名不同的旧 bgm 别名');
  ok(/清掉 \$\{stale\.length\} 条历史遗留的污染别名/.test(src),
     '每次开跑先自愈一遍历史遗留的污染别名');

  // 判据要和脚本里的 aliasBase 一致 —— 季数标记可能在标题中间
  // （「无职转生 第三季 ～到了异世界就拿出真本事～」），只做前缀比对会假失败
  const SEASON_MARK = /\s*第\s*(?:[0-9]+|[一二三四五六七八九十])\s*(?:季|期|部分|部|幕|章)\s*|\s*(?:season|part|cour)\s*[0-9ivx]+\s*/gi;
  const aliasBase = (x) => String(x ?? '').replace(SEASON_MARK, '').replace(/\s+/g, '').trim();
  const polluted = db.prepare(`SELECT al.anime_id id, al.alias, a.title_cn cn
    FROM anime_alias al JOIN anime a ON a.id = al.anime_id WHERE al.src = 'bgm'`).all()
    .filter((r) => aliasBase(r.alias) !== aliasBase(r.cn));
  ok(polluted.length === 0, 'bgm 别名不会和中文名互不沾边（只差季数标记算正常）',
     polluted.slice(0, 3).map((r) => `${r.id}「${r.alias}」vs「${r.cn}」`).join(' · '));
}

console.log('\n━━━ 14v2. 「评分」和「Bangumi 排名」合并成一个选项 ━━━');
{
  /**
   * 主人问「人气 / 评分 / Bangumi 排名 什么区别」，查下来后两个几乎是同一个东西：
   * 同一批 2023 年 TV 番前 6 名完全相同；按 rank 排时相邻的分数逆序只有 4%、
   * 没有一次差超过 0.3 分。让用户理解两个概念是多余的，合成一个「评分」。
   *
   * 底层用 rank 而不是分数（反直觉，查数据才定的）：已进榜条目票数最低 51 票，
   * 若按分数排，51 票的高分会挤掉 36,000 票的 —— 那正是原来「≥300 票」门槛
   * 要防的小样本污染。rank 本身加权过，不需要魔法常数。
   */
  const { SORT_OPTS, SEASON_SORT_OPTS } = await import('../src/lib/constants.js');
  const labels = SORT_OPTS.map(([, l]) => l);
  ok(!labels.includes('Bangumi 排名'), '排序选项里不再有「Bangumi 排名」', labels.join(' · '));
  ok(labels.includes('评分'), '「评分」还在', labels.join(' · '));
  ok(SORT_OPTS.some(([v]) => v === 'score') && !SORT_OPTS.some(([v]) => v === 'scoreSafe'),
     '键统一成 score，scoreSafe 已移除');
  // 季度浏览是同一份选项去掉最新/最早（块内同年同季，按时间排是空操作）
  ok(SEASON_SORT_OPTS.length === SORT_OPTS.length - 2, '季度浏览是同一份的子集',
     `${SEASON_SORT_OPTS.length} vs ${SORT_OPTS.length}`);

  const { listAnime } = await import('../src/lib/server/queries/catalog.js');
  const rows = listAnime({ types: ['TV'], jpOnly: true, rankedOnly: true },
                         { limit: 25, sort: 'score' }).rows;
  ok(rows.length > 5, '「评分」排序有结果', `${rows.length} 条`);
  // rank=0（未进榜）不能顶到榜首
  ok(rows.every((r) => r.bgm_rank > 0), '未进榜的不会排在前面');
  const ranks = rows.map((r) => r.bgm_rank);
  ok(ranks.every((v, i) => i === 0 || ranks[i - 1] <= v), '按榜位升序', ranks.slice(0, 8).join(' '));
  // 覆盖面必须比原来的「票数≥300」大
  const byRank = db.prepare('SELECT count(*) c FROM anime WHERE is_stub=0 AND bgm_rank > 0').get().c;
  const byVotes = db.prepare('SELECT count(*) c FROM anime WHERE is_stub=0 AND bgm_votes >= 300').get().c;
  ok(byRank > byVotes, '可排序的条目比原来多', `榜位 ${byRank} > 票数≥300 ${byVotes}`);
}

console.log('\n━━━ 14z. 发布后旧标签页必须整页重载 ━━━');
{
  /**
   * 实测事故：主人有个标签页在发布前就开着，发布后点侧栏「设置」，
   * URL 变成 /settings、侧栏高亮也对，渲染出来的却是首页（标签标题是「首页」）。
   * 成因：SvelteKit 客户端路由靠 __data.json 里的 node 索引装配页面，
   * 浏览器缓存里那份旧 app.js 的索引表和发布后服务端返回的索引对不上。
   * 服务端直连是对的 —— 只有客户端跳转会错，所以 HTTP 层测不出渲染错误，
   * 只能守住「机制装上了」。
   */
  /**
   * 页面 HTML 绝不能被浏览器「不问就用缓存」—— SSR 出来的 HTML 里嵌着
   * 带哈希的资源名，发布后那批文件就删了，缓存的旧 HTML 去拉不存在的 chunk
   * 会让水合炸掉（实测：主人点侧栏「设置」，标题对了但整页空白；
   * 同一个产物在无头 Chrome 里水合完全正常 —— DOM 从 18,268 涨到 22,105 字节、
   * 各区块都在，所以不是代码问题，是响应头少了 cache-control）。
   */
  for (const path of ['/settings', '/catalog', '/']) {
    const r = await head(path);
    ok(/no-cache|no-store/.test(r.cache ?? ''), `${path} 的 HTML 禁止直接用缓存`,
       r.cache ?? '(没有 cache-control)');
  }
  {
    const r = await head('/settings/__data.json?x-sveltekit-invalidated=01');
    ok(/no-cache|no-store/.test(r.cache ?? ''), '__data.json 同样禁止', r.cache ?? '(没有)');
  }

  // 下面两条只在打构建产物时成立：vite dev 既不生成 version.json 也不发 immutable 头
  if (process.env.TEST_BUILD) {
    const v = await get('/_app/version.json');
    ok(v.status === 200, '/_app/version.json 可访问（客户端靠它比对版本）', String(v.status));
    ok(/"version"\s*:/.test(v.html), '返回里带 version 字段', v.html.slice(0, 60));
    // immutable 资源相反：文件名带哈希，必须能长期缓存，不能被上面那条误伤
    const asset = (await get('/settings')).html
      .match(/\/_app\/immutable\/entry\/app\.[A-Za-z0-9_-]+\.js/)?.[0];
    const r = asset ? await head(asset) : { cache: '' };
    ok(/immutable/.test(r.cache ?? ''), 'immutable 资源仍然长期缓存', r.cache ?? '(没有)');
  }

  const cfg = readFileSync2('svelte.config.js', 'utf8');
  ok(/version:\s*\{[^}]*pollInterval/.test(cfg), 'svelte.config.js 开了版本轮询');

  // 先剥注释 —— 解释这条规则的注释本身就写着 location.reload()，会把自己测挂
  const lay = readFileSync2('src/routes/+layout.svelte', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*/gm, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  ok(/beforeNavigate/.test(lay) && /updated\.current/.test(lay),
     '根布局在版本变化后把跳转降级成整页加载');
  /**
   * 侧栏主导航必须走整页跳转。
   * 主人两次报同一个故障：点侧栏「设置」，URL 和高亮都切了，内容还是跳转前那一页
   * （一次首页、一次排行榜），刷新才对。服务端和产物都验过是健康的
   * （路由表对得上 leaf、leaf chunk 连同 16 个依赖全 200），坏的是那个标签页里
   * 跑着的旧客户端代码。让顶层导航不依赖客户端路由，这类故障就不可能发生，
   * 旧标签页第一次点侧栏还会自动拿到新代码。
   * 页内的筛选/翻页/搜索仍然是客户端路由 —— 那些是高频操作，不能变成整页刷新。
   */
  ok(/data-sveltekit-reload/.test(lay), '侧栏主导航走整页跳转（不依赖客户端路由）');
  const nav = await get('/');
  // 只看侧栏（<aside>）里的：2026-10 起手机底部标签栏（<nav aria-label="主导航">）也走整页跳转，那是同一批入口的子集
  const aside = nav.html.slice(nav.html.indexOf('<aside'), nav.html.indexOf('</aside>'));
  const navLinks = [...aside.matchAll(/<a[^>]*href="(\/[a-z]*)"[^>]*data-sveltekit-reload/g)]
    .map((m) => m[1]);
  const tabLinks = [...nav.html.slice(nav.html.indexOf('aria-label="主导航"')).matchAll(/<a[^>]*href="(\/[a-z]*)"[^>]*data-sveltekit-reload/g)]
    .map((m) => m[1]);
  ok(tabLinks.join(' ') === '/ /catalog /schedule /mine', '手机底部标签栏：首页 / 目录 / 放送表 / 番单，也走整页跳转', tabLinks.join(' '));
  ok(navLinks.length >= 9, '九个侧栏入口都带 data-sveltekit-reload',
     `${navLinks.length} 个：${navLinks.join(' ')}`);
  /**
   * 侧栏顺序（主人定的）：浏览类在前、个人记录类在后、设置垫底。
   * 顺序写死在断言里 —— 它是主人明确排过的，不该被后来的改动悄悄打乱。
   */
  const want = ['/', '/catalog', '/schedule', '/seasons', '/ranking',
                '/triage', '/mine', '/stats', '/settings'];
  ok(navLinks.join(' ') === want.join(' '), '侧栏顺序和主人定的一致',
     navLinks.join(' '));
  // 页内导航不能被一起改成整页刷新
  const cat = await get('/catalog');
  // 侧栏 9 + 账号 1 + 底部标签栏 4 = 14 是外壳的；页内链接不该再加
  const inPage = (cat.html.match(/data-sveltekit-reload/g) ?? []).length;
  ok(inPage <= 16, '整页跳转只用在侧栏，页内链接不受影响', `${inPage} 处`);
  ok(!/location\.reload\(\)/.test(lay),
     '不主动 reload（会在主人正看页面时突然刷掉），只降级下一次跳转');
}

console.log('\n━━━ 14y. 侧栏和统计页的数字必须同源 ━━━');
{
  /**
   * 主人对着截图问：番单总数 333、看过 330 部、侧栏看完 326、
   * 侧栏累计 4389 集、统计页看过集数 4359 —— 为什么都不一样。
   *
   * 前三个是三个不同定义，都对：
   *   番单总数 = 全部记录；看过 N 部 = 全部 - 想看；侧栏看完 = 只 completed
   * 但两个集数不一致是真 bug：侧栏自己写了一套 SQL，
   * 只算「看完+在看」（漏掉弃番/搁置），而且对「在看」也按总集数补 ——
   * 三部没填进度的在看番（12+6+12 集）凭空多出 30 集。
   * 口径抽成 queries/stats.js 的 WATCHED / WATCHED_EPS，两处共用。
   */
  const { myStats } = await import('../src/lib/server/queries/user.js');
  const { stats } = await import('../src/lib/server/queries/stats.js');
  const m = myStats(), st = stats();
  ok(m.episodes === st.episodes, '侧栏「累计集数」和统计页「看过集数」是同一个数',
     `侧栏 ${m.episodes} / 统计页 ${st.episodes}`);
  ok(m.total === st.total, '两处「番单总数」一致', `${m.total} / ${st.total}`);
  // 三个部数的关系必须成立，否则说明某处口径又漂了
  ok(st.watchedCount === st.total - (st.byStatus.plan ?? 0),
     '看过 N 部 = 番单总数 - 想看', `${st.watchedCount} = ${st.total} - ${st.byStatus.plan ?? 0}`);
  ok((m.completed ?? 0) <= st.watchedCount, '侧栏「看完」不多于「看过」',
     `${m.completed} <= ${st.watchedCount}`);

  /**
   * 在看但没填进度的番，一集都不该算进「已看集数」——
   * 否则一部 24 集的在看会被当成全看完。
   */
  const a = db.prepare(`SELECT id FROM anime WHERE is_stub=0 AND coalesce(episodes,0) >= 12 LIMIT 1`).get().id;
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');
  db.prepare(`INSERT INTO user_entry (anime_id,status,current_episode,updated_at)
    VALUES (?, 'watching', NULL, datetime('now'))`).run(a);
  ok(myStats().episodes === 0, '在看且未填进度 → 计 0 集', String(myStats().episodes));
  ok(stats().episodes === 0, '统计页同样计 0 集', String(stats().episodes));
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');
}

console.log('\n━━━ 14d. 番单：空分类也要有搜索栏和完整筛选栏 ━━━');
{
  for (const st of ['plan', 'on_hold', 'active']) {
    const r = await get(`/mine?status=${st}`);
    // 2026-10 UI 大改：「排序」挪到了网格标题右侧（手机上筛选栏因此一行放得下），
    // 列表为空时没有网格也就没有排序 —— 空列表排序没有意义；能改变结果的五个控件必须都在
    const missing = ['在此分类中搜索', '类型', '题材', '年份', '评分']
      .filter((x) => !r.html.includes(x));
    ok(missing.length === 0, `?status=${st} 五个筛选控件都在`, missing.join('/'));
  }
  const plan = await get('/mine?status=plan');
  // 2026-10-21：空态出口按页签给 —— 快速标记只会标「看过」，「想看」的出口是去目录挑；搁置 / 弃番不放按钮
  ok(plan.html.includes('还没有想看的番') && plan.html.includes('去目录') && !plan.html.includes('去快速标记'), '空态提示仍在（想看 → 去目录）');
  const hold = await get('/mine?status=on_hold');
  ok(hold.html.includes('没有搁置的番') && !hold.html.includes('去快速标记'), '搁置为空不再挂「去快速标记」');
  const all = await get('/mine?status=active');
  ok(all.html.includes('番单还是空的') && all.html.includes('去快速标记'), '全部为空仍给「去快速标记」');
}

console.log('\n━━━ 15d. 建库能跑通（脚本路径的覆盖缺口）━━━');
{
  // 之前删「死代码」时把 db.js 的 __dirname 删了，而 initSchema 还用它读 schema.sql。
  // 全套 358 条断言一条没红 —— 因为 initSchema 只有脚本会调，HTTP 测试根本碰不到。
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { initSchema } = await import('../src/lib/server/db.js');

  const dir = mkdtempSync(join(tmpdir(), 'j-anime-schema-'));
  try {
    const fresh = new DatabaseSync(join(dir, 'new.db'));
    initSchema(fresh);
    const tables = fresh.prepare(
      `SELECT name FROM sqlite_master WHERE type IN ('table','view')
         AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name);
    ok(tables.length > 10, 'initSchema 能在空库上建表', `${tables.length} 张`);
    for (const t of ['anime', 'anime_alias', 'anime_tag', 'user_entry', 'triage', 'watch_log', 'anime_fts'])
      ok(tables.includes(t), `建出了 ${t}`);
    fresh.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log('\n━━━ 16. NSFW 开关 ━━━');
{
  const { listAnime } = await import('../src/lib/server/queries.js');
  const nsfw = db.prepare('SELECT count(*) c FROM anime WHERE is_nsfw=1').get().c;
  ok(nsfw > 0 && nsfw < 3000, 'NSFW 标记量合理（只认 hentai/18 restricted）', `${nsfw} 条`);
  // ⚠️ 断言口径修正：不能简单假设「成人内容不会是高人气 TV 番」——
  // 《回复术士的重来人生》就是内容露骨的高人气 TV 番，标记它是正确的。
  // 真正要守的是：曾被前两版判定误伤的那批主流番，不能再被标记。
  const MUST_NOT_FLAG = ['无职转生', '游戏人生', '刀剑神域', '斩服少女',
                         '为美好的世界献上祝福', '孤独摇滚', '葬送的芙莉莲'];
  const flagged = db.prepare(`SELECT coalesce(title_cn, title) t FROM anime
    WHERE is_nsfw = 1 AND title_cn IS NOT NULL`).all().map((r) => r.t);
  const bad = MUST_NOT_FLAG.filter((n) => flagged.some((t) => t.includes(n)));
  ok(bad.length === 0, '⚠️ 关键：主流番不再被误标为成人内容', bad.join(' / '));
  const tvFlagged = db.prepare(`SELECT count(*) c FROM anime
    WHERE is_nsfw=1 AND type='TV'`).get().c;
  // Bangumi 的 nsfw 标记会标出一批成人向 TV 短片（comic-fesTA 那类，#2），数量比只靠 AOD 标签时多；
  // 守的是量级不失控、而且 bgm 标出来的都不是热门番
  ok(tvFlagged <= 60, 'TV 番被标记的数量仍然很少（成人内容以 OVA 为主）', `${tvFlagged} 部`);
  const hotBgm = db.prepare(`SELECT coalesce(title_cn,title) t FROM anime
    WHERE is_nsfw=1 AND type='TV' AND bgm_nsfw=1 AND bgm_collection > 5000`).all().map((r) => r.t);
  ok(hotBgm.length === 0, 'Bangumi nsfw 标记没有标到热门 TV 番', hotBgm.join(' / '));
  const off = listAnime({ types: ['OVA'], jpOnly: true, requireYear: true }, { limit: 1 }).total;
  const on = listAnime({ types: ['OVA'], jpOnly: true, requireYear: true, hideNsfw: true }, { limit: 1 }).total;
  ok(on < off, '开关能过滤掉内容', `${off} → ${on}`);
  await post('/api/settings', { key: 'hide_nsfw', value: true });
  const c1 = await get('/catalog?type=OVA');
  await post('/api/settings', { key: 'hide_nsfw', value: false });
  const c2 = await get('/catalog?type=OVA');
  const n = (h) => +(h.match(/([\d,]+) 部/)?.[1]?.replace(/,/g, '') ?? 0);
  ok(n(c1.html) < n(c2.html), '设置真的改变目录页输出', `${n(c1.html)} vs ${n(c2.html)}`);
  const badKey = await post('/api/settings', { key: 'evil', value: 1 });
  ok(badKey.status === 400, '拒绝未知设置项');
  const { triageQueue } = await import('../src/lib/server/queries.js');
  ok(triageQueue({ limit: 40 }).every((a) => !a.is_nsfw), '快速标记队列永不出成人内容');
}

console.log('\n━━━ 17. 系列聚合 / 总集篇可跳过 / 手动关联 ━━━');
{
  const fc = db.prepare('SELECT count(*) c FROM franchise').get().c;
  const fm = db.prepare('SELECT count(*) c FROM franchise_member').get().c;
  ok(fc > 1000, '系列已分组', `${fc} 个系列 / ${fm} 部归入`);
  const biggest = db.prepare('SELECT max(size) m FROM franchise').get().m;
  ok(biggest < 200, '⚠️ 关键：没有超大误合并系列（曾出现 5723 部的连通分量）', `最大 ${biggest} 部`);
  const skip = db.prepare('SELECT count(*) c FROM franchise_member WHERE is_skippable=1').get().c;
  ok(skip > 50, '总集篇已标为可跳过', `${skip} 部`);

  const withF = db.prepare(`SELECT anime_id FROM franchise_member fm
    JOIN franchise f ON f.id=fm.franchise_id WHERE f.size BETWEEN 3 AND 12 LIMIT 1`).get();
  const d = await get(`/anime/${withF.anime_id}?tab=series`);
  ok(noErr(d.html) && d.html.includes('同系列'), '详情页「同系列」tab（?tab=series 服务端直出）');
  ok(d.html.includes('播出顺序'), '说明了顺序口径');
  ok(d.html.includes('已看完'), '有系列进度汇总');
  // 2026-10 UI 大改：序号按显示出来的条目连续编（藏起可跳过的之后原来是 1、2、6 跳号）
  const sk = db.prepare(`SELECT fm.anime_id id FROM franchise_member fm WHERE fm.is_skippable = 0 AND fm.franchise_id IN
    (SELECT franchise_id FROM franchise_member WHERE is_skippable = 1) LIMIT 1`).get();
  if (sk) {
    const nums = [...(await get(`/anime/${sk.id}?tab=series`)).html.matchAll(/w-6 shrink-0[^>]*>(\d+)</g)].map((m) => +m[1]);
    ok(nums.length > 0 && nums.every((n, i) => n === i + 1), '同系列序号连续（藏起可跳过的也不跳号）', nums.join(','));
  } else console.log('  ⏭️  跳过：库里没有带可跳过条目的系列');   // 这一段的 skip 被上面的计数变量遮住了
  // 简介：[简介原文] 之后切进折叠的「原文」，正文默认三行
  const orig = db.prepare(`SELECT id FROM anime WHERE is_stub = 0 AND instr(bgm_summary, '[简介原文]') > 20 LIMIT 1`).get();
  if (orig) {
    // 去掉水合数据（<script> 里带着整段原始简介）只看渲染出来的
    const h = (await get(`/anime/${orig.id}`)).html.replace(/<script[\s\S]*?<\/script>/g, '');
    ok(!h.includes('[简介原文]') && /<summary[^>]*>\s*原文/.test(h) && h.includes('line-clamp-3'), '简介原文收进折叠、正文三行');
  } else console.log('  ⏭️  跳过：库里没有带原文的简介');   // 这一段的 skip 被上面的计数变量遮住了
  // 详情页头部清晰版封面：没有 Bangumi 条目时回退普通封面，但不给 immutable（以后可能补上清晰版）
  const noBgm = db.prepare(`SELECT id FROM anime WHERE bgm_id IS NULL AND cover_local_path IS NOT NULL AND cover_dead = 0 LIMIT 1`).get();
  if (noBgm) {
    const r = await fetch(`${BASE}/cover/${noBgm.id}?hd=1`, { headers: { cookie: `j_anime_sid=${SESSION}` } });
    ok(r.status === 200 && (r.headers.get('content-type') ?? '').startsWith('image/') && !/immutable/.test(r.headers.get('cache-control') ?? ''),
       '?hd=1 没有清晰版时回退普通封面、不永久缓存', `${r.status} ${r.headers.get('cache-control')}`);
  } else console.log('  ⏭️  跳过：库里没有无 Bangumi 条目且已缓存封面的番');   // 这一段的 skip 被上面的计数变量遮住了

  const [a, b] = db.prepare('SELECT id FROM anime WHERE is_stub=0 LIMIT 2').all().map((r) => r.id);
  let lr = await post('/api/relation', { id: a, op: 'link', other: b });
  ok(lr.data.ok, '手动关联成功');
  const { manualLinks } = await import('../src/lib/server/queries.js');
  ok(manualLinks(a).some((x) => x.id === b), '关联双向可查');
  lr = await post('/api/relation', { id: a, op: 'link', other: a });
  ok(lr.status === 400, '拒绝和自己关联');
  await post('/api/relation', { id: a, op: 'unlink', other: b });
  ok(manualLinks(a).length === 0, '解除关联生效');
}

console.log('\n━━━ 17b. 手动调序（自动排的是播出顺序，但有些系列的官方推荐顺序不同）━━━');
{
  const { getAnime, moveInSeries, resetSeriesOrder } = await import('../src/lib/server/queries.js');
  const f = db.prepare(`SELECT fm.anime_id FROM franchise_member fm
    JOIN franchise fr ON fr.id = fm.franchise_id
    WHERE fr.size BETWEEN 3 AND 8 ORDER BY fm.release_order LIMIT 1`).get();
  const before = getAnime(f.anime_id).related.map((r) => r.id);
  ok(before.length >= 3, '拿到一个 3-8 部的系列', `${before.length} 部`);

  const second = before[1];
  ok(moveInSeries(second, 'up') === true, '第 2 部上移成功');
  const after = getAnime(f.anime_id).related.map((r) => r.id);
  ok(after[0] === second, '顺序真的变了', `${before[0]}→${after[0]}`);
  ok(getAnime(f.anime_id).hasCustomOrder === true, '标记为「已手动调序」');

  ok(moveInSeries(after[0], 'up') === false, '第 1 部再上移应无效');
  const r = await post('/api/order', { id: second, op: 'down' });
  ok(r.data.ok, 'API 下移成功');
  ok(getAnime(f.anime_id).related.map((x) => x.id)[1] === second, '下移回到第 2 位');

  resetSeriesOrder(second);
  ok(JSON.stringify(getAnime(f.anime_id).related.map((x) => x.id)) === JSON.stringify(before),
     '恢复播出顺序后与自动排序一致');
  ok(getAnime(f.anime_id).hasCustomOrder === false, '自定义标记已清除');
  const bad = await post('/api/order', { id: 99999999, op: 'up' });
  ok(bad.status === 400, '不在任何系列里的条目返回 400');

  // 月度同步会整表重建系列 —— 手排的顺序必须挺过去（曾被清空回播出顺序）
  const { mergeUserOrder } = await import('../src/lib/server/seriesOrder.js');
  const m = mergeUserOrder([1, 2, 3, 4], new Map([[3, 1], [1, 2], [2, 3]]));
  // 播出顺序 1,2,3,4；手排成 3,1,2；新来的 4 在播出顺序上紧跟 3 → 插在 3 后面
  ok(JSON.stringify([...m.keys()]) === '[3,4,1,2]', '新成员插在播出顺序上前一部的后面', JSON.stringify([...m.keys()]));
  const m2 = mergeUserOrder([5, 1, 2], new Map([[2, 1], [1, 2]]));
  ok(JSON.stringify([...m2.keys()]) === '[5,2,1]', '新成员排在最前时放最前', JSON.stringify([...m2.keys()]));
  ok(mergeUserOrder([1, 2], new Map()) === null, '没手排过的系列不写 user_order');

  moveInSeries(second, 'up');
  const custom = getAnime(f.anime_id).related.map((x) => x.id);
  const { spawnSync } = await import('node:child_process');
  const rb = spawnSync(process.execPath, ['scripts/build-franchise.js'], { env: process.env, encoding: 'utf8' });
  ok(rb.status === 0, '重建系列脚本跑通', rb.stderr.slice(-300));
  const rebuilt = getAnime(f.anime_id).related.map((x) => x.id);
  ok(JSON.stringify(rebuilt) === JSON.stringify(custom), '重建后手排顺序还在', `${custom} → ${rebuilt}`);
  ok(getAnime(f.anime_id).hasCustomOrder === true, '重建后仍标记为「已手动调序」');
  resetSeriesOrder(second);
}

console.log('\n━━━ 18. 保存筛选 / 分享链接（「我的标签」2026-10-18 下线）━━━');
{
  const gone = await post('/api/relation', { id: 1, op: 'tag', tag: 'x' });
  ok(gone.status === 400, '打标签的接口已下线');
  ok(!(await get('/settings')).html.includes('我的标签'), '设置页不再有「我的标签」');
  db.exec('DELETE FROM saved_filter');   // 隔离：断言用的是绝对数量，先清干净
  let f = await post('/api/filters', { name: '周末刷完', query: 'type=TV&epmax=13&status=FINISHED' });
  ok(f.data.ok && f.data.filters.length === 1, '保存筛选组合');
  const st = await get('/settings');
  ok(st.html.includes('周末刷完'), '设置页能看到保存的筛选');
  await post('/api/filters', { op: 'del', id: f.data.filters[0].id });
  const { listFilters } = await import('../src/lib/server/queries.js');
  ok(listFilters().length === 0, '删除筛选生效');
  f = await post('/api/filters', { name: '  ' });
  ok(f.status === 400, '拒绝空名字');

  const sh = await post('/api/share', { op: 'create' });
  ok(!!sh.data.token, '生成分享链接');
  const okPage = await get(`/share/${sh.data.token}`);
  ok(okPage.status === 200 && okPage.html.includes('只读'), '凭链接可访问且标明只读');
  const badPage = await get('/share/definitely-not-the-token');
  ok(badPage.status === 404, '错误 token 返回 404');
  await post('/api/share', { op: 'revoke' });
  const revoked = await get(`/share/${sh.data.token}`);
  ok(revoked.status === 404, '撤销后链接失效');
}

console.log('\n━━━ 18b. 观看站（主人自配的跳转模板）━━━');
{
  const { watchUrl, isValidTemplate } = await import('../src/lib/watchSite.js');
  const { listWatchSites, addWatchSite, delWatchSite, toggleWatchSite, moveWatchSite } =
    await import('../src/lib/server/queries.js');

  const A = { title: 'Nageki no Bourei wa Intai shitai',
              title_ja: '嘆きの亡霊は引退したい', title_cn: '叹气的亡灵想隐退' };
  // 占位符要替换 + URL 编码。番名里的空格/冒号/句号不编码会把 query string 截断
  ok(watchUrl('https://x.test/s?q={cn}', A) === `https://x.test/s?q=${encodeURIComponent(A.title_cn)}`,
     '{cn} 替换成中文名并编码');
  ok(watchUrl('https://x.test/s?q={ja}', A) === `https://x.test/s?q=${encodeURIComponent(A.title_ja)}`,
     '{ja} 替换成日文原名');
  ok(watchUrl('https://x.test/s?q={romaji}', A).includes('Nageki%20no'), '{romaji} 的空格被编码');
  // 中文名只有 54.6% 的番有 —— {cn} 不回退的话那 45% 点过去是空搜索
  ok(watchUrl('https://x.test/s?q={cn}', { ...A, title_cn: null }).includes('Nageki'),
     '{cn} 在没有中文名时回退到罗马字');
  // href 里能塞 javascript: 就是 XSS，模板必须只收 http(s)
  for (const bad of ['javascript:alert(1)', '//evil.test/?q={cn}', 'data:text/html,x', 'ftp://a.test'])
    ok(watchUrl(bad, A) === null && !isValidTemplate(bad), `拒掉非 http(s) 模板：${bad.slice(0, 20)}`);

  // 增删改查
  const before = listWatchSites().length;
  ok(!!addWatchSite('测试站甲', 'https://a.test/s?q={cn}').ok, '能添加');
  ok(!!addWatchSite('测试站乙', 'https://b.test/s?q={ja}').ok, '能添加第二个');
  ok(addWatchSite('', 'https://a.test').error, '名字为空要报错');
  ok(addWatchSite('x', 'javascript:alert(1)').error, '非法网址要报错');
  let list = listWatchSites();
  ok(list.length === before + 2, '列表里有两条', `${list.length} 条`);
  const [x, y] = list.slice(-2);
  ok(x.name === '测试站甲' && x.ord < y.ord, '新加的排在后面、按 ord 排序');
  moveWatchSite(y.id, 'up');
  ok(listWatchSites().find((r) => r.id === y.id).ord < listWatchSites().find((r) => r.id === x.id).ord,
     '上移会和相邻那条交换 ord');
  toggleWatchSite(x.id, 0);
  ok(listWatchSites(true).every((r) => r.id !== x.id), '停用后详情页那份列表里没有它');
  ok(listWatchSites().some((r) => r.id === x.id), '停用不等于删除');
  delWatchSite(x.id); delWatchSite(y.id);
  ok(listWatchSites().length === before, '删干净了');

  // 详情页：外站链接必须带 noopener —— 否则对方能通过 window.opener 改写这个标签页
  // 外站搜索按钮从详情页右上角挪进了观看页最下面（「去原站搜」）；2026-10-20 片源面板拆成 SourcePanel.svelte
  const src = readFileSync2('src/lib/ui/SourcePanel.svelte', 'utf8');
  ok(/watchLinks as w/.test(src), '观看页渲染观看站按钮');
  const seg = src.slice(src.indexOf('watchLinks as w'), src.indexOf('watchLinks as w') + 500);
  ok(/rel="noopener noreferrer"/.test(seg), '观看站链接带 rel="noopener noreferrer"');
  ok(/target="_blank"/.test(seg), '观看站链接在新标签页打开');
  // 只生成链接、不代抓：服务端不许对这些网址发请求
  const q = readFileSync2('src/lib/server/queries/watchSite.js', 'utf8');
  ok(!/fetch\(/.test(q), '观看站的服务端代码不发任何请求（只存模板）');

  /**
   * 观看站是主人自己填的 → 必须在 staging.js 的 PERSONAL 里，否则不带
   * --with-my-data 重建测试站时它不会被清空，测试站拿到的不是白纸。
   * 同一个清单还漏过 manual_relation（手动关联的系列），一起盯住。
   */
  const stg = readFileSync2('scripts/staging.js', 'utf8');
  const pers = stg.slice(stg.indexOf('const PERSONAL'), stg.indexOf('const PERSONAL') + 300);
  for (const t of ['watch_site', 'manual_relation', 'user_tag', 'saved_filter', 'user_entry'])
    ok(pers.includes(`'${t}'`), `staging.js 的 PERSONAL 含 ${t}`);

  // 编辑：校验和添加同一套，编辑不该比添加宽松
  const { updateWatchSite } = await import('../src/lib/server/queries.js');
  addWatchSite('待改名', 'https://old.test/s?q={cn}');
  const ed = listWatchSites().at(-1);
  ok(!!updateWatchSite(ed.id, '改过了', 'https://new.test/s?q={ja}').ok, '能改名字和网址');
  const after = listWatchSites().find((r) => r.id === ed.id);
  ok(after.name === '改过了' && after.url === 'https://new.test/s?q={ja}', '改动落库了');
  ok(updateWatchSite(ed.id, '', 'https://new.test').error, '编辑时名字为空要报错');
  ok(updateWatchSite(ed.id, 'x', 'javascript:alert(1)').error, '编辑时非法网址要报错');
  ok(listWatchSites().find((r) => r.id === ed.id).url === 'https://new.test/s?q={ja}',
     '校验失败不写库');
  delWatchSite(ed.id);
  {
    const src = readFileSync2('src/lib/ui/WatchSites.svelte', 'utf8');
    ok(/editId === w\.id/.test(src), '有行内编辑');
    // 输入栏要在列表【上面】：新加一条是最常做的操作
    ok(src.indexOf('placeholder="站点名字"') < src.indexOf('sites as w'),
       '添加输入栏排在已有列表之前');
    // 常驻的说明文案不写进界面 —— 要解释就放 InfoTip（鼠标移入才出现）
    ok(!src.includes('无占位符，只会打开首页'), '不常驻显示「无占位符」那句说明');
    ok(readFileSync2('src/routes/settings/+page.svelte', 'utf8').includes('<WatchSites'),
       '设置页用的是抽出来的组件');
  }
}

console.log('\n━━━ 19. UI 一致性 / 组件化 ━━━');
{
  const { readFileSync, readdirSync } = await import('node:fs');
  const walk = (d) => readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
  const files = walk('src').filter((f) => f.endsWith('.svelte'));
  // 剥注释：Select.svelte 的注释里就写着「不用原生 <select>」，不剥会把自己测挂
  const nativeSelect = files.filter((f) => /<select[\s>]/.test(
    readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ')));
  ok(nativeSelect.length === 0, '没有原生 <select>（统一用自建 Select 组件）', nativeSelect.join(' '));

  // 常量只有一处定义
  const jsFiles = walk('src').filter((f) => f.endsWith('.js') || f.endsWith('.svelte'));
  for (const key of ['TYPE_CN =', 'WATCH_STATUS =', 'SEASON_CN =', 'STATUS_CN =']) {
    const defs = jsFiles.filter((f) => readFileSync(f, 'utf8').includes(`export const ${key}`));
    ok(defs.length === 1, `${key.replace(' =', '')} 只定义一次`, defs.join(' '));
  }
  const { GENRE_NAMES } = await import('../src/lib/genres.js');
  ok(GENRE_NAMES.length >= 50, '题材已扩充', `${GENRE_NAMES.length} 个`);
  for (const g of ['后宫', '校园', '爱情', '热血', '竞技', '百合', '耽美', '美少女', '乙女向', '武侠', '机战', '职场'])
    ok(GENRE_NAMES.includes(g), `有「${g}」题材`);

  // 目录页与季度浏览的类型筛选用同一套标签
  const cat = await get('/catalog');
  const sea = await get('/seasons');
  ok(cat.html.includes('类型') && sea.html.includes('类型'), '两页的类型筛选都带标签（一致性）');

  const mf = await get('/manifest.webmanifest');
  ok(mf.status === 200 && mf.html.includes('j-anime'), 'PWA manifest 可访问');
}

console.log('\n━━━ 19b. 离线兜底（#53）━━━');
{
  // 行为（断网 / 站点连不上时显示上次的页面、没缓存过的给离线页、登出清缓存）由 Playwright 在测试站实测；这里钉住几条不能退的规矩
  const sw = readFileSync2('src/service-worker.js', 'utf8');
  ok(/pathname\.startsWith\('\/api\/'\)\) return/.test(sw), '#53 service worker 不碰 /api/*（个人数据、片源、视频流）');
  ok(/pages-\$\{version\}/.test(sw) && /shell-\$\{version\}/.test(sw), '#53 页面缓存和外壳缓存都跟构建版本走（旧 HTML 配新外壳会白屏）');
  ok(/res\.status >= 502 && res\.status <= 504/.test(sw), '#53 网关错误（家里电脑关机）也走离线兜底');
  ok(/clearPageCache\(\)/.test(readFileSync2('src/lib/auth.svelte.js', 'utf8')), '#53 登录 / 登出清页面缓存（离线也看不到上一个人的番单）');
  ok((await fetch(BASE + '/offline.html', { anon: true })).status === 200, '#53 离线页能取到');
}

console.log('\n━━━ 20. 体检批次（ec）━━━');
{
  // SEC1 #36：登录后跳回只放行站内路径
  const { safeNext } = await import('../src/lib/server/auth.js');
  const evil = ['//evil.com', '/\\evil.com', '/\t/evil.com', 'https://evil.com', '\\\\evil.com', 'javascript:alert(1)'];
  ok(evil.every((t) => safeNext(t) === '/'), 'SEC1 站外地址一律回首页',
     JSON.stringify(evil.map((t) => [t, safeNext(t)]).filter(([, v]) => v !== '/')));
  ok(safeNext('/catalog?type=TV&p=2#x') === '/catalog?type=TV&p=2#x' && safeNext(null) === '/',
     'SEC1 站内路径原样保留');
}

{
  // FB5 #31：非法 season 参数回到当季，不能 500
  for (const q of ['season=foo', 'season=winter', 'season=']) {
    const r = await get(`/seasons?${q}`);
    ok(r.status === 200 && noErr(r.html), `FB5 /seasons?${q} 不报错`, `得到 ${r.status}`);
  }
}

{
  // FB6 #32：筛选后超出页码要夹到实际最后一页，不能是空页 + 「5/2」
  const r = await get('/ranking?type=MOVIE&decade=2010&p=99');
  const m = r.html.replace(/<!--[^>]*-->/g, '').match(/第 (\d+)\/(\d+) 页/);
  ok(m && m[1] === m[2] && cards(r.html) > 0, 'FB6 排行榜超页码夹到最后一页且有内容',
     `页头 ${m?.[0]}，卡片 ${cards(r.html)}`);
}

{
  // FB7 #33：坏图状态要跟着地址走 —— 同一路由内换番组件不重建，布尔 $state 会把上一部的坏图带过去
  const cov = readFileSync2('src/lib/Cover.svelte', 'utf8');
  ok(!/let\s+broken\s*=\s*\$state\(/.test(cov) && /brokenSrc\s*===\s*src/.test(cov),
     'FB7 Cover 的坏图判定按 src 比对，不是一次性布尔');
}

{
  // FB9 #35 → 多账号（2026-10-19）改了语义：401 不再跳登录页，而是弹登录框、登录成功后原样重发。
  // api.js 依赖 $app（SvelteKit 运行时），node 里跑不起来 —— 行为由 Playwright 实测，这里钉住实现
  const api = readFileSync2('src/lib/api.js', 'utf8');
  ok(/status === 401 && !retried/.test(api) && /requireLogin\(\)\) return post\(url, body, true\)/.test(api),
     'FB9 401 → 弹登录框，登录成功后原样重发一次');
  ok(!api.includes('/login?to='), 'FB9 不再跳独立登录页');
  ok(/if \(!text\?\.cancelled\)/.test(readFileSync2('src/lib/toast.svelte.js', 'utf8')), 'FB9 关掉登录框不弹错误 toast');
}

{
  // FB8 #34：分享页不受显示年份窗口约束，且要分页（原来只取 300 条）
  const { setEntry, setSetting } = await import('../src/lib/server/queries.js');
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');
  const old = q('SELECT id FROM anime WHERE is_stub=0 AND year BETWEEN 1990 AND 1999 ORDER BY bgm_collection DESC LIMIT 1');
  const many = db.prepare(`SELECT id FROM anime WHERE is_stub=0 AND year >= 2015 AND id <> ?
    ORDER BY bgm_collection DESC LIMIT 29`).all(old.id);
  for (const r of [old, ...many]) setEntry(r.id, { status: 'completed' });
  setSetting('year_min', 2015);
  const sh = await post('/api/share', { op: 'create' });
  const p1 = await get(`/share/${sh.data.token}`);
  const p2 = await get(`/share/${sh.data.token}?p=2`);
  const p9 = await get(`/share/${sh.data.token}?p=9`);
  const big = await get(`/share/${sh.data.token}?ps=100`);
  ok(cards(p1.html) === 24 && cards(p2.html) === 6, 'FB8 分享页分页（30 部 → 24 + 6）',
     `${cards(p1.html)} + ${cards(p2.html)}`);
  ok(cards(p9.html) === 6, 'FB8 分享页超页码夹到最后一页', `${cards(p9.html)}`);
  ok(big.html.includes(`href="/anime/${old.id}"`), 'FB8 窗口外的番仍在分享页');
  await post('/api/share', { op: 'revoke' });
  db.exec("DELETE FROM user_setting WHERE key IN ('year_min','year_max'); DELETE FROM user_entry; DELETE FROM watch_log;");
}

{
  // FB3 #29：首页推荐三个来源都要遵守「隐藏 NSFW」、年份窗口、status_eff
  const { setEntry, setSetting, recommend } = await import('../src/lib/server/queries.js');
  db.exec('DELETE FROM user_entry; DELETE FROM triage; DELETE FROM watch_log;');
  // ① 的想看列表里塞 NSFW；② 需要「看过」记录才会跑
  const nsfwPlan = db.prepare(`SELECT id FROM anime WHERE is_stub=0 AND is_nsfw=1 AND episodes BETWEEN 1 AND 26
    AND coalesce(status_eff,status)='FINISHED' AND year BETWEEN 2010 AND 2015 LIMIT 5`).all();
  const seen = db.prepare(`SELECT id FROM anime WHERE is_stub=0 AND is_nsfw=0 AND type='TV' AND year BETWEEN 2010 AND 2015
    ORDER BY bgm_collection DESC LIMIT 15`).all();
  for (const r of nsfwPlan) setEntry(r.id, { status: 'plan' });
  for (const r of seen) setEntry(r.id, { status: 'completed' });
  setSetting('hide_nsfw', '1'); setSetting('year_min', 2010); setSetting('year_max', 2015);
  const rec = recommend(16);
  const meta = rec.map((r) => q('SELECT is_nsfw, year, coalesce(status_eff,status) st FROM anime WHERE id=?', r.id));
  ok(nsfwPlan.length > 0, 'FB3 测试数据里有 NSFW 的想看条目', `${nsfwPlan.length}`);
  ok(rec.length === 16, 'FB3 收紧后推荐仍满 16 条', `${rec.length}`);
  ok(meta.every((m) => m.is_nsfw === 0), 'FB3 隐藏 NSFW 时推荐里没有 NSFW',
     rec.filter((_, i) => meta[i].is_nsfw).map((r) => r.id).join(','));
  ok(meta.every((m) => m.year === null || (m.year >= 2010 && m.year <= 2015)), 'FB3 推荐受年份窗口约束',
     meta.map((m) => m.year).join(','));
  ok(meta.every((m) => m.st === 'FINISHED'), 'FB3 推荐按 status_eff 判完结');
  db.exec(`DELETE FROM user_setting WHERE key IN ('hide_nsfw','year_min','year_max');
    DELETE FROM user_entry; DELETE FROM watch_log;`);
}

{
  // SEC2 #37：片源抓取每一跳都校验，302 到内网要拦；issued 表要清过期项
  const { privateAddr, fetchText } = await import('../src/lib/server/sources/scrape.js');
  const inner = ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '100.100.1.2', '169.254.1.1', '0.0.0.0',
                 '::1', '::', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1'];
  const outer = ['93.184.216.34', '1.1.1.1', '2606:4700::1111', '::ffff:5db8:d822'];
  ok(inner.every(privateAddr) && !outer.some(privateAddr), 'SEC2 内网 IP 判定（含 IPv6 / 映射地址）',
     JSON.stringify({ 漏拦: inner.filter((x) => !privateAddr(x)), 误拦: outer.filter(privateAddr) }));

  // 用假 fetch 模拟第三方页面 302，不出网
  const realFetch = globalThis.fetch;
  const hops = [];
  const fake = (map) => async (u) => {
    hops.push(String(u));
    const r = map[String(u)];
    return r.loc ? new Response(null, { status: 302, headers: { location: r.loc } }) : new Response(r.body, { status: 200 });
  };
  const errOf = async (url) => { try { await fetchText(url, {}); return null; } catch (e) { return e.message; } };
  try {
    globalThis.fetch = fake({ 'http://93.184.216.34/a': { loc: 'http://127.0.0.1:3000/' } });
    ok(await errOf('http://93.184.216.34/a') === '地址不允许' && hops.length === 1, 'SEC2 302 到本机被拦且不发出第二跳',
       hops.join(' → '));
    hops.length = 0;
    globalThis.fetch = fake({ 'http://93.184.216.34/b': { loc: 'http://[::ffff:100.100.1.2]/' } });
    ok(await errOf('http://93.184.216.34/b') === '地址不允许', 'SEC2 302 到 tailnet（映射地址写法）被拦');
    hops.length = 0;
    globalThis.fetch = fake({ 'http://93.184.216.34/c': { loc: '/d' }, 'http://93.184.216.34/d': { body: 'ok' } });
    let r = null; try { r = await fetchText('http://93.184.216.34/c', {}); } catch {}
    ok(r?.text === 'ok' && r.url === 'http://93.184.216.34/d', 'SEC2 正常的站内 302 照常跟随', JSON.stringify(r));
    const loop = {};
    for (let i = 0; i < 8; i++) loop[`http://93.184.216.34/l${i}`] = { loc: `/l${i + 1}` };
    globalThis.fetch = fake(loop);
    ok(await errOf('http://93.184.216.34/l0') === '重定向过多', 'SEC2 重定向链有上限');
  } finally { globalThis.fetch = realFetch; }

  const idx = readFileSync2('src/lib/server/sources/index.js', 'utf8');
  ok(/issued\.delete\(/.test(idx), 'SEC2 issued 表会清理过期项');
}

{
  /**
   * 片源 m3u8 代理（sources/stream.js，2026-10-19）：只认自己发的令牌、每一跳过内网拦截、
   * 列表里的相对地址改绝对、子列表和密钥再走代理、分片直连 CDN
   */
  const { playableUrl, streamFile } = await import('../src/lib/server/sources/stream.js');
  ok(playableUrl('https://cdn.example.com/v/a.mp4', null, 'UA') === 'https://cdn.example.com/v/a.mp4', 'mp4 原样给浏览器（不经代理）');
  const pu = playableUrl('http://93.184.216.34/v/index.m3u8?t=1', 'http://93.184.216.34/play', 'UA');
  ok(/^\/api\/stream\/[\w-]+\.m3u8$/.test(pu), 'm3u8 换成本站代理地址', pu);
  ok(await streamFile('不存在的令牌') === null, '代理不认没发过的令牌');
  const forged = await get('/api/stream/' + 'A'.repeat(16) + '.m3u8');
  ok(forged.status === 410, '伪造令牌拿不到东西（410）', String(forged.status));
  const bad = await get('/api/stream/..%2F..%2Fetc.m3u8');
  ok(bad.status === 404, '令牌格式不对直接 404', String(bad.status));

  const realFetch = globalThis.fetch;
  try {
    const list = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nseg0.ts\n#EXTINF:4,\nhttps://cdn2.example.com/seg1.ts\nsub/720.m3u8\n';
    globalThis.fetch = async (u) => new Response(list, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
    const out = String((await streamFile(pu.match(/stream\/([\w-]+)\.m3u8/)[1])).body);
    ok(out.includes('http://93.184.216.34/v/seg0.ts'), '相对分片地址改成绝对地址（浏览器直连 CDN）');
    ok(out.includes('https://cdn2.example.com/seg1.ts'), '本来就是绝对地址的分片原样保留');
    ok(/URI="\/api\/stream\/[\w-]+\.key"/.test(out), '密钥走代理');
    ok(/^\/api\/stream\/[\w-]+\.m3u8$/m.test(out), '子列表再走代理');
    // 令牌指向内网：不能借代理去打本机
    const lan = playableUrl('http://127.0.0.1:3000/x.m3u8', null, 'UA');
    let err = null; try { await streamFile(lan.match(/stream\/([\w-]+)\.m3u8/)[1]); } catch (e) { err = e.message; }
    ok(err === '地址不允许', '代理拦内网地址', String(err));
  } finally { globalThis.fetch = realFetch; }

  // 超分用的 mp4 中转（2026-10-19）：只给直连 mp4 发、m3u8 代理地址不再套一层；令牌类型对不上不给
  const { superResUrl, streamMp4 } = await import('../src/lib/server/sources/stream.js');
  const mp = superResUrl('https://cdn.example.com/v/a.mp4', null, 'UA');
  ok(/^\/api\/stream\/[\w-]+\.mp4$/.test(mp ?? ''), '直连 mp4 给一个本站中转地址（开超分时用）', String(mp));
  ok(superResUrl(pu, null, 'UA') === null, 'm3u8 代理地址不再套中转');
  ok(await streamMp4('不存在的令牌', null) === null, 'mp4 中转不认没发过的令牌');
  ok(await streamMp4(pu.match(/stream\/([\w-]+)\.m3u8/)[1], null) === null, 'm3u8 的令牌不能拿来当 mp4 中转用');
  const forgedMp4 = await get('/api/stream/' + 'B'.repeat(16) + '.mp4');
  ok(forgedMp4.status === 410, '伪造的 mp4 令牌 410', String(forgedMp4.status));
  const ply = readFileSync2('src/lib/ui/Player.svelte', 'utf8');
  ok(!/跳过片头<\//.test(ply), '播放器没有「跳过片头」按钮（主人说不需要）');
  const srj = readFileSync2('src/lib/ui/superres.js', 'utf8');
  ok(/device\.destroy\(\)/.test(srj) && /cancelVideoFrameCallback/.test(srj), '超分关掉时停渲染循环、销毁 GPU 设备（不叠管线）');

  // 截图（2026-10-19）：只收 PNG、目录只收绝对路径、ffmpeg 兜底只认 mp4 中转令牌；保存位置用临时目录，不碰主人的图片文件夹
  {
    const { mkdtempSync, readdirSync: rd, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pj } = await import('node:path');
    const dir = mkdtempSync(pj(tmpdir(), 'j-anime-shot-'));
    const rel = await post('/api/settings', { key: 'screenshot_dir', value: 'relative/dir' });
    ok(rel.status === 400, '截图目录不收相对路径', String(rel.status));
    // 手拼：path.join 会把 .. 规范化掉，测不到
    const sep = pj('a', 'b').slice(1, 2);
    const dot = await post('/api/settings', { key: 'screenshot_dir', value: `${dir}${sep}..${sep}x` });
    ok(dot.status === 400, '截图目录不收 ..', String(dot.status));
    const set = await post('/api/settings', { key: 'screenshot_dir', value: dir });
    ok(set.data.ok && set.data.value === dir, '截图目录可以改', JSON.stringify(set.data));
    const sid = db.prepare('SELECT id FROM anime WHERE is_stub=0 AND title_cn IS NOT NULL LIMIT 1').get().id;
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(900_000, 7)]);   // 比 adapter-node 缺省的 512K 大
    const r1 = await fetch(`${BASE}/api/screenshot?id=${sid}&ep=3&t=125`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
    const j1 = await r1.json();
    ok(r1.status === 200 && j1.ok && rd(dir).length === 1 && / 第3集 02-05\.png$/.test(rd(dir)[0]),
       '截图存进配置的目录，文件名带集数和时间（900K 不被请求体上限挡掉）', JSON.stringify({ s: r1.status, j1, files: rd(dir) }));
    const r2 = await fetch(`${BASE}/api/screenshot?id=${sid}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('not a png') });
    ok(r2.status === 400, '不是 PNG 的拒收', String(r2.status));
    const r3 = await post(`/api/screenshot?id=${sid}`, { token: 'C'.repeat(16) });
    ok(r3.status === 400 && /过期/.test(r3.data.error ?? ''), 'ffmpeg 兜底不认没发过的令牌', JSON.stringify(r3.data));
    await post('/api/settings', { key: 'screenshot_dir', value: '' });
    rmSync(dir, { recursive: true, force: true });
  }

  const sn = readFileSync2('src/lib/server/sources/sniff.js', 'utf8');
  ok(/route\(['"]\*\*\/\*['"][\s\S]{0,400}assertPublic/.test(sn), '无头浏览器的每个请求都过内网拦截');
  const wp = readFileSync2('src/routes/anime/[id]/watch/+page.svelte', 'utf8');
  ok(/name="referrer" content="no-referrer"/.test(wp), '观看页不带 Referer（7sefun 的腾讯 CDN 带了就 404）');
}

{
  // FB2 #28：库里存 UTC，热力图 / 时间线 / 「同步于」都要按本地时区显示
  const { stats, timeline } = await import('../src/lib/server/queries.js');
  const pad = (n) => String(n).padStart(2, '0');
  const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const localHm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  // 取昨天 UTC 23:30 —— 东八区下本地已经是今天 07:30，UTC 日期和本地日期必然不同
  const t = new Date(); t.setUTCDate(t.getUTCDate() - 1); t.setUTCHours(23, 30, 0, 0);
  const utc = t.toISOString().slice(0, 19).replace('T', ' ');
  if (t.getTimezoneOffset() === 0) skip('FB2 本机时区是 UTC，时区断言区分不出对错');
  const aid = q('SELECT id FROM anime WHERE is_stub=0 ORDER BY bgm_collection DESC LIMIT 1').id;
  db.exec('DELETE FROM watch_log');
  db.prepare("INSERT INTO watch_log (anime_id, action, detail, watched_at) VALUES (?, 'status_change', 'completed', ?)").run(aid, utc);
  const act = stats().activity;
  ok(act.length === 1 && act[0].d === localDay(t), 'FB2 热力图按本地日期分组', `${JSON.stringify(act)} 期望 ${localDay(t)}`);
  const it = timeline({ limit: 5 }).days[0];
  ok(it?.date === localDay(t) && String(it.items[0].watched_at).slice(11, 16) === localHm(t),
     'FB2 时间线的日期和时刻按本地', `${it?.date} ${it?.items[0]?.watched_at} 期望 ${localDay(t)} ${localHm(t)}`);
  const sv = readFileSync2('src/routes/stats/+page.svelte', 'utf8');
  ok(!/toISOString\(\)/.test(sv), 'FB2 热力图格子键不用 toISOString（UTC）');

  const sid = db.prepare(`INSERT INTO sync_log (kind, started_at, finished_at, items, status)
    VALUES ('bgm_calendar', ?, ?, 1, 'ok')`).run(utc, utc).lastInsertRowid;
  const sc = await get('/schedule?wd=all');
  const want = `${localDay(t).slice(5)} ${localHm(t)}`;
  ok(sc.html.replace(/<!--[^>]*-->/g, '').includes(`同步于 ${want}`), 'FB2 放送表「同步于」按本地时间', `期望 ${want}`);
  db.prepare('DELETE FROM sync_log WHERE id = ?').run(sid);
  db.exec('DELETE FROM watch_log');
}

console.log('\n━━━ 21. 体检批次 2（ec）━━━');
{
  // SR2 #23：带空格的搜索按段 AND，而不是一整段连续短语
  const { toFtsQuery } = await import('../src/lib/server/text.js');
  ok(toFtsQuery('魔法少女小圆 叛逆的物语') === '"魔 法 少 女 小 圆" AND "叛 逆 的 物 语"', 'SR2 空白切段、段间 AND',
     toFtsQuery('魔法少女小圆 叛逆的物语'));
  for (const kw of ['魔法少女小圆 叛逆的物语', 'るろうに剣心 追憶編', 'EVA 序']) {
    const r = await get('/catalog?q=' + encodeURIComponent(kw));
    ok(cards(r.html) > 0, `SR2 「${kw}」能搜到`, `${cards(r.html)} 张`);
  }
}
{
  // SR4 #25：单字符拉丁词不加前缀通配；连接符连起来的短词当短语
  const { toFtsQuery } = await import('../src/lib/server/text.js');
  ok(toFtsQuery('K-ON') === '"k on"' && toFtsQuery('k') === '"k"' && toFtsQuery('HUNTER×HUNTER') === '"hunter hunter"*',
     'SR4 连接符短语 / 单字符不通配', [toFtsQuery('K-ON'), toFtsQuery('k'), toFtsQuery('HUNTER×HUNTER')].join(' | '));
  const { listAnime } = await import('../src/lib/server/queries/catalog.js');
  const kon = listAnime({ q: 'K-ON' }, { limit: 50, sort: 'newest' });
  const konTv = q("SELECT id FROM anime WHERE title = 'K-On!' AND type = 'TV' AND is_stub = 0");
  ok(kon.total <= 30 && (!konTv || kon.rows.some((r) => r.id === konTv.id)), 'SR4 「K-ON」结果收敛且含轻音 TV',
     `${kon.total} 部`);
}
{
  // SR3 #24：默认排序仍是「最新」（主人规则，见 14x），只把标题/中文名/日文名完全匹配的置顶
  // 库里 1996 年的柯南 TV 有两条（中文名 / 日文名各自完全匹配其中一条），任一条进前排即可
  const tv = new Set(db.prepare(`SELECT id FROM anime WHERE is_stub=0 AND type='TV' AND year=1996
    AND (title_ja='名探偵コナン' OR title_cn='名侦探柯南')`).all().map((r) => r.id));
  if (!tv.size) skip('SR3 库里没有柯南 TV');
  else for (const kw of ['名侦探柯南', '名探偵コナン', '名偵探柯南']) {
    const r = await get('/catalog?q=' + encodeURIComponent(kw) + '&status=all');
    const ids = [...new Set([...r.html.matchAll(/href="\/anime\/(\d+)"/g)].map((m) => +m[1]))];
    const at = ids.findIndex((id) => tv.has(id));
    ok(at >= 0 && at < 8, `SR3 搜「${kw}」柯南 TV 本篇在第一页前排`, `位置 ${at}`);
  }
}
{
  // SR5 #26：窗口设成 1995 起时，搜索要能越过窗口（开关「含 1995 年前 N 部」）
  const { setSetting } = await import('../src/lib/server/queries.js');
  const totoro = q("SELECT id FROM anime WHERE is_stub=0 AND title='Tonari no Totoro' AND type='MOVIE'");
  setSetting('year_min', 1995);
  const kw = encodeURIComponent('龙猫');
  const def = await get(`/catalog?q=${kw}`);
  const all = await get(`/catalog?q=${kw}&yw=0`);
  const plain = def.html.replace(/<!--[^>]*-->/g, '');
  ok(/含 1995 年前 \d+ 部/.test(plain), 'SR5 搜索时出现「含 1995 年前 N 部」开关');
  ok(!totoro || (!def.html.includes(`href="/anime/${totoro.id}"`) && all.html.includes(`href="/anime/${totoro.id}"`)),
     'SR5 默认守窗口，打开开关后能搜到龙猫（1988）');
  const noQ = (await get('/catalog?yw=0')).html.replace(/<!--[^>]*-->/g, '');
  ok(!/年前 \d+ 部/.test(noQ), 'SR5 没有搜索词时不出现该开关，yw 也不生效');
  db.exec("DELETE FROM user_setting WHERE key IN ('year_min','year_max')");
}
{
  // DQ2 #13：排行榜同一个 bgm 条目只出一张卡（原来前 300 名 41% 重复）
  const ids = [];
  for (const p of [1, 2, 3]) {
    const r = await get(`/ranking?ps=100&p=${p}`);
    ids.push(...new Set([...r.html.matchAll(/href="\/anime\/(\d+)"/g)].map((m) => +m[1])));
  }
  const bgm = ids.map((id) => q('SELECT bgm_id FROM anime WHERE id=?', id)?.bgm_id).filter((x) => x != null);
  const dup = bgm.length - new Set(bgm).size;
  ok(ids.length >= 250 && dup === 0, 'DQ2 排行榜前 300 名没有重复的 bgm 条目', `${ids.length} 张，重复 ${dup}`);
}
{
  // DQ6 #17：is_jp 补判（新字体 / 制作公司 / 同系列）+ 反向剔除韩美台产地；跑在测试副本上
  const { spawnSync } = await import('node:child_process');
  const run = () => spawnSync(process.execPath, ['scripts/fix-isjp.js'], { env: process.env, encoding: 'utf8' });
  const r1 = run();
  ok(r1.status === 0, 'DQ6 fix-isjp 能跑通', r1.stderr.slice(-300));
  const jp = (id) => q('SELECT is_jp FROM anime WHERE id=?', id)?.is_jp;
  // 伤物语 I / Fate HF I / 亜人 1 / 銀魂 新訳紅桜篇 / 呪術廻戦 死滅回游 後編
  const want = [18053, 9051, 927, 10784, 15808].filter((id) => jp(id) !== undefined);
  ok(want.length && want.every((id) => jp(id) === 1), 'DQ6 体检点名的日本番补回 is_jp=1',
     want.map((id) => `${id}:${jp(id)}`).join(' '));
  const kr = q(`SELECT count(*) c FROM anime a WHERE is_jp=1
    AND EXISTS (SELECT 1 FROM anime_tag t WHERE t.anime_id=a.id AND t.tag='south korean production')
    AND NOT EXISTS (SELECT 1 FROM anime_tag t WHERE t.anime_id=a.id AND (t.tag='japanese production' OR t.tag LIKE '%japanese co-production'))`).c;
  ok(kr === 0, 'DQ6 只有韩国产地的不再算日本番', `${kr} 部`);
  const tog = q("SELECT is_jp FROM anime WHERE title='Kami no Tou'");
  ok(!tog || tog.is_jp === 1, 'DQ6 神之塔（韩日合拍）仍是日本番');
  const cn = q(`SELECT count(*) c FROM anime a WHERE is_jp=1
    AND EXISTS (SELECT 1 FROM anime_tag t WHERE t.anime_id=a.id AND t.tag='chinese production')
    AND NOT EXISTS (SELECT 1 FROM anime_tag t WHERE t.anime_id=a.id AND t.tag='japanese production')`).c;
  ok(cn === 0, 'DQ6 国创仍不算日本番', `${cn} 部`);
  const r2 = run();
  const again = [...r2.stdout.matchAll(/待修正 (\d+) 条/g)].map((m) => +m[1]);
  ok(again.length >= 4 && again.every((n) => n === 0), 'DQ6 再跑一遍没有新改动（不会逐日蔓延）', again.join(','));
}
{
  // DQ8 #19：各站「无图」占位图不当真封面缓存，换下一个来源（Bangumi 封面）或标死链
  const { isPlaceholderUrl, isPlaceholderBuf } = await import('../src/lib/server/coverPlaceholder.js');
  const ph = ['https://raw.githubusercontent.com/manami-project/anime-offline-database/master/pics/no_pic.png',
    'https://cdn.anime-planet.com/images/anime/default/default-anime-spring.png',
    'https://cdn.anisearch.com/images/anime/cover/hentai.v1_600.webp',
    'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/default.jpg'];
  ok(ph.every(isPlaceholderUrl) && !isPlaceholderUrl('https://cdn.myanimelist.net/images/anime/4/54905.jpg'),
     'DQ8 认得四家的占位图 URL，真封面不误认');
  const { COVER_DIR } = await import('../src/lib/server/paths.js');
  const { existsSync, readFileSync } = await import('node:fs');
  const noPic = `${COVER_DIR}/02/25302.png`;   // 体检时 53 张一样的 no_pic 之一
  if (existsSync(noPic)) ok(isPlaceholderBuf(readFileSync(noPic)), 'DQ8 按 md5 认得已缓存的 no_pic');
  else skip('DQ8 封面目录里没有体检时那张 no_pic，跳过 md5 断言');

  // 只有占位图、又没有 bgm_id 的：不发请求、直接标死链，前端走自己的占位样式
  const lone = q(`SELECT id FROM anime WHERE is_stub=0 AND bgm_id IS NULL AND picture LIKE '%/pics/no_pic.png' LIMIT 1`);
  if (lone) {
    db.prepare('UPDATE anime SET cover_local_path=NULL, cover_dead=0 WHERE id=?').run(lone.id);
    const r = await get(`/cover/${lone.id}`);
    const after = q('SELECT cover_local_path p, cover_dead d FROM anime WHERE id=?', lone.id);
    ok(r.status === 404 && !after.p && after.d === 1, 'DQ8 只有占位图时不缓存、标死链', `${r.status} ${JSON.stringify(after)}`);
  } else skip('DQ8 库里没有「只有 no_pic 且无 bgm_id」的条目');
}
{
  // DQ9 #20：封面缓存修复脚本 —— 默认只报告；--apply 修反斜杠、清失效路径、回填/删孤儿、删占位图
  // 用临时封面目录，不碰真实的 data/covers
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, copyFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const { COVER_DIR } = await import('../src/lib/server/paths.js');
  const dir = mkdtempSync(join(tmpdir(), 'j-anime-tmp-covers-'));
  const [a, b, c, d] = db.prepare('SELECT id FROM anime WHERE is_stub=0 ORDER BY id LIMIT 4').all().map((r) => r.id);
  const put = (rel, buf = Buffer.alloc(500, 7)) => { mkdirSync(join(dir, rel.split('/')[0]), { recursive: true }); writeFileSync(join(dir, rel), buf); };
  const dd = (id) => String(id % 100).padStart(2, '0');
  put(`${dd(a)}/${a}.jpg`);                                   // a：库里存的是反斜杠路径
  db.prepare('UPDATE anime SET cover_local_path=? WHERE id=?').run(`${dd(a)}\\${a}.jpg`, a);
  put(`${dd(b)}/${b}.jpg`);                                   // b：孤儿文件，该行还没有路径 → 回填
  db.prepare('UPDATE anime SET cover_local_path=NULL WHERE id=?').run(b);
  db.prepare('UPDATE anime SET cover_local_path=? WHERE id=?').run(`${dd(c)}/${c}.jpg`, c);   // c：文件不在
  put('99/99999999.jpg');                                     // 不存在的 id → 删
  const noPic = `${COVER_DIR}/02/25302.png`;
  const hasPh = existsSync(noPic);
  if (hasPh) {                                                // d：缓存的是 no_pic → 删文件、清路径
    put(`${dd(d)}/${d}.png`, readFileSync(noPic));
    db.prepare('UPDATE anime SET cover_local_path=?, cover_dead=1 WHERE id=?').run(`${dd(d)}/${d}.png`, d);
  }
  const run = (...args) => spawnSync(process.execPath, ['scripts/fix-covers.js', ...args],
    { env: { ...process.env, J_ANIME_COVERS: dir }, encoding: 'utf8' });
  const path = (id) => q('SELECT cover_local_path p FROM anime WHERE id=?', id).p;

  const dry = run();
  ok(dry.status === 0 && path(a).includes('\\') && existsSync(join(dir, '99/99999999.jpg')), 'DQ9 默认只报告不改动',
     dry.stderr.slice(-200));
  const ap = run('--apply');
  ok(ap.status === 0, 'DQ9 --apply 跑通', ap.stderr.slice(-300));
  ok(path(a) === `${dd(a)}/${a}.jpg`, 'DQ9 反斜杠路径改成正斜杠', path(a));
  ok(path(b) === `${dd(b)}/${b}.jpg`, 'DQ9 孤儿文件回填路径', path(b));
  ok(path(c) === null, 'DQ9 文件不在的路径被清掉');
  ok(!existsSync(join(dir, '99/99999999.jpg')), 'DQ9 没有对应番剧的孤儿文件被删');
  if (hasPh) {
    const r = q('SELECT cover_local_path p, cover_dead dd FROM anime WHERE id=?', d);
    ok(!existsSync(join(dir, `${dd(d)}/${d}.png`)) && r.p === null && r.dd === 0, 'DQ9 缓存的占位图被删、标记清掉', JSON.stringify(r));
  } else skip('DQ9 没有 no_pic 样本，跳过占位图清理断言');
  const again = run();
  ok(/① 反斜杠路径 0 条/.test(again.stdout) && /删除 0 个/.test(again.stdout), 'DQ9 再跑一遍无事可做');
  db.prepare(`UPDATE anime SET cover_local_path=NULL WHERE id IN (${[a, b, c, d].join(',')})`).run();
  rmSync(dir, { recursive: true, force: true });
}
{
  // PF1 #44：triageStats 的两个 count 按库版本缓存 —— 命中要快，任何写入（本进程或别的进程）后要立刻失效
  const { triageStats, setTriage, yearWindow, listAnime } = await import('../src/lib/server/queries.js');
  db.exec('DELETE FROM triage; DELETE FROM user_entry;');
  const base = triageStats();
  let t = performance.now(); triageStats(); const hitMs = performance.now() - t;
  ok(hitMs < 5, 'PF1 库没变时 triageStats 走缓存', `${hitMs.toFixed(2)}ms`);
  const pick = q(`SELECT a.id FROM anime a WHERE a.is_stub=0 AND a.is_jp=1 AND a.type='TV' AND a.year >= 2015
    ORDER BY a.bgm_collection DESC LIMIT 1`);
  setTriage(pick.id, 'seen');
  ok(triageStats().remaining === base.remaining - 1, 'PF1 本进程写入后缓存立刻失效', `${base.remaining} → ${triageStats().remaining}`);
  // 别的连接（等同每日同步那个进程）改库
  const { DatabaseSync } = await import('node:sqlite');
  const other = new DatabaseSync(process.env.J_ANIME_DB);
  other.exec('DELETE FROM triage_all'); other.exec('DELETE FROM user_entry_all'); other.close();   // 裸连接没有 uid()，直接动真表
  ok(triageStats().remaining === base.remaining, 'PF1 别的进程改库后缓存也失效', `${triageStats().remaining}`);

  // 放送表的部分索引写进 schema；requireYear 时年份窗口不再带 year IS NULL OR（结果不变）
  ok(/ON anime\(bgm_weekday\) WHERE bgm_weekday IS NOT NULL/.test(readFileSync2('src/lib/server/schema.sql', 'utf8')),
     'PF1 schema 有放送表的部分索引');
  const { min, max } = yearWindow();
  const want = q(`SELECT count(*) c FROM anime a WHERE a.is_stub=0 AND a.is_jp=1 AND a.year BETWEEN ? AND ?`, min, max).c;
  ok(listAnime({ requireYear: true, jpOnly: true }, { limit: 1 }).total === want, 'PF1 requireYear 下窗口条件改写后结果不变');
}
// ━━━ 21 节到此为止 ━━━

console.log('\n━━━ 21b. 手工校正的中文名（#14）━━━');
{
  const { CN_MANUAL } = await import('../src/lib/server/cnManual.js');
  // scripts/test.js 先对副本跑了 migrate.js，它会套用这份清单
  const wrong = CN_MANUAL.filter(({ id, cn }) => { const a = q('SELECT title_cn, bgm_id FROM anime WHERE id = ?', id); return a && !a.bgm_id && a.title_cn !== cn; });
  ok(wrong.length === 0, '#14 清单里的中文名都已生效', wrong.map((w) => w.id).join(','));
  const r = await get('/catalog?q=' + encodeURIComponent('赤黑新章'));
  ok(r.html.includes('/anime/6652"'), '#14 改过的中文名能搜到（搜索索引同步重建了）');
}

console.log('\n━━━ 22. 多账号（2026-10-19）━━━');
{
  const J = { 'Content-Type': 'application/json' };
  const call = async (path, body, cookie, extra = {}) => {
    const r = await fetch(BASE + path, { method: 'POST', headers: { ...J, ...(cookie ? { cookie } : {}), ...extra },
      body: JSON.stringify(body), anon: !cookie });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text(), setCookie: r.headers.get('set-cookie') ?? '' };
  };
  const sid = (r) => (r.setCookie.match(/j_anime_sid=([^;]+)/) ?? [])[1];
  const page = async (path, cookie) => (await fetch(BASE + path, { anon: !cookie, headers: cookie ? { cookie } : {} })).text();
  const aid = (n = 0) => db.prepare(`SELECT id FROM anime WHERE is_stub=0 AND is_jp=1 AND type='TV' AND bgm_collection IS NOT NULL
    ORDER BY bgm_collection DESC LIMIT 1 OFFSET ?`).get(n).id;
  db.exec(`DELETE FROM session WHERE user_id <> 1; DELETE FROM account WHERE id <> 1; DELETE FROM signup_allow;
           DELETE FROM user_entry; DELETE FROM watch_log;`);

  // ── 访客 ──
  ok((await page('/')).includes('j-anime'), 'MU 访客能打开首页');
  ok((await page('/mine')).includes('登录后查看你的番单'), 'MU 访客打开我的番单：留在原页，正文换成登录入口');
  const g1 = await call('/api/entry', { id: aid(), status: 'plan' });
  ok(g1.status === 401 && g1.data.error === '请先登录', 'MU 访客写番单 → 401（前端据此弹登录框）', `${g1.status}`);
  ok((await fetch(BASE + '/api/export', { anon: true })).status === 401, 'MU 访客不能导出（个人数据）');
  db.prepare("INSERT INTO watch_site (name,url,ord) VALUES ('多账号测试站','https://example.com/s?q={cn}',99)").run();
  ok(!(await page(`/anime/${aid()}/watch`)).includes('多账号测试站'), 'MU 访客的观看页不出现观看站（主人要求未登录时清空）');
  ok((await page(`/anime/${aid()}/watch`, `j_anime_sid=${SESSION}`)).includes('多账号测试站'), 'MU 登录后观看站出现');
  db.exec("DELETE FROM watch_site WHERE name = '多账号测试站'");
  const gp = await call('/api/settings', { key: 'hide_nsfw', value: true });
  ok(gp.status === 200 && /j_prefs=/.test(gp.setCookie), 'MU 访客改偏好 → 存 cookie', gp.setCookie.slice(0, 40));
  ok(!db.prepare("SELECT 1 FROM user_setting WHERE key='hide_nsfw' AND user_id <> 1").get(), 'MU 访客偏好不进库');
  let guestWrite = null;
  try { (await import('../src/lib/server/userCtx.js')).asUser(0, () => db.prepare("INSERT INTO user_entry (anime_id,status) VALUES (?, 'plan')").run(aid())); }
  catch (e) { guestWrite = e.message; }
  ok(/CHECK constraint/.test(guestWrite ?? ''), 'MU 数据层第二道保险：uid=0 写个人表被 CHECK 挡下', guestWrite ?? '居然写进去了');

  // ── 注册白名单 ──
  const r0 = await call('/api/auth', { op: 'register', username: 'bob', email: 'bob@example.com', password: 'bobpassword' });
  ok(r0.status === 400 && /联系管理员/.test(r0.data.error), 'MU 不在白名单的邮箱不能注册', r0.data.error);
  const admin = `j_anime_sid=${SESSION}`;
  ok((await call('/api/admin/allow', { op: 'add', email: 'Bob@Example.com' }, admin)).data.list?.some((x) => x.email === 'bob@example.com'),
     'MU 管理员加白名单（邮箱统一小写）');
  const r1 = await call('/api/auth', { op: 'register', username: 'bob', email: 'BOB@example.com', password: 'bobpassword' });
  const bob = `j_anime_sid=${sid(r1)}`;
  ok(r1.status === 200 && r1.data.user?.role === 'user' && sid(r1), 'MU 白名单邮箱能注册，注册即登录，角色是普通用户');
  ok(/HttpOnly/i.test(r1.setCookie) && /SameSite=Lax/i.test(r1.setCookie), 'MU 会话 cookie 是 HttpOnly + SameSite=Lax');
  ok(!/Secure/i.test(r1.setCookie), 'MU http 直连不打 Secure（打了浏览器就不回传了）');
  ok((await call('/api/auth', { op: 'register', username: 'Bob', email: 'x@example.com', password: 'xxxxxxxx' })).status === 400,
     'MU 用户名不分大小写查重');
  ok((await call('/api/admin/allow', { op: 'add', email: 'eve@example.com' }, bob)).status === 403, 'MU 普通用户不能改白名单');
  const dupe = await call('/api/auth', { op: 'register', username: 'bob2', email: 'bob@example.com', password: 'bobpassword' });
  ok(/直接登录/.test(dupe.data.error ?? ''), 'MU 已有账号的邮箱再注册 → 引导去登录（不是报白名单）', dupe.data.error);

  // ── 数据隔离 ──
  const x = aid(0), y = aid(1);
  ok((await call('/api/entry', { id: x, status: 'watching', my_score: 9 }, bob)).status === 200, 'MU bob 标记一部在看');
  ok((await call('/api/entry', { id: y, status: 'completed' }, admin)).status === 200, 'MU 管理员标记另一部');
  ok(db.prepare('SELECT count(*) c FROM user_entry WHERE anime_id = ?').get(x).c === 0, 'MU 管理员的番单里没有 bob 标的那部');
  const bobId = r1.data.user.id;
  ok(db.prepare('SELECT status FROM user_entry_all WHERE user_id = ? AND anime_id = ?').get(bobId, x)?.status === 'watching',
     'MU bob 的记录在真表里归 bob');
  const exB = await (await fetch(BASE + '/api/export', { headers: { cookie: bob } })).json();
  ok(exB.entries.length === 1 && exB.watchSites.length === 0 && exB.seriesOrder.length === 0, 'MU bob 的导出只有自己的一条，不带全站修正');
  const mineB = await page('/mine', bob), mineA = await page('/mine', admin);
  ok(mineB.includes(`/anime/${x}"`) && !mineB.includes(`/anime/${y}"`), 'MU bob 的番单页只有自己的');
  ok(mineA.includes(`/anime/${y}"`) && !mineA.includes(`/anime/${x}"`), 'MU 管理员的番单页只有自己的');
  ok(!(await page('/mine')).includes(`/anime/${x}"`), 'MU 访客看不到任何人的番单');

  // ── 权限 ──
  ok((await call('/api/watch-sites', { op: 'add', name: 'x', url: 'https://e.com/?q={cn}' }, bob)).status === 403, 'MU 普通用户不能改观看站');
  ok((await call('/api/order', { id: x, op: 'up' }, bob)).status === 403, 'MU 普通用户不能调系列顺序');
  ok((await call('/api/settings', { key: 'screenshot_dir', value: 'C:\\x' }, bob)).status === 403, 'MU 普通用户不能改截图目录');
  const setB = await page('/settings', bob);
  ok(!setB.includes('注册白名单') && !setB.includes('id="sites"') && setB.includes('下线其他设备'), 'MU 普通用户的设置页：没有管理员区块，有账号区');
  ok((await page('/settings', admin)).includes('注册白名单'), 'MU 管理员的设置页有注册白名单');

  // ── 个人设置互不影响 ──
  await call('/api/settings', { key: 'year_window', min: 2010, max: 2012 }, bob);
  ok(db.prepare("SELECT value FROM user_setting WHERE user_id = ? AND key = 'year_min'").get(bobId)?.value === '2010', 'MU bob 的年份窗口存在 bob 名下');
  ok(db.prepare("SELECT 1 FROM user_setting WHERE user_id = 1 AND key = 'year_min' AND value = '2010'").get() == null, 'MU 不影响管理员的年份窗口');

  // ── 分享：各人一条链接，看到的是分享人的番单 ──
  const shB = await call('/api/share', { op: 'create' }, bob);
  const shPage = await page(`/share/${shB.data.token}`);
  ok(shPage.includes(`/anime/${x}"`) || shPage.includes('在看'), 'MU 分享链接按令牌找到 bob，显示 bob 的番单');
  ok((await fetch(BASE + '/share/notarealtoken1', { anon: true })).status === 404, 'MU 无效的分享令牌 404');

  // ── 登录 / 限流 / 登出 ──
  const lu = await call('/api/auth', { op: 'login', ident: 'BOB', password: 'bobpassword' });
  const le = await call('/api/auth', { op: 'login', ident: 'bob@example.com', password: 'bobpassword' });
  ok(lu.status === 200 && le.status === 200, 'MU 用户名（不分大小写）和邮箱都能登录');
  const bad = await call('/api/auth', { op: 'login', ident: 'bob', password: 'nope' });
  ok(bad.status === 401 && bad.data.error === '账号或密码不对', 'MU 密码错：不说是账号错还是密码错');
  const ghost = await call('/api/auth', { op: 'login', ident: 'nobody', password: 'nope' });
  ok(ghost.data.error === bad.data.error, 'MU 账号不存在和密码错是同一句话');
  for (let i = 0; i < 4; i++) await call('/api/auth', { op: 'login', ident: 'bob', password: 'nope' + i }, null, { 'x-forwarded-for': `10.0.0.${i}` });
  const locked = await call('/api/auth', { op: 'login', ident: 'bob', password: 'bobpassword' }, null, { 'x-forwarded-for': '10.9.9.9' });
  ok(locked.status === 429, 'MU 同一账号连错 5 次锁住（换来源也没用）', `${locked.status}`);
  const other = await call('/api/auth', { op: 'login', ident: 'admin', password: process.env.TEST_PASSWORD }, null, { 'x-forwarded-for': '10.8.8.8' });
  ok(other.status === 200, 'MU 别的账号不受牵连（https 入口不再共用一个失败名额）', `${other.status} ${JSON.stringify(other.data).slice(0, 60)}`);

  const second = `j_anime_sid=${sid(le)}`;
  ok((await call('/api/auth', { op: 'logout-others' }, bob)).data.ended >= 1, 'MU 下线其他设备');
  ok((await (await fetch(BASE + '/api/export', { headers: { cookie: second } })).status) === 401, 'MU 被下线的会话立刻失效');
  ok((await call('/api/auth', { op: 'logout' }, bob)).status === 200, 'MU 登出');
  const after = await fetch(BASE + '/api/export', { headers: { cookie: bob } });
  ok(after.status === 401, 'MU 登出后原 cookie 不再有效');

  // ── 迁移：老库的个人数据归管理员 ──
  ok(db.prepare("SELECT role FROM account WHERE id = 1").get()?.role === 'admin', 'MU 迁移出来的 id 1 是管理员');
  ok(db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='view' AND name IN ('user_entry','triage','watch_log','saved_filter','user_tag')").get().c === 5,
     'MU 五张个人表都是视图');

  db.exec(`DELETE FROM session WHERE user_id <> 1; DELETE FROM account WHERE id <> 1; DELETE FROM signup_allow;
           DELETE FROM user_entry; DELETE FROM user_setting WHERE user_id = 1 AND key = 'share_token';`);
}

console.log('\n━━━ 23. 分集信息（#49）/ 今天更新（#47）━━━');
{
  const { tokyoToday } = await import('../src/lib/server/episodes.js');
  const { setEntry } = await import('../src/lib/server/queries.js');
  const today = tokyoToday();
  const day = (k) => new Date(Date.parse(today + 'T00:00:00Z') + k * 86400000).toISOString().slice(0, 10);
  // 一部 12 集的在播番：第 1–3 集已播（第 3 集是今天），4–12 还没播；sort 从 13 起（续作常这么编），序号仍从 1 起
  const a = q(`SELECT id, bgm_id FROM anime WHERE is_stub = 0 AND bgm_id IS NOT NULL AND episodes = 12 AND type = 'TV'
    ORDER BY bgm_collection DESC LIMIT 1`);
  db.prepare('DELETE FROM bgm_episode WHERE subject_id = ?').run(a.bgm_id);
  const ins = db.prepare('INSERT INTO bgm_episode (id, subject_id, sort, name, name_cn, airdate) VALUES (?,?,?,?,?,?)');
  // 第 1 集只有日文标题、第 2 集只有英文、第 3 集有中文：只要中文，日文不显示（主人 2026-10-19「不要日文」）
  const nm = (i) => (i === 1 ? 'はじまりのテスト' : i === 2 ? 'THE TEST' : `第${i}話のテスト`);
  for (let i = 1; i <= 12; i++) ins.run(990000000 + i, a.bgm_id, 12 + i, nm(i), i === 3 ? '测试标题三' : '', i <= 3 ? day(i - 3) : day((i - 3) * 7));
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');
  setEntry(a.id, { status: 'watching', current_episode: 1 });

  // 分集信息放在观看页的选集里，不放详情页（主人 2026-10-19）
  ok(!(await get(`/anime/${a.id}`)).html.includes('?tab=eps'), '#49 详情页没有「分集」页签');
  const wd = await (await fetch(`${BASE}/anime/${a.id}/watch/__data.json`)).text();
  ok(wd.includes('测试标题三') && wd.includes(day(0)), '#49 观看页拿到每集的中文标题和播出日期');
  // 选集是浏览器端渲染的（片源接口返回后才有集数），标题规则单独验
  const { epTitle } = await import('../src/lib/format.js');
  ok(epTitle({ name: 'はじまりのテスト', name_cn: '' }) === '' && epTitle({ name: 'THE TEST' }) === 'THE TEST'
     && epTitle({ name: '第3話のテスト', name_cn: '测试标题三' }) === '测试标题三', '#49 分集标题不显示日文（中文优先，没中文时英文照常）');
  ok(/epTitle\(b\)/.test(readFileSync2('src/lib/ui/EpisodePicker.svelte', 'utf8')), '#49 选集用的是同一条标题规则');

  const home = await get('/');
  ok(home.html.includes('今天更新') && home.html.includes('测试标题三'), '#47 首页「今天更新」列出今天播的那一集');
  ok(home.html.includes('未看 2 集') && !home.html.includes('未看 11 集'), '#47 「未看 N 集」按已播集数算（已播 3、看到 1 → 2），不按总集数');
  const guestHome = await (await fetch(BASE + '/', { anon: true })).text();
  ok(!guestHome.includes('今天更新'), '#47 访客首页没有「今天更新」');

  db.prepare('DELETE FROM bgm_episode WHERE id > 990000000').run();
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');
}

console.log('\n━━━ 24. 详情页进度上限（#98）━━━');
{
  const { tokyoToday, addDays } = await import('../src/lib/server/episodes.js');
  const { setEntry } = await import('../src/lib/server/queries.js');
  const today = tokyoToday();
  const a = q(`SELECT id, bgm_id FROM anime WHERE is_stub = 0 AND bgm_id IS NOT NULL AND episodes = 12 AND type = 'TV'
    ORDER BY bgm_collection DESC LIMIT 1`);
  const ins = db.prepare('INSERT INTO bgm_episode (id, subject_id, sort, name, name_cn, airdate) VALUES (?,?,?,?,?,?)');
  /** 12 集的番：第 1、2 集已播，第 3 集的 bgm 播出日是 third，之后每周一集 */
  const fixture = (third) => {
    db.prepare('DELETE FROM bgm_episode WHERE subject_id = ?').run(a.bgm_id);
    for (let i = 1; i <= 12; i++) ins.run(990000100 + i, a.bgm_id, i, `ep${i}`, '', i < 3 ? addDays(today, (i - 3) * 7) : addDays(third, (i - 3) * 7));
  };
  const slider = async () => {
    const html = (await get(`/anime/${a.id}`)).html;
    return { max: +(html.match(/type="range"[^>]*\smax="(\d+)"/)?.[1] ?? html.match(/max="(\d+)"[^>]*type="range"/)?.[1] ?? -1), html };
  };
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');
  setEntry(a.id, { status: 'watching', current_episode: 1 });

  fixture(addDays(today, 1));   // 第 3 集明天才在电视播，片源站今天已经有了（先行配信）
  let s = await slider();
  ok(s.max === 3, '#98 先行配信：bgm 记明天播的那一集也算进进度上限', `max=${s.max}`);
  ok(s.html.includes('共 12 集'), '#98 上限小于总集数时标出总集数');
  fixture(addDays(today, 5));   // 第 3 集还要好几天
  s = await slider();
  ok(s.max === 2, '#98 连载中：进度条上限 = 已播集数，不是总集数 12', `max=${s.max}`);
  fixture(addDays(today, -70)); // 全部播完
  s = await slider();
  ok(s.max === 12, '#98 已完结：上限照旧是总集数', `max=${s.max}`);

  db.prepare('DELETE FROM bgm_episode WHERE id > 990000000').run();
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');
}

console.log('\n━━━ 25. 全站审查修复（#103 #104 #106 #108 #109 #110 #112）━━━');
{
  const { tokyoToday, addDays } = await import('../src/lib/server/episodes.js');
  const { setEntry } = await import('../src/lib/server/queries.js');
  const today = tokyoToday();
  const ins = db.prepare('INSERT INTO bgm_episode (id, subject_id, sort, name, name_cn, airdate) VALUES (?,?,?,?,?,?)');
  const eps = (bgm, n, dateOf) => { db.prepare('DELETE FROM bgm_episode WHERE subject_id = ?').run(bgm); for (let i = 1; i <= n; i++) ins.run(990000200 + bgm % 1000 * 50 + i, bgm, i, `ep${i}`, '', dateOf(i)); };
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');

  // #104：bgm 条目只挂这一张卡，AOD 记 6 集、bgm 播完了 12 集 → 按 12 集算
  const solo = q(`SELECT a.id, a.bgm_id, a.episodes FROM anime a WHERE a.is_stub = 0 AND a.type = 'TV' AND a.bgm_id IS NOT NULL
    AND (SELECT count(*) FROM anime b WHERE b.bgm_id = a.bgm_id AND b.is_stub = 0) = 1 ORDER BY a.bgm_collection DESC LIMIT 1`);
  const ep0 = solo.episodes;
  db.prepare('UPDATE anime SET episodes = 6 WHERE id = ?').run(solo.id);
  eps(solo.bgm_id, 12, (i) => addDays(today, (i - 13) * 7));
  setEntry(solo.id, { status: 'watching', current_episode: 0 });
  // #103：第 3 集 bgm 记明天播（先行配信）→ 首页和详情页都算已播 3
  const ahead = q(`SELECT a.id, a.bgm_id FROM anime a WHERE a.is_stub = 0 AND a.type = 'TV' AND a.episodes = 12 AND a.bgm_id IS NOT NULL
    AND a.id <> ? AND (SELECT count(*) FROM anime b WHERE b.bgm_id = a.bgm_id AND b.is_stub = 0) = 1 ORDER BY a.bgm_collection DESC LIMIT 1`, solo.id);
  eps(ahead.bgm_id, 12, (i) => addDays(today, (i - 3) * 7 + 1));
  setEntry(ahead.id, { status: 'watching', current_episode: 1 });
  // 多张卡共用一个 bgm 条目：已播封顶到这张卡自己的集数
  const shared = q(`SELECT a.id, a.bgm_id, a.episodes FROM anime a WHERE a.is_stub = 0 AND a.episodes BETWEEN 2 AND 13 AND a.bgm_id IS NOT NULL
    AND a.id NOT IN (?, ?) AND (SELECT count(*) FROM anime b WHERE b.bgm_id = a.bgm_id AND b.is_stub = 0) > 1 ORDER BY a.bgm_collection DESC LIMIT 1`, solo.id, ahead.id);
  eps(shared.bgm_id, 25, (i) => addDays(today, -200 + i * 7));
  setEntry(shared.id, { status: 'watching', current_episode: 0 });

  const { airedForMine } = await import('../src/lib/server/episodes.js');
  const st = airedForMine();
  ok(st.get(solo.id)?.total === 12 && st.get(solo.id)?.aired === 12, '#104 只挂这一张卡：总集数按 Bangumi（AOD 6 → 12）', JSON.stringify(st.get(solo.id)));
  ok(st.get(shared.id)?.aired === shared.episodes && st.get(shared.id)?.total === shared.episodes,
    '#104 多张卡共用 bgm 条目：已播封顶到这张卡的集数', `${JSON.stringify(st.get(shared.id))} episodes=${shared.episodes}`);
  const home = (await get('/')).html;
  ok(home.includes('已看 0/12') && !home.includes('已看 0/6'), '#104 首页总集数和未看集数同一口径（不再「0/6 · 未看 12 集」）');
  ok(st.get(ahead.id)?.aired === 3, '#103 首页的已播也算先行配信（和详情页同一口径）', JSON.stringify(st.get(ahead.id)));
  ok(home.includes('已播 3'), '#103 首页显示「已播 3」');
  const det = (await get(`/anime/${ahead.id}`)).html;
  ok(/type="range"[^>]*max="3"/.test(det) || /max="3"[^>]*type="range"/.test(det), '#103 详情页进度上限也是 3');

  db.prepare('UPDATE anime SET episodes = ? WHERE id = ?').run(ep0, solo.id);
  db.prepare('DELETE FROM bgm_episode WHERE id > 990000000').run();
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');

  // #106 错误页
  const nf = await get('/nope-' + Date.now());
  ok(nf.status === 404 && nf.html.includes('页面不存在') && nf.html.includes('回首页'), '#106 不存在的页面：有样式的错误页 + 回首页');
  const na = await get('/anime/999999999');
  ok(na.status === 404 && na.html.includes('找不到这部番') && na.html.includes('去目录'), '#106 不存在的番：显示原因 + 出路');

  // #108 只有符号 / 空格的搜索词 = 没搜
  const total = async (qs) => +((await get('/catalog' + qs)).html.match(/([\d,]+) 部/)?.[1]?.replace(/,/g, '') ?? -1);
  const base = await total('');
  ok(base > 0 && (await total('?q=%25')) === base && (await total('?q=+++')) === base, '#108 「%」「   」搜索结果和不搜一样（默认筛选照常生效）', `base=${base}`);

  // #109 公司名：迁移后不再有 8-bit / 8bit 两家；下拉里没有 Olm / Dle / Tms 这种写法
  const { facets } = await import('../src/lib/server/queries.js');
  const labels = facets().studios.map((s) => s.label);
  const BAD = /^(Olm|Dle|Tms|Mappa|Aic|Arms|Ilca|Acgt|Appp|Tcj)\b|'S\b/;
  ok(!labels.some((l) => BAD.test(l)), '#109 制作公司下拉：缩写按官方写法', labels.filter((l) => BAD.test(l)).join(','));
  // 老格式缓存（只有 label、没有 raw，展示名是旧规则算的）读出来也按新规则
  const cached = q("SELECT json FROM facet_cache WHERE key='v1'").json;
  const oldFmt = JSON.parse(cached);
  oldFmt.studios = [{ studio: 'arms', label: 'Arms', c: 99 }, ...oldFmt.studios.filter((x) => x.studio !== 'arms')];
  db.prepare("UPDATE facet_cache SET json = ?, built_at = datetime('now', '+1 second') WHERE key='v1'").run(JSON.stringify(oldFmt));
  ok(facets().studios.find((x) => x.studio === 'arms')?.label === 'ARMS', '#109 旧缓存里的展示名读的时候按新规则重算');
  db.prepare("UPDATE facet_cache SET json = ?, built_at = datetime('now', '+2 second') WHERE key='v1'").run(cached);
  ok(labels.filter((l) => /^8\s?-?bit$/i.test(l)).length <= 1, '#109 8-bit / 8bit 合成一家', labels.filter((l) => /^8/.test(l)).join(','));
  ok(q("SELECT count(*) c FROM anime_studio WHERE studio_norm IN ('8-bit', '8 bit')").c === 0, '#109 迁移把库里的 studio_norm 重算过了');
  const oldLink = await total('?studio=8-bit');
  ok(oldLink > 0 && oldLink === await total('?studio=8bit'), '#109 旧链接 studio=8-bit 照样能筛', `${oldLink}`);

  const f8 = facets().studios.find((s) => s.studio === '8bit');
  const n8 = q(`SELECT count(DISTINCT s.anime_id) c FROM anime_studio s JOIN anime a ON a.id = s.anime_id
    WHERE a.is_stub = 0 AND a.is_jp = 1 AND s.role = 'studio' AND s.studio_norm = '8bit'`).c;
  ok(f8 && f8.c === n8, '#109 制作公司计数按部算（同一部挂着几种写法只算一次）', `facet=${f8?.c} 实际=${n8}`);
  const dup = q(`SELECT anime_id id FROM anime_studio WHERE role = 'studio' GROUP BY anime_id, studio_norm HAVING count(*) > 1 LIMIT 1`);
  if (dup) {
    const h = (await get(`/anime/${dup.id}`)).html;
    // 详情页头部「制作」写成两行（标签 / 公司名）
    const line = h.match(/>制作<\/div>\s*<div[^>]*>([^<]*)</)?.[1] ?? '';
    const parts = line.split(' / ').filter(Boolean);
    ok(parts.length === new Set(parts.map((x) => x.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, ''))).size, '#109 详情页同一家公司的几种写法只显示一次', line);
  } else skip('库里没有同一家挂两种写法的番');
  // 首页「我在追的」的「连载中」按 status_eff（快照过期、实际已完结的不再标连载中）
  const stale = q(`SELECT id FROM anime WHERE is_stub = 0 AND status = 'ONGOING' AND status_eff = 'FINISHED' LIMIT 1`);
  if (stale) {
    setEntry(stale.id, { status: 'watching', current_episode: 0 });
    const { watching } = await import('../src/lib/server/queries.js');
    ok(watching().find((x) => x.id === stale.id)?.status === 'FINISHED', '#104 首页状态读 status_eff（快照写着连载中、实际已完结）');
    db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');
  } else skip('库里没有 status 与 status_eff 不一致的番');

  // #110 设置页「数据」：没有四行同名的「Bangumi 数据」
  const set = (await get('/settings')).html;
  ok(!set.includes('Bangumi 数据') && set.includes('Bangumi 导出包'), '#110 设置页数据区每行有自己的名字');

  // #112 详情页题材是普通链接，不是选中态
  const g = (await get(`/anime/${q("SELECT anime_id id FROM anime_tag GROUP BY anime_id ORDER BY count(*) DESC LIMIT 1").id}`)).html;
  const seg = g.slice(g.indexOf('题材'), g.indexOf('题材') + 3000);
  ok(seg.includes('/catalog?g=') && !/aria-current="true"[^>]*href="\/catalog\?g=|href="\/catalog\?g=[^"]*"[^>]*aria-current="true"/.test(seg), '#112 题材标签不用选中态');
}

console.log('\n━━━ LG. 想看有进度 → 在看 · 放送表排除国创 · 访客 hero（2026-10-21）━━━');
{
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log; DELETE FROM triage;');
  const [x, y, z] = db.prepare(`SELECT id, episodes FROM anime WHERE is_stub=0 AND episodes BETWEEN 12 AND 26
    ORDER BY bgm_collection DESC LIMIT 3`).all();
  const st = (id) => db.prepare('SELECT status s, current_episode c, is_vague v FROM user_entry WHERE anime_id=?').get(id);

  // 想看 +1 → 在看
  await post('/api/entry', { id: x.id, status: 'plan' });
  let p = await post('/api/entry', { id: x.id, op: 'bump', delta: 1 });
  ok(p.data.entry.status === 'watching' && p.data.entry.current_episode === 1, 'LG 想看 +1 → 在看第 1 集',
     `${p.data.entry.status} ${p.data.entry.current_episode}`);
  // 想看拖进度条（只传 current_episode）→ 在看（主人报的 3/3 还是想看）
  await post('/api/entry', { id: x.id, op: 'clear' });
  await post('/api/entry', { id: x.id, status: 'plan' });
  p = await post('/api/entry', { id: x.id, current_episode: 3 });
  ok(p.data.entry.status === 'watching' && p.data.entry.current_episode === 3, 'LG 想看拖到 3 → 在看', p.data.entry.status);
  // 无条目直接拖到 3 / +1 → 在看
  await post('/api/entry', { id: x.id, op: 'clear' });
  p = await post('/api/entry', { id: x.id, current_episode: 3 });
  ok(p.data.entry.status === 'watching' && st(x.id).s === 'watching', 'LG 无条目拖到 3 → 在看', p.data.entry.status);
  await post('/api/entry', { id: x.id, op: 'clear' });
  p = await post('/api/entry', { id: x.id, op: 'bump', delta: 1 });
  ok(p.data.entry.status === 'watching', 'LG 无条目 +1 → 在看', p.data.entry.status);
  // 想看 + 进度归 0 / 只打分：不动状态
  await post('/api/entry', { id: y.id, status: 'plan' });
  p = await post('/api/entry', { id: y.id, current_episode: 0 });
  ok(p.data.entry.status === 'plan', 'LG 想看进度设 0 仍是想看', p.data.entry.status);
  p = await post('/api/entry', { id: y.id, my_score: 8 });
  ok(p.data.entry.status === 'plan', 'LG 想看只打分仍是想看', p.data.entry.status);
  // 到总集数不自动「看完」（拖进度条）；+1 到最后一集仍自动看完（原有行为）
  p = await post('/api/entry', { id: y.id, current_episode: y.episodes });
  ok(p.data.entry.status === 'watching', 'LG 想看拖到最后一集 → 在看（不自动改看完）', p.data.entry.status);

  // 看完 / 搁置 / 弃番：改进度状态不变（+1、−1、拖进度条都一样）
  for (const s of ['completed', 'on_hold', 'dropped']) {
    await post('/api/entry', { id: z.id, op: 'clear' });
    await post('/api/entry', { id: z.id, status: s, current_episode: 2 });
    p = await post('/api/entry', { id: z.id, op: 'bump', delta: 1 });
    const a1 = p.data.entry.status;
    p = await post('/api/entry', { id: z.id, op: 'bump', delta: -1 });
    const a2 = p.data.entry.status;
    p = await post('/api/entry', { id: z.id, current_episode: 5 });
    ok(a1 === s && a2 === s && p.data.entry.status === s && st(z.id).c === 5, `LG ${s} 改进度状态不变`, `${a1} ${a2} ${p.data.entry.status}`);
  }
  // 显式 status 优先：想看同时传「看完」+ 进度
  await post('/api/entry', { id: z.id, op: 'clear' });
  await post('/api/entry', { id: z.id, status: 'plan' });
  p = await post('/api/entry', { id: z.id, status: 'completed', current_episode: 4 });
  ok(p.data.entry.status === 'completed' && p.data.entry.current_episode === 4, 'LG 显式 status 优先于自动转在看', p.data.entry.status);
  p = await post('/api/entry', { id: z.id, status: 'on_hold', current_episode: 6 });
  ok(p.data.entry.status === 'on_hold', 'LG 显式 on_hold + 进度 → on_hold', p.data.entry.status);

  // is_vague：快速标记来的记录一改进度就清；自动转在看不影响这条语义
  const { setTriage } = await import('../src/lib/server/queries.js');
  db.exec('DELETE FROM user_entry; DELETE FROM triage;');
  setTriage(x.id, 'seen', 1);
  ok(st(x.id).s === 'completed' && st(x.id).v === 1, 'LG 快速标记 → 看完 + is_vague=1');
  p = await post('/api/entry', { id: x.id, current_episode: 3 });
  ok(st(x.id).s === 'completed' && st(x.id).v === 0, 'LG 快速标记的记录改进度：状态不变、is_vague 清零', JSON.stringify(st(x.id)));
  db.exec('DELETE FROM user_entry; DELETE FROM triage; DELETE FROM watch_log;');

  // 放送表「本季全部」排除国创；番单里在看 / 想看的国创照常列
  const cn = db.prepare(`SELECT id FROM anime WHERE is_stub=0 AND is_jp=0 AND bgm_weekday IS NOT NULL LIMIT 1`).get()
    ?? db.prepare(`SELECT id FROM anime WHERE is_stub=0 AND is_jp=0 LIMIT 1`).get();
  const saved = db.prepare('SELECT bgm_weekday w, year, is_nsfw FROM anime WHERE id=?').get(cn.id);
  db.prepare('UPDATE anime SET bgm_weekday = 5, year = NULL, is_nsfw = 0 WHERE id = ?').run(cn.id);
  const { schedule, setEntry: setEntry2 } = await import('../src/lib/server/queries.js');
  const ids = (s) => schedule(s).days.flat().map((r) => r.id);
  ok(!ids('all').includes(cn.id), 'LG 放送表「本季全部」不列国创（is_jp=0）');
  const allIds = ids('all');
  const cnIn = allIds.filter((id) => q('SELECT is_jp FROM anime WHERE id=?', id).is_jp !== 1);
  ok(allIds.length > 0 && cnIn.length === 0, 'LG 本季全部里没有 is_jp=0 的条目', cnIn.join(','));
  const sch = await get('/schedule?wd=all');
  ok(!sch.html.includes(`href="/anime/${cn.id}"`), 'LG 放送表页面不出现国创');
  setEntry2(cn.id, { status: 'watching' });
  ok(ids('all').includes(cn.id) && ids('mine').includes(cn.id), 'LG 自己在追的国创：本季全部 / 我在追的都保留');
  setEntry2(cn.id, { status: 'plan' });
  ok(ids('all').includes(cn.id), 'LG 番单里想看的国创：本季全部保留（和「今天更新」口径一致）');
  setEntry2(cn.id, { status: 'dropped' });
  ok(!ids('all').includes(cn.id), 'LG 弃番的国创：本季全部不列');
  db.prepare('UPDATE anime SET bgm_weekday = ?, year = ?, is_nsfw = ? WHERE id = ?').run(saved.w, saved.year, saved.is_nsfw, cn.id);
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');

  // 访客首页 hero：主按钮「播放第 1 集」进观看页，次按钮「详情」，不放「登录」
  const home = await (await fetch(BASE + '/', { anon: true })).text();
  const hero = home.slice(home.indexOf('<section class="hero'), home.indexOf('</section>', home.indexOf('<section class="hero')));
  const playHref = hero.match(/href="(\/anime\/\d+\/watch\?ep=1)"[^>]*data-hero-play/)?.[1];
  ok(!!playHref, 'LG 访客 hero 主按钮是播放（进观看页）', hero.slice(0, 200));
  ok(/>(播放 第 1 集|播放)<\/a>/.test(hero.replace(/<!--[^>]*-->/g, '')), 'LG 访客 hero 按钮文字是「播放 第 1 集」/「播放」');
  ok(/>详情<\/a>/.test(hero.replace(/<!--[^>]*-->/g, '')), 'LG 访客 hero 次按钮「详情」');
  ok(!hero.includes('登录'), 'LG 访客 hero 不再放「登录」');
  const wr = await fetch(BASE + playHref, { anon: true });
  ok(wr.status === 200, 'LG 访客能打开观看页', String(wr.status));
  const sr = await fetch(`${BASE}/api/sources?op=search&q=`, { anon: true });
  ok(sr.status === 400, 'LG 访客调片源接口不被登录闸门挡（空关键词 → 400 而不是 401）', String(sr.status));
  const sv = readFileSync2('src/routes/+page.svelte', 'utf8');
  ok(/rec\.episodes === 1 \? '播放' : '播放 第 1 集'/.test(sv), 'LG 单集作品（剧场版）写「播放」');
}

console.log('\n━━━ 26. 全站快速搜索 /api/search（顶栏 ⌘K 面板）━━━');
{
  const { listAnime, setEntry } = await import('../src/lib/server/queries.js');
  const { normTitle } = await import('../src/lib/server/normTitle.js');
  const sj = async (qs, init = {}) => {
    const r = await once(() => fetch(`${BASE}/api/search${qs}`, init));
    return { status: r.status, j: await r.json(), cc: r.headers.get('cache-control') ?? '' };
  };
  const enc = encodeURIComponent;
  db.exec("DELETE FROM user_entry; DELETE FROM watch_log; DELETE FROM user_setting WHERE key = 'hide_nsfw';");

  // 访客可读、条数上限、不缓存
  const g = await sj('?q=' + enc('进击'), { anon: true });
  ok(g.status === 200 && g.j.items.length > 0 && g.j.items.length <= 10, '访客能用快速搜索，最多 10 条', `${g.status} ${g.j.items?.length}`);
  ok(/no-store/.test(g.cc), '快速搜索不让缓存（带个人状态）', g.cc);
  // 口径同目录搜索：总数和目录搜索一致（同一套 FTS + 可见性 + 年份窗口）
  for (const w of ['进击', '咒术', '孤独', 'frieren', 'ぼっち', '芙莉莲']) {
    const r = await sj('?q=' + enc(w));
    const want = listAnime({ q: w, jpOnly: true }, { limit: 1 }).total;
    ok(r.status === 200 && r.j.total === want && r.j.items.length === Math.min(10, want), `「${w}」总数和目录搜索一致`, `${r.j.total} vs ${want}`);
  }
  // 排序：完全匹配 → 名字开头命中 → 其余，组内新 → 旧
  for (const w of ['孤独', '咒术', 'ぼっち']) {
    const nq = normTitle(w);
    const ids = (await sj('?q=' + enc(w))).j.items.map((x) => x.id);
    const rows = ids.map((id) => q('SELECT id, title, title_cn, title_ja, year, season FROM anime WHERE id = ?', id));
    const tier = (a) => [a.title, a.title_cn, a.title_ja].map(normTitle).includes(nq) ? 0
      : [a.title, a.title_cn, a.title_ja].some((t) => t && normTitle(t).startsWith(nq)) ? 1 : 2;
    const SO = { WINTER: 1, SPRING: 2, SUMMER: 3, FALL: 4 };
    const key = (a) => [tier(a), -(a.year ?? -1e9), -(SO[a.season] ?? -9)];
    const sorted = rows.every((a, i) => i === 0 || (() => {
      const [x, y] = [key(rows[i - 1]), key(a)];
      for (let k = 0; k < 3; k++) if (x[k] !== y[k]) return x[k] < y[k];
      return true;
    })());
    ok(sorted, `「${w}」完全 / 前缀命中在前，组内新 → 旧`, rows.map((a) => `${tier(a)}:${a.year}`).join(' '));
  }
  const bocchi = (await sj('?q=' + enc('孤独'))).j.items;
  const tvIdx = bocchi.findIndex((x) => x.title === '孤独摇滚！' && x.type === 'TV');
  ok(tvIdx >= 0 && tvIdx < 5, '「孤独」：《孤独摇滚！》TV 本篇在前 5 条（前缀命中优先）', `第 ${tvIdx + 1} 条`);

  // q 过长截断到 100 字；空 / 纯标点当没搜
  const long = await sj('?q=' + enc('进击' + 'あ'.repeat(300)));
  ok(long.status === 200 && long.j.q.length === 100, 'q 超过 100 字截断', `${long.status} ${long.j.q?.length}`);
  const blank = await sj('?q=' + enc('  %%  '), { anon: true });
  ok(blank.status === 200 && blank.j.q === '' && blank.j.kind === 'hot', '纯标点 / 空白当没搜：访客给本季热门', JSON.stringify(blank.j).slice(0, 80));

  // 可见性：国创（is_jp=0）、is_stub 不出现；「隐藏 NSFW」生效
  const cn = q(`SELECT a.id, a.title_cn FROM anime a JOIN anime_fts f ON f.rowid = a.id
    WHERE a.is_jp = 0 AND a.is_stub = 0 AND length(a.title_cn) >= 3 ORDER BY a.bgm_collection DESC LIMIT 1`);
  if (cn) {
    const r = await sj('?q=' + enc(cn.title_cn));
    ok(!r.j.items.some((x) => x.id === cn.id), '国创（is_jp=0）搜不到（和目录一致）', cn.title_cn);
  } else skip('库里没有带中文名的国创');
  const { min, max } = (await import('../src/lib/server/queries.js')).yearWindow();
  const ns = q(`SELECT a.id, a.title_cn FROM anime a WHERE a.is_nsfw = 1 AND a.is_jp = 1 AND a.is_stub = 0
    AND length(a.title_cn) >= 4 AND a.year BETWEEN ? AND ? ORDER BY a.year DESC, a.bgm_collection DESC LIMIT 1`, min, max);
  if (ns) {
    const term = ns.title_cn;
    const vis = await sj('?q=' + enc(term));
    await post('/api/settings', { key: 'hide_nsfw', value: true });
    const hid = await sj('?q=' + enc(term));
    await post('/api/settings', { key: 'hide_nsfw', value: false });
    ok(vis.j.items.some((x) => x.id === ns.id) && !hid.j.items.some((x) => x.id === ns.id), '「隐藏 NSFW」开着时快速搜索也不出现', term);
    // 访客的偏好在 cookie 里
    const guestCookie = 'j_prefs=' + enc(JSON.stringify({ hide_nsfw: '1' }));
    const gh = await sj('?q=' + enc(term), { anon: true, headers: { cookie: guestCookie } });
    ok(!gh.j.items.some((x) => x.id === ns.id), '访客「隐藏 NSFW」（cookie）也生效', term);
  } else skip('窗口内没有带中文名的 NSFW 条目');

  // 我的状态：登录才有；没输入时登录给「最近」
  const fr = (await sj('?q=' + enc('芙莉莲'))).j.items[0];
  setEntry(fr.id, { status: 'watching', current_episode: 3 });
  const mine = (await sj('?q=' + enc('芙莉莲'))).j.items.find((x) => x.id === fr.id);
  const anon = (await sj('?q=' + enc('芙莉莲'), { anon: true })).j.items.find((x) => x.id === fr.id);
  ok(mine?.my_status === 'watching' && mine.current_episode === 3 && anon && anon.my_status === null, '结果带我的状态（访客没有）');
  const rec = (await sj('')).j;
  ok(rec.kind === 'recent' && rec.items[0]?.id === fr.id, '没输入时登录用户看到在看 / 最近', JSON.stringify(rec).slice(0, 80));
  db.exec('DELETE FROM user_entry; DELETE FROM watch_log;');
  ok(rec.items.every((x) => !('picture' in x) && !('thumbnail' in x)), '只回显示要用的字段（不带封面原地址）');

  // 根布局有搜索入口
  const home = (await get('/')).html;
  ok(home.includes('aria-keyshortcuts="Control+K /"'),'顶栏有搜索按钮（带快捷键声明）');

  // 限流：10 秒 40 次，超了 429（打完等窗口过去，免得影响后面的用例）
  const burst = await Promise.all(Array.from({ length: 45 }, () => fetch(`${BASE}/api/search?q=a`, { anon: true }).then((r) => r.status)));
  ok(burst.includes(429) && burst.filter((s) => s === 200).length <= 40, '快速搜索按 IP 限流（429）', burst.filter((s) => s === 429).length + ' 次 429');
  await new Promise((r) => setTimeout(r, 10_500));
}

console.log('\n━━━ 10b. 健康检查 /api/health（看门狗 / 发布用）━━━');
{
  const r = await once(() => fetch(BASE + '/api/health', { anon: true }));
  const body = await r.text();
  let j = null;
  try { j = JSON.parse(body); } catch {}
  ok(r.status === 200 && j?.ok === true, '访客能读 /api/health，库和 jsdom 都在 → ok', `${r.status} ${body.slice(0, 120)}`);
  ok(typeof j?.release === 'string' && !Number.isNaN(Date.parse(j?.at)), '带 release 名和时间', body.slice(0, 120));
  ok(!/[A-Za-z]:\\|[A-Za-z]:\/|\/Users\/|\\Users\\|j-anime\.db/i.test(body), '响应里不带路径', body.slice(0, 120));
  ok(/no-store/.test(r.headers.get('cache-control') ?? ''), '不让缓存', r.headers.get('cache-control'));
}

console.log('\n━━━ EP. 已完结但分集缺播出日期 → 按全部已播（攻壳 1995 剧场版写「尚未开播」，2026-10-21）━━━');
{
  const { airedCount, episodeStatus } = await import('../src/lib/server/episodes.js');
  const fin = db.prepare(`SELECT a.id, a.episodes FROM anime a JOIN bgm_episode e ON e.subject_id = a.bgm_id
    WHERE coalesce(a.status_eff, a.status) = 'FINISHED' AND e.airdate IS NULL AND a.is_stub = 0 LIMIT 1`).get();
  if (!fin) skip('EP 库里没有「已完结 + 分集缺日期」的样本');
  else {
    const s = episodeStatus([fin.id]).get(fin.id);
    ok(s && s.aired === s.total && s.next === null, 'EP 已完结的作品已播 = 总集数、没有下一集', JSON.stringify(s));
    ok(airedCount(fin.id) === null, 'EP airedCount 对已完结作品返回 null（详情页按总集数走，不会「尚未开播」）');
    const html = await (await fetch(`${BASE}/anime/${fin.id}`, { anon: true })).text();
    ok(!html.includes('尚未开播'), 'EP 详情页不写「尚未开播」');
  }
}

console.log('\n━━━ 11. 收尾清理 ━━━');
db.exec(`DELETE FROM watch_log; DELETE FROM user_entry; DELETE FROM triage;
  DELETE FROM user_tag; DELETE FROM saved_filter; DELETE FROM manual_relation;
  DELETE FROM user_setting WHERE key IN ('hide_nsfw','share_token');
  UPDATE franchise_member SET user_order=NULL;`);
ok(dbState().entries === 0, '测试数据已清理');

console.log(`\n${'═'.repeat(52)}`);
console.log(`  通过 ${pass}   失败 ${fail}${skipped ? `   跳过 ${skipped}` : ''}`);
if (fail) { console.log('\n失败项：'); fails.forEach((f) => console.log('  ✗ ' + f)); }
console.log('═'.repeat(52));
process.exit(fail ? 1 : 0);
