/**
 * 浏览器测试（2026-10-20）：真开一个 Chrome 点观看页（#90 #91 #93 #94 #96）和全站交互（#102）。
 * 用法：npm run test:ui（= node scripts/test.js watch-ui，跑在数据库副本上）
 *
 * 片源接口（/api/sources）整个由这里假冒：搜到哪些站、每站几条线路几集、某一集解析成功还是失败，
 * 都写死在下面 —— 第三方片源站时好时坏，拿真站测出来的结果不可重复。视频是 tests/fixtures/tiny.mp4（4 秒）。
 * 没装 Chrome 的机器整套跳过（显式打印），不算失败。
 */
import { assertTestCopy } from './copy-gate.js';
assertTestCopy();
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const BASE = process.env.BASE;
const CHROME = [process.env.J_ANIME_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .filter(Boolean).find((p) => existsSync(p));
if (!CHROME) { console.log('  ⏭️  跳过：本机没有 Chrome'); process.exit(0); }
const { chromium } = await import('playwright-core');

let pass = 0, fail = 0;
const fails = [];
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(`${name} ${detail}`); console.log(`  ❌ ${name}  ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 测试对象：一部 12 集的番，进度 4，没有记住的片源 ──
const db = new DatabaseSync(process.env.J_ANIME_DB);
const a = db.prepare(`SELECT id, title_cn FROM anime WHERE is_stub = 0 AND title_cn IS NOT NULL AND episodes = 12 AND type = 'TV'
  ORDER BY bgm_collection DESC LIMIT 1`).get();
const reset = (progress) => {
  db.prepare('DELETE FROM user_entry_all WHERE user_id = 1 AND anime_id = ?').run(a.id);
  db.prepare("INSERT INTO user_entry_all (user_id, anime_id, status, current_episode) VALUES (1, ?, 'watching', ?)").run(a.id, progress);
  db.prepare('DELETE FROM user_setting WHERE user_id = 1 AND key = ?').run(`watch_pick:${a.id}`);
};

// ── 假片源 ──
const VIDEO = readFileSync(new URL('./fixtures/tiny.mp4', import.meta.url));
/** 每站的剧集：开头夹一条 PV（按下标算集数的老代码会因此差一集，#93） */
const epsOf = (site, road) => [{ name: 'PV', url: `https://${site}.test/pv-${road}` },
  ...Array.from({ length: 12 }, (_, i) => ({ name: `第${String(i + 1).padStart(2, '0')}集`, url: `https://${site}.test/r${road}/ep${i + 1}` }))];
const SEARCH = [
  { site: 'alpha', hits: [{ name: a.title_cn, url: 'https://alpha.test/show', score: 105 }], embed: null },
  { site: 'beta', hits: [{ name: a.title_cn, url: 'https://beta.test/show', score: 105 }], embed: null },
  { site: 'gamma', hits: [{ name: `${a.title_cn} 第九季`, url: 'https://gamma.test/show', score: 10 }], embed: null }
];
/** 解析：默认成功；plan[url] 可以写成 'http502' / '过期' / '没找到' / 'badvideo'，用一次就恢复 */
const plan = {};
const calls = [];
async function fakeSources(route) {
  const u = new URL(route.request().url());
  const op = u.searchParams.get('op');
  if (route.request().method() === 'POST') return route.fulfill({ json: { ok: true } });
  calls.push(`${op}:${u.searchParams.get('url') ?? ''}`);
  if (op === 'search') return route.fulfill({ json: { results: SEARCH } });
  if (op === 'episodes') {
    const site = new URL(u.searchParams.get('url')).hostname.split('.')[0];
    return route.fulfill({ json: { roads: [1, 2].map((r) => ({ name: `线路${r}`, eps: epsOf(site, r) })) } });
  }
  if (op === 'resolve') {
    const ep = u.searchParams.get('url'), p = plan[ep];
    delete plan[ep];
    if (p === 'http502') return route.fulfill({ status: 502, body: 'Bad Gateway' });
    if (p === '过期') return route.fulfill({ json: { error: '链接已过期，请重新搜索' } });
    if (p === '没找到') return route.fulfill({ json: { error: '没找到可直接播放的地址' } });
    if (p === 'badvideo') return route.fulfill({ json: { url: 'https://media.test/missing.mp4' } });
    return route.fulfill({ json: { url: `https://media.test/${encodeURIComponent(ep)}.mp4` } });
  }
  return route.fulfill({ status: 400, json: { error: '未知操作' } });
}

const browser = await chromium.launch({ executablePath: CHROME, headless: !process.env.UI_HEADED,
  args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'j_anime_sid', value: process.env.TEST_SESSION, url: BASE }]);
await ctx.route('**/api/sources**', fakeSources);
await ctx.route('https://media.test/**', (route) => (/missing/.test(route.request().url())
  ? route.fulfill({ status: 404, body: '' })
  : route.fulfill({ status: 200, contentType: 'video/mp4', body: VIDEO })));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

/** 标题下那行「第 N 集 · 本集标题」的集号；片源栏胶囊里的当前站名（2026-10 UI 大改：站名从页头挪进片源栏） */
const curEp = async () => +((await page.locator('p[data-ep]').getAttribute('data-ep').catch(() => '')) || 0);
const curSite = async () => (await page.locator('section [data-site]').getAttribute('data-site', { timeout: 2000 }).catch(() => '')) ?? '';
const box = () => page.locator('.aspect-video').first();
/** 选集里第 n 集（行 / 格子上都有 data-ep，不再按文字认：集号现在只写数字，后面跟着标题） */
const epBtn = (n) => page.locator(`aside [data-ep="${n}"]`).first();
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(200); } return false; };
const playing = () => page.evaluate(() => { const v = document.querySelector('video'); return !!v && v.currentTime > 0.3; });

console.log(`\n━━━ 观看页（${a.title_cn} #${a.id}，假片源）━━━`);
reset(4);
await page.goto(`${BASE}/anime/${a.id}/watch`);

// #93：列表开头夹着 PV，进度 4 → 应该接着第 5 集（老代码按下标取到「第04集」）
ok(await waitFor(async () => (await curEp()) === 5), '#93 接着进度开播按集号找：进度 4 → 第 5 集', `实际第 ${await curEp()} 集`);
ok(await waitFor(playing), '假片源能真的播放（fixtures/tiny.mp4）');
// #1（2026-10-21）：桌面「← 详情」在播放器上方（和详情页「← 返回」同一个位置），不再夹在播放器和标题中间
{
  const back = await page.getByRole('link', { name: '详情' }).first().boundingBox();
  const stage = await box().boundingBox();
  ok(back && stage && back.y + back.height <= stage.y && Math.abs(back.x - stage.x) < 2, '#1 桌面返回键在播放器左上方', JSON.stringify({ back, stage }));
}

// #94：第 7 集换线路 / 换片源都停在第 7 集
await epBtn(7).click();
await waitFor(async () => (await curEp()) === 7);
// 桌面上线路是选集标题行右侧的下拉
await page.locator('aside button[aria-label="线路"]').click();
await page.getByRole('option', { name: '线路2' }).click();
ok(await waitFor(async () => (await curEp()) === 7 && (await playing())), '#94 换线路停在当前集（第 7 集）', `实际第 ${await curEp()} 集`);
await page.getByRole('button', { name: '换片源' }).click();

// #96：别的季的站单独成组
const groups = await page.evaluate(() => {
  const h = [...document.querySelectorAll('section h3')].find((x) => /其他季/.test(x.innerText));
  const names = (el) => el ? [...el.querySelectorAll('button span:first-child')].map((s) => s.innerText.trim()) : [];
  return { top: names(h?.previousElementSibling), other: names(h?.nextElementSibling), heading: !!h };
});
ok(groups.heading && groups.other.includes('gamma') && !groups.top.includes('gamma'), '#96 只搜到别的季的站放在「其他季 / 相近作品」下面', JSON.stringify(groups));
ok(groups.top.includes('alpha') && groups.top.includes('beta'), '#96 对得上这一季的站在上面', JSON.stringify(groups));
const other = groups.top.find((s) => !(/alpha|beta/.test(s) && page.url().includes(s))) ?? 'beta';
const nowSite = (await curSite()) === 'alpha' ? 'beta' : 'alpha';
await page.locator('section .divide-y > div > button:first-child', { hasText: nowSite }).first().click();
ok(await waitFor(async () => (await curEp()) === 7 && (await curSite()) === nowSite),
  '#94 手动换片源也停在当前集（第 7 集）', `实际第 ${await curEp()} 集 ${other}`);

// #90：解析接口 502 → 「重新加载」，不判成只能跳转；恢复后点重新加载能播
const site = nowSite;
plan[`https://${site}.test/r1/ep8`] = 'http502';
await epBtn(8).click();
ok(await waitFor(async () => /没有加载出来/.test(await box().innerText())), '#90 解析失败显示「没有加载出来」');
ok(await page.getByRole('button', { name: '重新加载' }).count() > 0, '#90 播放器里有「重新加载」');
ok(!/只能在原站播放/.test(await box().innerText()), '#90 一次失败不判成只能跳转');
ok(await page.locator('aside:has(h2:text("选集")) a').count() === 0, '#90 选集没有变成跳原站的链接');
ok(await page.locator('section a', { hasText: /原站第 8 集/ }).count() === 1, '#90 片源栏有「原站第 8 集」链接');
await page.getByRole('button', { name: '重新加载' }).first().click();
ok(await waitFor(async () => (await curEp()) === 8 && (await playing())), '#90 点「重新加载」恢复播放');

// #90：视频本身加载失败（hls 致命错误 / video error）同样只给「重新加载」
plan[`https://${site}.test/r1/ep9`] = 'badvideo';
await epBtn(9).click();
ok(await waitFor(async () => /没有加载出来/.test(await box().innerText())), '#90 视频加载失败也只给「重新加载」，不判跳转');

// #90：「没找到直链」第一次给重新加载，同站第二次才认定只能跳转
plan[`https://${site}.test/r1/ep10`] = '没找到';
await epBtn(10).click();
ok(await waitFor(async () => /没有加载出来/.test(await box().innerText())), '#90 第一次「没找到直链」只给重新加载');
plan[`https://${site}.test/r1/ep10`] = '没找到';
await page.getByRole('button', { name: '重新加载' }).first().click();
ok(await waitFor(async () => /只能在原站播放/.test(await box().innerText())), '#90 同站第二次「没找到直链」才认定只能跳转');

// #91：链接过期 → 自动重搜、重取剧集，同一集照常播
reset(4);
await page.goto(`${BASE}/anime/${a.id}/watch`);
await waitFor(async () => (await curEp()) === 5 && (await playing()));
const s2 = await curSite();
plan[`https://${s2}.test/r1/ep6`] = '过期';
const before = calls.length;
await page.keyboard.press('n');
ok(await waitFor(async () => (await curEp()) === 6 && (await playing())), '#91 链接过期后下一集照常播放', `实际第 ${await curEp()} 集`);
const seq = calls.slice(before).map((c) => c.split(':')[0]).join(',');
ok(/resolve,search,episodes,resolve/.test(seq), '#91 过期后自动重搜、重取剧集再解析', seq);
ok(!/只能在原站播放/.test(await box().innerText()) && await page.locator('aside:has(h2:text("选集")) a').count() === 0, '#91 不进跳转模式');
const row = db.prepare('SELECT current_episode FROM user_entry_all WHERE user_id = 1 AND anime_id = ?').get(a.id);
ok(row.current_episode === 4, '#91 没有乱记进度', `current_episode=${row.current_episode}`);

// 手机（2026-10 UI 大改）：390px 时控制条不折行、次要按钮收进「⋯」、播放器吸顶；横屏铺满整屏
console.log('\n━━━ 观看页 · 手机 ━━━');
{
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await mctx.addCookies([{ name: 'j_anime_sid', value: process.env.TEST_SESSION, url: BASE }]);
  await mctx.route('**/api/sources**', fakeSources);
  await mctx.route('https://media.test/**', (route) => route.fulfill({ status: 200, contentType: 'video/mp4', body: VIDEO }));
  const m = await mctx.newPage();
  m.on('pageerror', (e) => errors.push(String(e)));
  reset(4);
  await m.goto(`${BASE}/anime/${a.id}/watch`);
  await waitFor(() => m.evaluate(() => { const v = document.querySelector('video'); return !!v && v.currentTime > 0.3; }));
  await m.locator('.aspect-video').first().evaluate((el) => el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })));
  const geo = await m.evaluate(() => {
    const t = document.querySelector('[data-time]'), lh = parseFloat(getComputedStyle(t).lineHeight) || 18;
    const vis = (sel) => [...document.querySelectorAll(sel)].some((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
    return { h: t.getBoundingClientRect().height, lh, text: t.innerText, row: t.parentElement.getBoundingClientRect().height,
             sr: vis('button[aria-label="超分辨率"]'), speed: vis('button[aria-label="倍速"]'), prev: vis('button[aria-label="上一集"]'),
             more: vis('button[aria-label="更多播放选项"]'), full: vis('button[aria-label="全屏"]') };
  });
  ok(geo.h <= geo.lh * 1.3 && !/\n/.test(geo.text), '手机控制条：时间只占一行（不折行）', JSON.stringify(geo));
  ok(geo.row <= 48, '手机控制条：整行只有一排按钮高', `行高 ${geo.row}`);
  ok(!geo.sr && !geo.speed && !geo.prev && geo.more && geo.full, '手机控制条：上一集 / 超分 / 倍速收进「⋯」，留「⋯」和全屏', JSON.stringify(geo));
  await m.locator('button[aria-label="更多播放选项"]').click();
  await m.getByRole('button', { name: '1.5x' }).click();
  ok(await waitFor(() => m.evaluate(() => document.querySelector('video')?.playbackRate === 1.5)), '手机「⋯」面板里选 1.5x 倍速生效');
  await m.evaluate(() => scrollTo(0, 600));
  await sleep(300);
  const top = await m.locator('.aspect-video').first().evaluate((el) => Math.round(el.getBoundingClientRect().top));
  ok(top === 0, '手机竖屏：往下滚时播放器吸顶', `top=${top}`);
  ok(await m.evaluate(() => document.documentElement.hasAttribute('data-watch')), '观看页给 <html> 打上 data-watch 标记');
  await m.setViewportSize({ width: 844, height: 390 });
  await sleep(400);
  const land = await m.evaluate(() => ({ imm: document.documentElement.hasAttribute('data-watch-immersive'),
    r: (({ top, left, width, height }) => ({ top, left, width, height }))(document.querySelector('.aspect-video').getBoundingClientRect()) }));
  ok(land.imm && land.r.top === 0 && land.r.left === 0 && land.r.width === 844 && land.r.height === 390, '手机横屏：播放器铺满整屏 + data-watch-immersive', JSON.stringify(land));
  // 宽 844 命中 sm:，原来播放器左上角的返回键被 sm:hidden 藏掉，横屏没路可退（2026-10-21 自查）
  await m.locator('.aspect-video').first().hover().catch(() => {});
  ok(await m.locator('.aspect-video button[aria-label="返回详情"]').first().isVisible(), '手机横屏：播放器左上角有返回键');
  await mctx.close();
  // 倍速记在 localStorage，只在这个 context 里，不影响后面
}

// #102：桌面上在下拉 / 弹窗里按 Esc 只关下拉，不收侧栏
console.log('\n━━━ 全站交互 ━━━');
await page.goto(`${BASE}/catalog`);
const sideX = () => page.evaluate(() => Math.round(document.querySelector('aside')?.getBoundingClientRect().x ?? -999));
await waitFor(async () => (await sideX()) === 0);
ok((await sideX()) === 0, '桌面侧栏起始是展开的');
await page.locator('main button', { hasText: /^题材/ }).first().click();
await sleep(300);
await page.keyboard.press('Escape');
await sleep(500);
ok((await sideX()) === 0, '#102 在筛选下拉里按 Esc，侧栏不收起', `x=${await sideX()}`);
await page.keyboard.press('Escape');
await sleep(500);
ok((await sideX()) === 0, '#102 桌面上什么都没开时按 Esc 也不收侧栏');
await page.reload();
ok(await waitFor(async () => (await sideX()) === 0), '#102 刷新后侧栏仍展开');

// #111：浅色主题下，原来加了半透明的那几处文字对比度 ≥ 4.5（筛选摘要、页签计数、已选状态的 ✕）
await page.evaluate(() => localStorage.setItem('j-anime.theme', 'light'));
/** 元素文字和它实际底色的对比度（往上找第一层不透明底色，叠上各层 opacity） */
const contrast = (loc) => loc.evaluate((el) => {
  // 任何 CSS 颜色 → [r, g, b, a]：画到 1×1 画布上读像素。Tailwind 4 的 /20 这类半透明色算出来是
  // oklab(…)，原来按 rgb() 抠数字会把 oklab 的 L/a/b 当成 RGB，量出假的 1.59:1
  const cv = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  const rgb = (c) => {
    cv.clearRect(0, 0, 1, 1); cv.fillStyle = '#000'; cv.fillStyle = c; cv.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = cv.getImageData(0, 0, 1, 1).data;
    return a ? [r, g, b, a / 255] : [];
  };
  const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  // 往上收集各层底色，直到第一层不透明的；再从下往上叠（半透明淡底叠在真实的祖先底色上，深浅主题都对）
  const layers = [];
  for (let e = el; e; e = e.parentElement) {
    const c = rgb(getComputedStyle(e).backgroundColor);
    if (c.length >= 3 && (c[3] ?? 1) > 0) { layers.push(c); if ((c[3] ?? 1) >= 1) break; }
  }
  let under = (layers.pop() ?? [255, 255, 255]).slice(0, 3);
  while (layers.length) { const c = layers.pop(); under = c.slice(0, 3).map((v, i) => v * c[3] + under[i] * (1 - c[3])); }
  let op = 1; for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity;
  const fg = rgb(getComputedStyle(el).color).slice(0, 3).map((v, i) => v * op + under[i] * (1 - op));
  const [x, y] = [lum(fg), lum(under)].sort((p, q) => q - p);
  return +((x + 0.05) / (y + 0.05)).toFixed(2);
});
await page.goto(`${BASE}/catalog`);
const pill = page.locator('main button[aria-expanded] span.truncate').first();
ok(await pill.count() && (await contrast(pill)) >= 4.5, '#111 浅色：筛选胶囊摘要 ≥ 4.5:1', String(await pill.count() && await contrast(pill)));
await page.goto(`${BASE}/catalog?studio=madhouse&smin=7`);
const chipsOk = await page.locator('main button[aria-label^="移除 "]').evaluateAll((els) => els.map((e) => e.innerText));
const chip = page.locator('main button[aria-label^="移除 "]').first();
ok(await chip.count() && (await contrast(chip)) >= 4.5, '#111 浅色：已选条件胶囊 ≥ 4.5:1', String(await chip.count() && await contrast(chip)));
ok(chipsOk.some((t) => /^Madhouse/.test(t)) && !chipsOk.some((t) => /^madhouse/.test(t)), '#109 已选条件胶囊写展示名（Madhouse）不写内部名', chipsOk.join(' | '));
const seriesId =db.prepare(`SELECT m.anime_id id FROM franchise_member m JOIN anime b ON b.id = m.anime_id WHERE b.is_stub = 0
  AND m.franchise_id IN (SELECT franchise_id FROM franchise_member GROUP BY franchise_id HAVING count(*) > 2) LIMIT 1`).get()?.id ?? a.id;
reset(4);
await page.goto(`${BASE}/anime/${a.id}`);
// 2026-10 UI 大改：状态按钮合成分段控件，选中段用 aria-pressed 标出（原来是按钮里的 ✕）
const x = page.locator('main [role=group][aria-label="我的状态"] button[aria-pressed="true"]').first();
ok(await x.count() && (await contrast(x)) >= 4.5, '#111 浅色：已选状态段的文字 ≥ 4.5:1', String(await x.count() && await contrast(x)));
await page.goto(`${BASE}/anime/${seriesId}`);
const cnt = page.locator('main button', { hasText: '同系列' }).locator('span').first();
ok(await cnt.count() && (await contrast(cnt)) >= 4.5, '#111 浅色：页签计数 ≥ 4.5:1', String(await cnt.count() && await contrast(cnt)));
// 选中态 chip（强调色淡底 + accent-ink）和里面的计数、下拉面板里的选中项 —— 两套主题都量（#111 第四轮复验查出）
for (const theme of ['light', 'dark']) {
  await page.evaluate((t) => localStorage.setItem('j-anime.theme', t), theme);
  await page.goto(`${BASE}/schedule`);
  const on = page.locator('main a[aria-current="true"], main button[aria-pressed="true"]').first();
  ok(await on.count() && (await contrast(on)) >= 4.5, `#111 ${theme}：放送表选中的 chip ≥ 4.5:1`, String(await on.count() && await contrast(on)));
  const cntSpan = on.locator('span').last();
  if (await cntSpan.count()) ok((await contrast(cntSpan)) >= 4.5, `#111 ${theme}：选中 chip 里的计数 ≥ 4.5:1`, String(await contrast(cntSpan)));
  await page.goto(`${BASE}/catalog`);
  // vite dev 首次编译慢：点到下拉真的展开为止
  const typeBtn = page.locator('main button', { hasText: /^类型/ }).first();
  await waitFor(async () => { if ((await typeBtn.getAttribute('aria-expanded')) !== 'true') await typeBtn.click(); await sleep(300); return (await typeBtn.getAttribute('aria-expanded')) === 'true'; });
  const sel = page.locator('main .absolute.z-50 [aria-current="true"]').first();
  ok(await sel.count() && (await contrast(sel)) >= 4.5, `#111 ${theme}：下拉面板里的选中项 ≥ 4.5:1`, String(await sel.count() && await contrast(sel)));
  await page.keyboard.press('Escape');
}
await page.evaluate(() => localStorage.setItem('j-anime.theme', 'dark'));

// 全站快速搜索（顶栏 ⌘K 面板，2026-10-21）
console.log('\n━━━ 全站快速搜索 ━━━');
{
  const dlg = page.locator('[role=dialog][aria-label="搜索番剧"]');
  const box = page.locator('[role=combobox]');
  await page.goto(`${BASE}/catalog`);
  // vite dev 首次编译慢：按到面板真的出来为止
  ok(await waitFor(async () => { if (!(await dlg.count())) await page.keyboard.press('Control+k'); await sleep(250); return (await dlg.count()) > 0; }),
     '快速搜索：Ctrl+K 打开面板');
  ok(await box.evaluate((el) => el === document.activeElement), '快速搜索：打开后焦点在输入框');
  ok(await dlg.getAttribute('aria-modal') === 'true', '快速搜索：dialog + aria-modal');
  await box.fill('芙莉莲');
  const opts = page.locator('#qs-list [role=option]');
  // 没输入时列表里是「最近 / 本季热门」：等搜索结果换上来（最后一项变成「在目录中搜索」）
  ok(await waitFor(async () => (await opts.count()) > 2 && /\/catalog\?q=/.test(await opts.last().getAttribute('href') ?? '')),
     '快速搜索：输入即出结果，最后一项是「在目录中搜索」');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  ok(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')), '快速搜索：Tab 圈在面板里');
  await box.focus();
  await page.keyboard.press('ArrowDown');
  ok(await box.getAttribute('aria-activedescendant') === 'qs-opt-1', '快速搜索：↓ 移到第二条');
  const want = await opts.nth(1).getAttribute('href');
  await page.keyboard.press('Enter');
  ok(await waitFor(async () => new URL(page.url()).pathname === want), '快速搜索：Enter 打开详情', `${page.url()} vs ${want}`);
  ok(await waitFor(async () => (await dlg.count()) === 0), '快速搜索：跳转后面板收起');

  // `/` 打开；Esc 关闭，焦点回到顶栏按钮
  await page.locator('main').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('/');
  ok(await waitFor(async () => (await dlg.count()) > 0), '快速搜索：「/」打开');
  await page.keyboard.press('Escape');
  ok(await waitFor(async () => (await dlg.count()) === 0), '快速搜索：Esc 关闭');
  ok(await page.evaluate(() => document.activeElement?.hasAttribute('aria-keyshortcuts')), '快速搜索：关闭后焦点回到顶栏按钮');
  // 在别的输入框里打「/」不抢
  await page.goto(`${BASE}/catalog`);
  await page.waitForLoadState('networkidle');   // 水合前打的字会被水合重置掉
  const field = page.locator('main input[aria-label="搜索"]').first();
  await field.click();
  await page.keyboard.type('a/b');
  await sleep(300);
  ok((await dlg.count()) === 0 && (await field.inputValue()).includes('a/b'), '快速搜索：输入框里打「/」不打开面板');
  // 搜不到
  await page.keyboard.press('Control+k');
  await waitFor(async () => (await dlg.count()) > 0);
  await box.fill('zzqxjvw');
  ok(await waitFor(async () => (await dlg.textContent()).includes('没有找到「zzqxjvw」')), '快速搜索：空结果一行提示');
  await page.keyboard.press('Escape');

  // 手机：全屏面板，「搜索」键去目录
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const m = await mctx.newPage();
  m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(`${BASE}/catalog`);
  const mdlg = m.locator('[role=dialog][aria-label="搜索番剧"]');
  ok(await waitFor(async () => { if (!(await mdlg.count())) await m.locator('header button[aria-label="搜索"]').tap(); await sleep(300); return (await mdlg.count()) > 0; }),
     '快速搜索（手机）：点顶栏放大镜打开');
  const r = await mdlg.boundingBox();
  ok(r && r.width === 390 && r.height >= 800, '快速搜索（手机）：全屏', JSON.stringify(r));
  await m.locator('[role=combobox]').fill('咒术');
  await waitFor(async () => (await m.locator('#qs-list [role=option]').count()) > 2);
  ok(!(await m.locator('#qs-list [role=option][aria-selected=true]').count()), '快速搜索（手机）：不预先高亮第一条');
  await m.keyboard.press('Enter');
  ok(await waitFor(async () => new URL(m.url()).pathname === '/catalog' && new URL(m.url()).searchParams.get('q') === '咒术'),
     '快速搜索（手机）：键盘「搜索」键去目录搜索', m.url());
  await mctx.close();
}

ok(errors.length === 0, '页面没有 JS 异常', errors.slice(0, 3).join(' | '));

await browser.close();
db.prepare('DELETE FROM user_entry_all WHERE user_id = 1 AND anime_id = ?').run(a.id);
db.prepare('DELETE FROM user_setting WHERE user_id = 1 AND key = ?').run(`watch_pick:${a.id}`);
db.close();

console.log(`\n════════════════════════════════════════════════════\n  通过 ${pass}   失败 ${fail}\n`);
if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  ✗ ' + f); }
process.exit(fail ? 1 : 0);
