/**
 * 2026-10-20 观看页实测那一批（#89–#100）的服务端部分。浏览器里的交互在 tests/watch-ui.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEpisodes, sameSite } from '../../src/lib/server/sources/scrape.js';
import { cached, budget, HTML_BUDGET } from '../../src/lib/server/sources/index.js';
import { WAIT_MS } from '../../src/lib/server/sources/sniff.js';
import { addDays } from '../../src/lib/server/episodes.js';

/** ezdmw 的规则原样（Kazumi 规则仓库）：选集是四段 /self::* 的并集 */
const EZDMW = {
  baseURL: 'https://m.ezdmw.org/',
  chapterRoads: "//section[@class='anthology'][1]/div[contains(@class,'line_button')]",
  chapterResult: "/self::*[@class='line_button_ban']/following-sibling::a[@class='circuit_switch_ban'] | /self::*[@class='line_button1']/following-sibling::a[@class='circuit_switch1'] | /self::*[@class='line_button3']/following-sibling::a[@class='circuit_switch3'] | /self::*[@class='line_button2']/following-sibling::a[@class='circuit_switch2']"
};
const PAGE = `<html><body><section class="anthology">
  <div class="line_button_ban">线路一</div>
  <a class="circuit_switch_ban" href="/play/1-1.html">01</a><a class="circuit_switch_ban" href="/play/1-2.html">02</a>
  <div class="line_button1">线路二（空）</div>
  <div class="line_button2">线路三</div>
  <a class="circuit_switch2" href="/play/3-3.html">03</a><a class="circuit_switch2" href="/play/3-2.html">02</a><a class="circuit_switch2" href="/play/3-1.html">01</a>
</section></body></html>`;

test('#97 并集 XPath 每一段都对线路节点求值：后几段的线路也取得到剧集', () => {
  const roads = parseEpisodes(EZDMW, PAGE, 'https://m.ezdmw.org/Index/bangumi/1.html');
  assert.equal(roads.length, 2, JSON.stringify(roads));
  assert.equal(roads[1].eps.length, 3, '第三段（circuit_switch2）原来一集都取不到');
  assert.equal(roads[0].eps[0].url, 'https://m.ezdmw.org/play/1-1.html', '相对地址补成绝对地址');
});

test('#99 先去掉空线路再编号：线路1、线路2，不是线路1、线路3', () => {
  assert.deepEqual(parseEpisodes(EZDMW, PAGE, 'https://m.ezdmw.org/x').map((r) => r.name), ['线路1', '线路2']);
});

test('#93 倒序的线路翻正（DM84：3 / 2 / 1）', () => {
  assert.deepEqual(parseEpisodes(EZDMW, PAGE, 'https://m.ezdmw.org/x')[1].eps.map((e) => e.name), ['01', '02', '03']);
});

test('#91 链接过期后只放行规则所属站点自己的页面', () => {
  assert.ok(sameSite(EZDMW, 'https://m.ezdmw.org/play/1-1.html'));
  assert.ok(sameSite(EZDMW, 'https://www.ezdmw.org/play/1-1.html'), 'www. / m. 前缀不同算同一个站');
  for (const bad of ['https://evil.com/play/1.html', 'https://ezdmw.org.evil.com/x', 'http://127.0.0.1:3000/',
                     'file:///C:/Windows/win.ini', 'javascript:alert(1)', '', null]) {
    assert.ok(!sameSite(EZDMW, bad), String(bad));
  }
});

test('#90 失败的结果不进缓存（「重新加载」不能拿回那次失败），fresh 跳过缓存', async () => {
  let n = 0;
  const fail = () => { n++; return null; };
  await cached('t:fail', fail, { keep: (v) => v != null });
  await cached('t:fail', fail, { keep: (v) => v != null });
  assert.equal(n, 2, '失败的结果被缓存了');
  let m = 0;
  const ok = () => ({ url: `u${++m}` });
  assert.equal((await cached('t:ok', ok)).url, 'u1');
  assert.equal((await cached('t:ok', ok)).url, 'u1', '成功的照常缓存');
  assert.equal((await cached('t:ok', ok, { fresh: true })).url, 'u2', 'fresh 重新取');
});

test('#100 解析限时：读 HTML 6 秒、嗅探 8 秒，到点当作没结果', async () => {
  assert.ok(HTML_BUDGET <= 6000 && WAIT_MS <= 8000, `${HTML_BUDGET} / ${WAIT_MS}`);
  const t = Date.now();
  assert.equal(await budget(new Promise(() => {}), 50), null, '永远不回的请求到点给 null');
  assert.ok(Date.now() - t < 1000);
  assert.equal(await budget(Promise.resolve('x'), 50), 'x');
});

test('#89 测试站的登录 cookie 和正式站不同名（同域不同端口会互删）', () => {
  const auth = fileURLToPath(new URL('../../src/lib/server/auth.js', import.meta.url)).replace(/\\/g, '/');
  const run = (staging) => spawnSync(process.execPath,
    ['--input-type=module', '-e', `import('file:///${auth.replace(/^\//, '')}').then((m) => console.log(m.COOKIE))`],
    { encoding: 'utf8', env: { ...process.env, J_ANIME_STAGING: staging } }).stdout.trim();
  assert.equal(run('1'), 'j_anime_sid_test');
  assert.equal(run(''), 'j_anime_sid');
});

test('#98 日期加减（已播集数往后多算两天用）', () => {
  assert.equal(addDays('2026-10-20', 2), '2026-10-22');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});
