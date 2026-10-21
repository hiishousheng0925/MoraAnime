/**
 * 架构静态检查。不需要服务器、不碰数据库，秒级完成，发布闸门第一道。
 *
 * 每条规则都对应一次真实踩过的坑：
 *   非法导出   —— +page.server.js / +layout.server.js 只允许固定几个导出名。
 *                这个错我犯过三次（YEAR_FLOOR、PER_PAGE、DRAWER_COOKIE），
 *                每次都是构建直接失败，而 dev 模式只给一条 warning。
 *   死组件     —— Select.svelte 在改用内联列表后没人引用，却留了 78 行。
 *   死导出     —— epText / DEFAULT_TYPES 都是重构后忘了删。
 *   死测试     —— lint-reactivity.js 写完从没被调用过。
 *   相对路径推算 —— db 和封面目录都踩过：生产构建后路径指错，
 *                node:sqlite 还会静默新建空库，站点起来但一条番都没有。
 *   $props 非响应式 const —— Chip.svelte 的高亮不更新，见 lint-reactivity.js
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { checkReactivity } from './lint-reactivity.js';

const walk = (d) => !existsSync(d) ? [] : readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));

let pass = 0, fail = 0;
const fails = [];
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(`${name}\n     ${detail}`); console.log(`  ❌ ${name}\n     ${detail}`); }
};

const ALL = walk('src');
const SVELTE = ALL.filter((f) => f.endsWith('.svelte'));
const JS = ALL.filter((f) => f.endsWith('.js'));

console.log('\n━━━ 1. SvelteKit 只允许固定的导出名 ━━━');
{
  // 官方允许的：load / prerender / csr / ssr / trailingSlash / config / actions / entries
  // 以及任何 _ 开头的
  const ALLOWED = ['load', 'prerender', 'csr', 'ssr', 'trailingSlash', 'config', 'actions', 'entries'];
  const bad = [];
  for (const f of JS.filter((x) => /\+(page|layout)\.server\.js$|\+(page|layout)\.js$/.test(x))) {
    for (const m of readFileSync(f, 'utf8')
      .matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (!ALLOWED.includes(m[1]) && !m[1].startsWith('_')) bad.push(`${f}: export ${m[1]}`);
    }
    // export { a, b as c } 这种写法原来查不到：按导出后的名字算
    for (const m of readFileSync(f, 'utf8').matchAll(/^export\s*\{([^}]*)\}/gm))
      for (const part of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        const n = part.split(/\s+as\s+/).pop().trim();
        if (!ALLOWED.includes(n) && !n.startsWith('_')) bad.push(`${f}: export { ${n} }`);
      }
  }
  ok(bad.length === 0, '路由文件没有非法导出', bad.join('\n     '));
}

console.log('\n━━━ 2. 没有死组件 ━━━');
{
  const dead = SVELTE.filter((f) => {
    const base = f.split('/').pop();
    if (base.startsWith('+')) return false;            // 路由文件由框架加载
    return !ALL.some((o) => o !== f && readFileSync(o, 'utf8').includes(`/${base}'`));
  });
  ok(dead.length === 0, '每个组件都有人引用', dead.join(', '));
}

/** 去掉注释后的源码（粗略：块注释 + 行首 / 空白后的 // 注释）。只在注释里提到的名字不算有人用 */
const codeCache = new Map();
const codeOf = (p) => {
  if (!codeCache.has(p)) codeCache.set(p, readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1'));
  return codeCache.get(p);
};

console.log('\n━━━ 3. 没有死导出 ━━━');
{
  // 门面文件（只有 export * 的）不算；只在自身文件内用到也算死导出
  const bad = [];
  for (const f of JS.filter((x) => x.startsWith('src/lib/'))) {
    const src = readFileSync(f, 'utf8');
    if (/^export \*/m.test(src)) continue;
    for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      const n = m[1];
      const usedElsewhere = ALL.concat(walk('scripts'), walk('tests'))
        .some((o) => o !== f && new RegExp(`\\b${n}\\b`).test(codeOf(o)));
      const usedHere = (src.match(new RegExp(`\\b${n}\\b`, 'g')) || []).length > 1;
      if (!usedElsewhere && !usedHere) bad.push(`${f}: ${n}`);
    }
  }
  ok(bad.length === 0, 'lib 里没有无人使用的导出', bad.join('\n     '));
}

console.log('\n━━━ 4. 没有死测试 ━━━');
{
  const suites = walk('tests').filter((f) => f.endsWith('.js'));
  const runners = walk('scripts').concat(['package.json'])
    .map((f) => readFileSync(f, 'utf8')).join('\n')
    + suites.map((f) => readFileSync(f, 'utf8')).join('\n');
  // tests/unit/*.test.js 由 node --test 按 glob 整批跑（package.json 的 test:unit），不逐个点名
  const unitGlob = readFileSync('package.json', 'utf8').includes('tests/unit/*.test.js');
  const dead = suites.filter((f) => !(unitGlob && /\/unit\/[^/]+\.test\.js$/.test(f))
    && !runners.includes(f.split('/').pop().replace('.js', '')));
  ok(dead.length === 0, '每个测试文件都会被跑到', dead.join(', '));
}

console.log('\n━━━ 5. 不靠相对路径推算【数据】目录 ━━━');
{
  // 规则要精确到「数据路径」而不是「所有 import.meta.url」：
  // db.js 用它读随源码走的 schema.sql，那是代码资源，合法。
  // 真正的坑是拿它推算 data/ covers/ backups/ *.db —— 生产构建后会指错，
  // 而 node:sqlite 打不开还会静默新建空库，站点起来但一条番都没有。
  // 原来只逐行看 src：「先 const ROOT = …import.meta.url，下一行 join(ROOT, 'data')」查不出来，scripts/ 也不扫
  const DATAISH = /['"`](?:data|covers|backups|cache)(?:['"`/\\]|$)|\.db['"`]/;
  const bad = [];
  for (const f of JS.concat(walk('scripts').filter((x) => x.endsWith('.js'))).filter((x) => x !== 'src/lib/server/paths.js')) {
    const src = readFileSync(f, 'utf8');
    if (!/import\.meta\.url/.test(src)) continue;
    const vars = new Set();
    for (const line of src.split('\n')) {
      if (!/import\.meta\.url/.test(line)) continue;
      if (/data|covers|backups|\.db|cache/i.test(line)) bad.push(`${f}: ${line.trim()}`);
      const v = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
      if (v) vars.add(v[1]);
    }
    // 确实就是要仓库里的 data/（比如搬家脚本的来源）：同一行写 lint-datapath-ok: 原因
    for (const v of vars)
      for (const line of src.split('\n'))
        if (!line.includes('lint-datapath-ok') && DATAISH.test(line)
            && new RegExp(`(?:join|resolve)\\(\\s*${v}\\b`).test(line))
          bad.push(`${f}: ${line.trim()}`);
  }
  ok(bad.length === 0, '没有从 import.meta.url 推算数据路径的地方', bad.join('\n     '));
}

console.log('\n━━━ 6. $props 的派生值必须用 $derived ━━━');
{
  const bad = checkReactivity('src');
  ok(bad.length === 0, '没有非响应式的 const 派生自 prop', bad.join('\n     '));

  // 这个检查自己曾被搞崩过：$props() 解构里的 JSDoc 注释被当成 prop 名拼进正则，
  // 注释里的 * ( 让 RegExp 直接抛错 —— 而发布闸门第一步就是跑它
  const withComment = SVELTE.filter((f) => {
    const src = readFileSync(f, 'utf8');
    const m = src.match(/let\s*\{([^}]*)\}\s*=\s*\$props\(\)/);
    return m && /\/\*|\/\//.test(m[1]);
  });
  ok(withComment.length > 0, '有组件在 $props() 里写了注释（检查得容得下）',
     `${withComment.length} 个`);
}

console.log('\n━━━ 7. 定时任务里的脚本不能默认打 dev server ━━━');
{
  // warm-covers 原来默认 http://localhost:5173，而定时同步在 04:30 跑，
  // 那时候没有 dev server —— 封面预热每天都在静默失败。
  const bad = [];
  for (const f of walk('scripts').filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(f, 'utf8');
    for (const line of src.split('\n')) {
      // 只看「默认值」那种写法：|| 'http://localhost:xxxx'
      if (/\|\|\s*['\`]https?:\/\/(localhost|127\.0\.0\.1)/.test(line)) bad.push(`${f}: ${line.trim()}`);
    }
  }
  ok(bad.length === 0, '没有脚本把 dev server 当默认地址', bad.join('\n     '));
}

console.log('\n━━━ 8. 界面不写教学式说明 ━━━');
{
  // 主人纠正过三次：ONA/SP 名词解释、「可多选 · 默认不含未上映」、
  // 「默认那套在切页、刷新后仍生效；「重置」也回到它。也可在设置里管理」。
  // 原话：「一个专业合格的成品系统不该有这样的说明」。
  // 控件的状态、选中态、摘要本身就该把行为讲清楚 —— 需要一段话解释，
  // 说明那个控件设计得不对，该改控件而不是加说明。
  //
  // 判据（拿现有文案校准过，不误伤合法的一句话提示）：
  //   ≥2 个句读（。；）→ 成段了
  //   >24 字且含句读     → 是散文不是标签
  // 确有必要（比如 ODbL 要求说明对数据做了哪些修改）时，
  // 在那段前一行写 <!-- lint-copy-ok: 原因 --> 显式豁免。
  const bad = [];
  for (const f of SVELTE) {
    const src = readFileSync(f, 'utf8');
    let body = src.slice(src.indexOf('</script>') + 9);
    /**
     * 先把行内标签摘掉再量长度 —— 否则一段话被 <code> 切碎，每一截都短得过关。
     * 实测漏网：设置页「仅依据 <code>hentai</code> 与 <code>18 restricted</code>。
     * <code>ecchi</code> / … 描述剧情内容而非分级」整段 59 字，规则一个字都没抓到。
     */
    body = body.replace(/<\/?(?:code|b|strong|em|i|u|small|kbd|a|span)\b[^>]*>/g, '');
    /**
     * InfoTip 气泡里的文字整段豁免 —— 那正是「说明该待的地方」：
     * 不占页面高度、鼠标移上去才出现。这条规则要管的是【铺在页面上】的说明，
     * 把说明搬进气泡就是它想要的结果，不能反过来又判违规。
     */
    body = body.replace(/<InfoTip\b[\s\S]*?<\/InfoTip>/g, ' ');
    for (const m of body.matchAll(/>([^<>{}]*[\u4e00-\u9fa5][^<>{}]*)</g)) {
      const t = m[1].replace(/\s+/g, ' ').trim();
      const marks = (t.match(/[。；]/g) || []).length;
      /**
       * 第三条判据：一句句读都没有、但长到 30 字以上，同样是散文。
       * 实测漏网：设置页「目录 / 季度浏览 / 排行榜 / 放送表 / 快速标记 都只出这个区间」
       * 36 字零句读 —— 前两条判据都要求至少一个句读，所以完全没管住。
       */
      if (!(marks >= 2 || (t.length > 24 && marks >= 1) || t.length > 30)) continue;
      // 前 200 字符内有豁免标记就放过
      // 回看 400 字符找豁免标记：摘掉行内标签后，注释和正文之间的距离会变
      const before = body.slice(Math.max(0, m.index - 400), m.index);
      if (/lint-copy-ok:/.test(before)) continue;
      bad.push(`${f}: ${t.slice(0, 46)}${t.length > 46 ? '…' : ''}`);
    }
  }
  ok(bad.length === 0, '界面里没有教学式说明文字', bad.join('\n     '));
}

console.log('\n━━━ 9. 反馈信息只走全局 toast ━━━');
{
  // 重构前有三套并存：SaveFilter 把「已保存」印在面板里（命名成「已保存」时
  // 出现「已保存「已保存」」）、triage 和 settings 各写一份居中的 flash、
  // 另有三处裸 alert()。反馈只有一个出口，才不会各处乱长。
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/[^\n]*/gm, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // 浏览器原生弹窗一律不用：顶着「100.x.x.x:3000 says」的标题、按钮是英文的
  // OK/Cancel、样式不跟主题，在自己的站里看着像被别人接管了。确认走 ui/Confirm.svelte。
  const native = [...SVELTE, ...JS]
    .filter((f) => /(^|[^.\w])(alert|confirm|prompt)\s*\(/.test(stripComments(readFileSync(f, 'utf8'))));
  ok(native.length === 0, '没有原生 alert/confirm/prompt', native.join(', '));
  ok(SVELTE.includes('src/lib/ui/Confirm.svelte'), '有站内确认框组件');

  const local = SVELTE.filter((f) => f !== 'src/lib/ui/Toaster.svelte')
    .filter((f) => /let\s+(toast|note|flash)\s*=\s*\$state/.test(readFileSync(f, 'utf8')));
  ok(local.length === 0, '没有页面自建的提示状态', local.join(', '));

  ok(readFileSync('src/routes/+layout.svelte', 'utf8').includes('<Toaster'),
     'Toaster 挂在根布局（只渲染一处）');
  // 2026-10 UI 大改：桌面右下角；手机和窄屏（<768px，和底部标签栏同一断点）底部居中宽条，浮在底部标签栏（--tabbar-h）之上
  const ts = readFileSync('src/lib/ui/Toaster.svelte', 'utf8');
  ok(ts.includes('md:bottom-4 md:right-4') && ts.includes('inset-x-4') && ts.includes('var(--tabbar-h)'),
     'toast 桌面在右下角、手机底部居中且避开标签栏');
}

console.log('\n━━━ 10. 没有 <button href>（点了不会有反应）━━━');
{
  // <button> 不认 href。实测制作公司筛选整列都是 <button href={...}>，
  // 点任何一家都没反应 —— 而且 svelte-check 不报错，只能靠静态检查兜。
  const bad = [];
  for (const f of SVELTE)
    for (const m of readFileSync(f, 'utf8').matchAll(/<button[^>]*\bhref=/g))
      bad.push(`${f}:${readFileSync(f, 'utf8').slice(0, m.index).split('\n').length}`);
  ok(bad.length === 0, '导航一律用 <a href>，不用 <button href>', bad.join(', '));
}

console.log('\n━━━ 11. 单文件不过长 ━━━');
{
  const LIMIT = 400;
  const big = ALL.filter((f) => readFileSync(f, 'utf8').split('\n').length > LIMIT)
    .map((f) => `${f} (${readFileSync(f, 'utf8').split('\n').length} 行)`);
  ok(big.length === 0, `src 下没有超过 ${LIMIT} 行的文件`, big.join(', '));
}

console.log('\n━━━ 12. 内容区宽度只有一处定义 ━━━');
{
  // 每个页面自己写 mx-auto max-w-* 的时候，攒出了 3xl/5xl/6xl/7xl 四种宽度，
  // 在侧栏点来点去内容区的左右边界会跳。现在统一走 $lib/ui/Page.svelte。
  // 登录页不在应用外壳里（没有侧栏，是一张居中的卡），它的宽度和内容区无关
  const pages = ALL.filter((f) => /routes\/.*\+page\.svelte$/.test(f) && !f.includes('routes/login/'));
  const rogue = pages.filter((f) => /mx-auto\s+(?:\w+\s+)*max-w-/.test(readFileSync(f, 'utf8')));
  ok(rogue.length === 0, '页面不自己定义外框宽度（用 <Page>）', rogue.join(', '));
  const noShell = pages.filter((f) => !/<Page\b/.test(readFileSync(f, 'utf8')));
  ok(noShell.length === 0, '每个页面都套了 <Page>', noShell.join(', '));
  // 重构那次脚本拼错闭合标签，8 个页面底部多了一个裸 '>'，被当成文字渲染出来
  const stray = pages.filter((f) => /<\/[A-Z][A-Za-z]*>>/.test(readFileSync(f, 'utf8')));
  ok(stray.length === 0, '组件闭合标签后面没有多余的 >', stray.join(', '));
  const shell = readFileSync('src/lib/ui/Page.svelte', 'utf8');
  ok((shell.match(/max-w-7xl/g) || []).length === 1, 'Page.svelte 里只有一个外框宽度');
}

console.log('\n━━━ 13. 构建缺省不能写进正式站目录 ━━━');
{
  // 实测事故：裸跑 `npx vite build` 把正式站在跑的 build/ 整个重写，进程的模块图
  // 对不上，每个请求 500。发布门禁只管 npm run release，管不住手动构建。
  const cfg = readFileSync('svelte.config.js', 'utf8');
  const m = cfg.match(/BUILD_OUT\s*\|\|\s*'([^']+)'/);
  ok(!!m, 'svelte.config.js 里能读到缺省输出目录');
  ok(m && m[1] !== 'build', `缺省输出不是 build/（现在是 ${m?.[1]}）`, m?.[1]);
  // 桌面客户端仓库（MoraAnime）同步时排除了网站的发布脚本
  if (existsSync('scripts/release.js'))
    ok(/BUILD_OUT: 'build.next'/.test(readFileSync('scripts/release.js', 'utf8')),
       '发布走 build.next 再原子替换');
  else console.log('  ⏭️  跳过「发布走 build.next」：没有 scripts/release.js');
  ok(/BUILD_OUT: 'build.staging'/.test(readFileSync('scripts/staging.js', 'utf8')),
     '测试站走 build.staging');
}

console.log('\n━━━ 14. 局部变量不能和 rune 同名 ━━━');
{
  /**
   * 实测事故：GenrePicker 里定义了一个叫 state 的函数，Svelte 就把同一文件里的
   * `$state(false)` 当成「订阅名为 state 的 store」——面板一渲染就抛错，
   * 表现是「点击题材胶囊没反应」。编译器只给 warning，vite build 照样成功，
   * e2e 也测不到（那个面板是点开才渲染的），只能靠这条静态检查。
   */
  const RUNES = ['state', 'derived', 'effect', 'props', 'bindable', 'inspect', 'host'];
  const bad = [];
  for (const f of SVELTE) {
    const src = readFileSync(f, 'utf8');
    const head = src.slice(0, src.indexOf('</script>') + 1 || src.length);
    for (const r of RUNES) {
      const re = new RegExp(`\\b(?:const|let|var|function)\\s+${r}\\b`);
      if (re.test(head)) bad.push(`${f}: ${r}`);
    }
  }
  ok(bad.length === 0, '没有局部变量叫 state / derived / effect / props …', bad.join(', '));
}

console.log('\n━━━ 15. 界面文案不用「bgm」这个缩写 ━━━');
{
  /**
   * bgm 是 bangumi.tv 的域名缩写，可主人第一眼读成了 background music
   * （「bgm不是音乐吗？为什么动漫中文名字需要看bgm」）。
   * 数据库列名和内部 kind 键继续叫 bgm_*（改动静太大、收益只有可读性），
   * 但凡是会印到界面上的字，一律写站点全名 Bangumi。
   */
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/[^\n]*/gm, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // 只看引号里和标签之间的文字，避开 bgm_score 这类字段名和 bgm.tv 这类链接
  const bad = [];
  for (const f of [...SVELTE, ...JS]) {
    const src = stripComments(readFileSync(f, 'utf8'))
      .replace(/bgm_[a-z_]+/g, ' ')      // 字段名 / sync_log 的 kind 键
      .replace(/bgm\.tv/g, ' ');         // 外链地址
    if (/bgm/i.test(src)) bad.push(f);
  }
  ok(bad.length === 0, '界面文案里没有「bgm」，只写 Bangumi', bad.join(', '));
}

console.log('\n━━━ 15b. toast 是对象，不能当函数调 ━━━');
{
  /**
   * 实测事故：设置页写成 `toast(r.error)`。toast 导出的是
   * `{ ok, error }` 对象（见 lib/toast.svelte.js），当函数调就抛 TypeError，
   * 而它在 async 的点击处理器里 → 异常被吞成 unhandledrejection：
   * 主人点「添加」完全没反应、也没有任何提示。
   * 这类错误 SSR 测不到、e2e 走 HTTP 也测不到，只有 hooks.client.js 的上报
   * 事后能看到（日志里是压缩后的 `dt is not a function`，很难认）。
   * 所以在编译前就把这个写法拦掉。
   */
  const bad = [];
  for (const f of SVELTE.concat(JS)) {
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    // 允许 toast.ok( / toast.error( / toast.items；只拦 toast( 这种直接调用
    for (const m of src.matchAll(/(^|[^.\w])toast\s*\(/g)) bad.push(`${f}: ${m[0].trim()}…`);
  }
  ok(bad.length === 0, 'toast 只通过 toast.ok / toast.error 调用', bad.join('\n     '));
}

console.log('\n━━━ 16. {#each} 的 key 不能是拼出来的 ━━━');
{
  /**
   * 实测事故：设置页写成 `{#each data.syncs.slice(0,6) as s (s.kind + s.finished_at)}`，
   * 而这两个字段不唯一 —— 同一种同步任务在同一秒写完两条就撞了。
   * Svelte 抛 each_key_duplicate，水合崩掉，正式站的设置页整片空白。
   *
   * 拼接出来的 key 唯一性靠人脑保证，一旦数据里出现巧合就炸，而且：
   *   · SSR 不校验 key，HTTP 层的 e2e 测不出来
   *   · 测试站用的是被重置过的 dev.db，也不复现
   * 所以只允许拿单个字段当 key（`(x.id)` `(x.tag)` 这种）——
   * 唯一性该由数据本身保证，不该由表达式凑。
   */
  const bad = [];
  for (const f of SVELTE) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\{#each\s+[\s\S]*?\s+\(([^)]*)\)\s*\}/g)) {
      const key = m[1].trim();
      if (/[+`]/.test(key)) bad.push(`${f}: (${key})`);
    }
  }
  ok(bad.length === 0, '没有拼接出来的 {#each} key', bad.join('\n     '));
}

console.log('\n' + '═'.repeat(52));
console.log(`  通过 ${pass}   失败 ${fail}`);
if (fail) { console.log('\n失败项：'); fails.forEach((f) => console.log('  ✗ ' + f)); }
console.log('═'.repeat(52));
process.exit(fail ? 1 : 0);
