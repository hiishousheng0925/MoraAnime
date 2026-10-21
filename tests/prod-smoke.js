/**
 * 生产模式冒烟验收。只对【构建产物】+【开启鉴权】才有意义，dev 模式测不出来。
 *
 * 存在的理由：「登录永远 403」那个 bug 在 dev 下完全正常，一上生产就废 ——
 * adapter-node 在没有 PROTOCOL_HEADER 时把协议默认成 https（handler.js:210），
 * 直连 http 推出的 origin 和浏览器发的 Origin 头不符，SvelteKit 的 CSRF 检查
 * 回一句 "Cross-site POST form submissions are forbidden"。
 * 只有在构建产物上真正走一遍表单登录，才能守住这一类问题。
 *
 * 用法：node scripts/test.js --build build prod-smoke
 */
const BASE = process.env.BASE || 'http://localhost:5199';
const PW = process.env.TEST_PASSWORD;

import { assertTestCopy } from './copy-gate.js';
assertTestCopy('请用  node scripts/test.js --build build prod-smoke');
if (!PW) {
  console.error('\n❌ 没拿到 TEST_PASSWORD —— 这套测试必须由 scripts/test.js 启动\n');
  process.exit(2);
}

let pass = 0, fail = 0;
const fails = [];
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  (${detail})` : ''}`); }
  else { fail++; fails.push(`${name} ${detail}`); console.log(`  ❌ ${name}  ${detail}`); }
};

const get = (path, cookie) =>
  fetch(BASE + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });

/**
 * 登录（多账号，2026-10-19 起是弹窗调 /api/auth）：必须带 Origin，才能真正走到 CSRF 校验那一步。
 * 管理员 id 1 的密码由 scripts/test.js 设成本轮随机的 TEST_PASSWORD。
 */
const login = (password, ident = 'admin') =>
  fetch(`${BASE}/api/auth`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ op: 'login', ident, password })
  });

const cookieOf = (res) => {
  const raw = res.headers.getSetCookie?.() ?? [];
  const m = raw.find((c) => c.startsWith('j_anime_sid='));
  return m ? m.split(';')[0] : null;
};

console.log('\n━━━ 1. 不登录也能逛，个人页留在原页给登录入口 ━━━');
{
  for (const p of ['/', '/catalog', '/schedule', '/ranking', '/seasons', '/mine', '/stats', '/triage', '/settings']) {
    const r = await get(p);
    ok(r.status === 200, `${p} 访客 → 200`, `得到 ${r.status}`);
  }
  ok((await (await get('/mine')).text()).includes('登录后查看你的番单'), '/mine 访客看到登录入口');
  const r = await get('/login?to=%2Fmine');
  ok(r.status === 303 && r.headers.get('location') === '/mine?login=1', '旧登录页 → 回原页并弹登录框', `${r.status} ${r.headers.get('location')}`);
}

console.log('\n━━━ 2. 写操作不能靠 GET 绕过 ━━━');
{
  const r = await fetch(`${BASE}/api/entry`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ id: 1, status: 'completed' })
  });
  ok(r.status === 401, 'POST /api/entry → 401', `得到 ${r.status}`);
}

console.log('\n━━━ 3. 登录（守 CSRF / ORIGIN 那一类 bug）━━━');
let auth = null;
{
  const bad = await login('definitely-not-the-password');
  ok(bad.status !== 403, '错密码不该是 403 —— 403 说明 CSRF 把请求挡掉了，登录根本没跑到',
     `得到 ${bad.status}`);
  ok(!cookieOf(bad), '错密码不发 cookie');

  const good = await login(PW);
  ok(good.status !== 403, '对密码不该是 403（同上）', `得到 ${good.status}`);
  auth = cookieOf(good);
  ok(!!auth, '对密码发了会话 cookie');
}

console.log('\n━━━ 4. 登录后所有页面可用 ━━━');
{
  if (!auth) ok(false, '拿不到 cookie，后续断言无法进行');
  else {
    for (const p of ['/', '/schedule', '/triage', '/catalog', '/seasons',
                     '/mine', '/ranking', '/stats', '/settings']) {
      const r = await get(p, auth);
      ok(r.status === 200, `${p} → 200`, `得到 ${r.status}`);
    }
    const cat = await (await get('/catalog', auth)).text();
    const n = new Set(cat.match(/href="\/anime\/(\d+)"/g) || []).size;
    ok(n > 20, '目录有内容（说明连的是真库不是空库）', `${n} 部`);

    /**
     * 页码超出末页要退回末页，不能返回空列表。
     * 实测：在番单「未评分」的最后一页把剩下的番都打了分，回到列表这一页已经空了，
     * 界面显示「此分类暂无内容 / 去快速标记」，像是番单被清空了。
     */
    const cards = (html) => new Set(html.match(/href="\/anime\/(\d+)"/g) || []).size;
    for (const p of ['/catalog?p=99999', '/mine?p=99999', '/mine?ms=none&p=99999']) {
      const r = await get(p, auth);
      const html = await r.text();
      ok(r.status === 200 && (cards(html) > 0 || html.includes('无结果') || html.includes('暂无内容')),
         `${p} 不报错`, `得到 ${r.status}`);
      // 有内容的分类下，越界页码必须退回末页而不是给空列表
      if (!p.includes('ms=none')) ok(cards(html) > 0, `${p} 退回末页（有卡片）`, `${cards(html)} 张`);
    }
    const mineNone = await (await get('/mine?ms=none&p=99999', auth)).text();
    ok(!(cards(mineNone) === 0 && mineNone.includes('去快速标记')),
       '「未评分」筛空时不该显示「去快速标记」（那是「此分类暂无内容」才对）');
  }
}

console.log('\n━━━ 5. 伪造 cookie 不能通过 ━━━');
{
  for (const c of ['j_anime_sid=' + 'A'.repeat(43), 'j_anime_sid=garbage', 'j_anime_auth=99999999999999.fakesig']) {
    const r = await fetch(`${BASE}/api/export`, { headers: { Cookie: c } });
    ok(r.status === 401, `伪造「${c.slice(0, 24)}…」被挡`, `得到 ${r.status}`);
  }
}

console.log('\n━━━ 6. 公开路径不该被鉴权挡住 ━━━');
{
  const share = await get('/share/definitely-not-a-real-token');
  ok(share.status === 404, '/share/<无效token> → 404', `得到 ${share.status}`);
  const cover = await get('/cover/1');
  ok([200, 404].includes(cover.status), '/cover/1 不被鉴权挡', `得到 ${cover.status}`);
}

console.log('\n' + '═'.repeat(52));
console.log(`  通过 ${pass}   失败 ${fail}`);
if (fail) { console.log('\n失败项：'); fails.forEach((f) => console.log('  ✗ ' + f)); }
console.log('═'.repeat(52));
process.exit(fail ? 1 : 0);
