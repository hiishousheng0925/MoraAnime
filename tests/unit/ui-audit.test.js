/**
 * 2026-10-20 全站 UI 审查那一批（#102–#112）里不依赖数据库 / 浏览器的部分。
 * 数据库相关的在 tests/e2e.js §25，浏览器里的在 tests/watch-ui.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { heatWeeks, heatCuts, heatLevel } from '../../src/lib/heatmap.js';
import { pickQ } from '../../src/lib/server/loaderUtil.js';
import { normStudio } from '../../src/lib/server/text.js';
import { dispStudio } from '../../src/lib/format.js';

test('#105 热力图：周一起算，最后一列是本周，今天之后的格子标成 future', () => {
  const tue = new Date(2026, 9, 20, 10);           // 2026-10-20 周二
  const w = heatWeeks(tue, new Map([['2026-10-18', 28]]));
  assert.equal(w.length, 26);
  assert.equal(w[0][0].key, '2026-04-27', '第一格是周一');
  const last = w.at(-1);
  assert.deepEqual(last.map((d) => d.key), ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  assert.deepEqual(last.map((d) => d.future), [false, false, true, true, true, true, true]);
  assert.equal(w.at(-2)[6].c, 28, '10-18（周日）在上一列最后一格');
  // 今天正好是周一 / 周日
  assert.equal(heatWeeks(new Date(2026, 9, 19), new Map()).at(-1)[0].key, '2026-10-19');
  assert.equal(heatWeeks(new Date(2026, 9, 25), new Map()).at(-1)[6].future, false);
});

test('#105 热力图深浅按分位数：一天 363 条不会把平时的记录全压到最淡一档', () => {
  const days = [363, 165, 154, 1, 3, 1, 1, 28, 4, 4];
  const cuts = heatCuts(days);
  const lv = (c) => heatLevel(c, cuts);
  assert.equal(lv(0), 0);
  assert.ok(lv(28) >= 3, `28 条应该是深色档，实际 ${lv(28)}`);
  assert.ok(lv(4) > lv(1), '4 条比 1 条深');
  assert.equal(lv(363), 4);
  assert.equal(heatLevel(5, heatCuts([])), 4, '没有数据时不出错');
});

test('#108 只有空格 / 符号的搜索词当作没搜', () => {
  const q = (v) => pickQ(new URLSearchParams(v == null ? '' : `q=${encodeURIComponent(v)}`));
  for (const v of ['   ', '%', '%%', '!!!', '・', '', null]) assert.equal(q(v), null, JSON.stringify(v));
  assert.equal(q('  芙莉莲 '), '芙莉莲');
  assert.equal(q('86'), '86');
  assert.equal(q('K'), 'K');
});

test('#109 公司名归一：8-bit / 8 bit / 8bit 是一家，dōga kōbō = doga kobo，a-1 pictures 不被并成一个词', () => {
  assert.equal(new Set(['8-bit', '8 bit', '8bit', '8bit corp, inc.']).size, 4);
  assert.equal(new Set(['8-bit', '8 bit', '8bit', '8bit corp, inc.'].map(normStudio)).size, 1);
  assert.equal(normStudio('dōga kōbō'), normStudio('doga kobo'));
  assert.equal(normStudio('a-1 pictures'), 'a1 pictures');
  assert.equal(normStudio('j.c.staff co., ltd.'), normStudio('j.c. staff'));
  assert.notEqual(normStudio('olm'), normStudio('olm digital'), '不同公司不合并');
});

test('#109 公司名展示：缩写全大写、官方写法、变音符号的词不被拆开', () => {
  const cases = { 'olm, inc.': 'OLM', 'dle inc.': 'DLE', 'tms entertainment co., ltd.': 'TMS Entertainment', 'madhouse inc.': 'Madhouse',
    'mappa co., ltd.': 'MAPPA', 'j.c.staff co., ltd.': 'J.C.Staff', '8bit corp, inc.': '8bit', '8-bit': '8bit', 'ufotable, inc.': 'ufotable',
    'cloverworks inc.': 'CloverWorks', 'a-1 pictures': 'A-1 Pictures', 'toei animation': 'Toei Animation', 'dōga kōbō': 'Dōga Kōbō',
    'olm digital, inc.': 'OLM Digital', 'studio deen': 'Studio Deen' };
  for (const [raw, want] of Object.entries(cases)) assert.equal(dispStudio(raw), want, raw);
});

/** 从 app.css 读主题变量，算对比度 */
const css = readFileSync(new URL('../../src/app.css', import.meta.url), 'utf8');
const block = (sel) => css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
const vars = (b) => Object.fromEntries([...b.matchAll(/--c-([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
const lum = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('#111 两套主题的次要文字 / 强调色 / 正文在底色、卡片、二级底色上都 ≥ 4.5:1', () => {
  for (const [name, sel] of [['暗色', ':root {'], ['亮色', ":root[data-theme='light'] {"]]) {
    const v = vars(block(sel));
    for (const fg of ['muted', 'accent', 'text', 'text-soft']) {
      for (const bg of ['bg', 'surface', 'surface-2']) {
        const r = ratio(v[fg], v[bg]);
        assert.ok(r >= 4.5, `${name} ${fg} ${v[fg]} 在 ${bg} ${v[bg]} 上只有 ${r.toFixed(2)}:1`);
      }
    }
    assert.ok(ratio(v['on-accent'], v.accent) >= 4.5, `${name} 主按钮文字`);
  }
});

test('#109 撇号不算断词（Brain\'s Base 不是 Brain\'S Base），eightbit 和 8bit 是同一家', () => {
  assert.equal(dispStudio("brain's base"), "Brain's Base");
  assert.equal(dispStudio("tms jinni's"), "TMS Jinni's");
  assert.equal(normStudio('eightbit'), normStudio('8bit'));
  assert.equal(dispStudio('eightbit'), '8bit');
});

test('#111 半透明暖色底上的徽标、侧栏选中行、测试站暖色顶栏上的文字也 ≥ 4.5:1（两套主题）', () => {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const hexOf = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const mix = (fg, a, bg) => hexOf(rgb(fg).map((v, i) => v * a + rgb(bg)[i] * (1 - a)));
  for (const [name, sel] of [['暗色', ':root {'], ['亮色', ":root[data-theme='light'] {"]]) {
    const v = vars(block(sel));
    // +layout.svelte 测试站顶栏：表面色（bg-ink-900/90，按不透明算）上叠 8% warm-fill（.hdr.test）
    const testHeader = mix(v['warm-fill'], 0.08, v.surface);
    const cases = {
      '顶栏 TEST 徽标（bg-warm/15）': [v.warm, mix(v.warm, 0.15, testHeader)],
      '侧栏选中行里的计数徽标（bg-warm/15 叠在 ink-700 上）': [v.warm, mix(v.warm, 0.15, v.border)],
      '侧栏计数徽标（bg-warm/15 叠在 surface 上）': [v.warm, mix(v.warm, 0.15, v.surface)],
      '测试站顶栏上的次要文字（在看 N / 待标记）': [v.muted, testHeader]
    };
    for (const [what, [fg, bg]] of Object.entries(cases)) {
      const r = ratio(fg, bg);
      assert.ok(r >= 4.5, `${name} ${what}：${fg} on ${bg} = ${r.toFixed(2)}:1`);
    }
  }
});

test('#109 带点的缩写和不带点的是同一家；数字开头的词不改大小写；更多缩写', () => {
  assert.equal(normStudio('a.c.g.t'), normStudio('acgt'));
  assert.equal(normStudio('a.p.p.p.'), normStudio('appp'));
  assert.equal(normStudio('aic a.s.t.a.'), normStudio('aic asta'));
  assert.equal(normStudio('j.c.staff'), normStudio('j.c. staff'), '两个单字母的不受影响');
  const cases = { '1st studio': '1st Studio', 'signal.md': 'Signal.MD', 'emt squared': 'EMT Squared', 'dmm.futureworks': 'DMM.futureworks',
    'bn pictures': 'BN Pictures', 'production ims': 'Production IMS', 'tyo animations': 'TYO Animations', 'hal film maker': 'HAL Film Maker',
    'studio 4°c': 'Studio 4°C' };
  for (const [raw, want] of Object.entries(cases)) assert.equal(dispStudio(raw), want, raw);
});

test('#111 红字（删除 / 排除 / 报错）用 --c-danger，两套主题在底色、卡片、红色淡底上都 ≥ 4.5:1', () => {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const hexOf = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const mix = (fg, a, bg) => hexOf(rgb(fg).map((v, i) => v * a + rgb(bg)[i] * (1 - a)));
  for (const [name, sel] of [['暗色', ':root {'], ['亮色', ":root[data-theme='light'] {"]]) {
    const v = vars(block(sel));
    assert.ok(v.danger, `${name} 没定义 --c-danger`);
    for (const bg of [v.bg, v.surface, v['surface-2'], mix('#ef4444', 0.1, v.surface), mix('#ef4444', 0.1, v.bg)]) {
      const r = ratio(v.danger, bg);
      assert.ok(r >= 4.5, `${name} danger ${v.danger} on ${bg} = ${r.toFixed(2)}`);
    }
  }
});

test('#111 源码里不再写死只适合暗底的浅红字（text-red-300 / 400）', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('../../src', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  const hits = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p);
    else if (/\.svelte$/.test(f) && /text-red-[34]00/.test(readFileSync(p, 'utf8'))) hits.push(p); } };
  walk(root);
  assert.deepEqual(hits, [], '改用 text-danger');
});

/** src 下所有 .svelte 的 [路径, 内容] */
const svelteFiles = async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const out = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.svelte$/.test(f)) out.push([p, readFileSync(p, 'utf8')]); } };
  walk(new URL('../../src', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
  return out;
};

test('#111 淡底上的强调色字用 accent-ink：两套主题在 5–25% 淡底叠任意底色上都 ≥ 4.5:1', () => {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const hexOf = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const mix = (fg, a, bg) => hexOf(rgb(fg).map((v, i) => v * a + rgb(bg)[i] * (1 - a)));
  for (const [name, sel] of [['暗色', ':root {'], ['亮色', ":root[data-theme='light'] {"]]) {
    const v = vars(block(sel));
    for (const base of [v.bg, v.surface, v['surface-2'], v.border]) for (const a of [0.05, 0.1, 0.15, 0.2, 0.25]) {
      const r = ratio(v['accent-ink'], mix(v.accent, a, base));
      assert.ok(r >= 4.5, `${name} accent-ink on accent/${a * 100} over ${base} = ${r.toFixed(2)}`);
    }
  }
});

test('#111 源码守卫：淡底上不用 text-accent；文字（span）不加半透明', async () => {
  const tint = [], faded = [];
  for (const [p, s] of await svelteFiles()) {
    s.split('\n').forEach((line, i) => {
      if (/bg-accent\/\d+/.test(line) && /(?<![\w:-])text-accent(?![\w/-])/.test(line)) tint.push(`${p}:${i + 1}`);
      if (/<span[^>]*class="[^"]*(?<![\w:-])opacity-[1-9]0\b/.test(line)) faded.push(`${p}:${i + 1}`);
    });
  }
  assert.deepEqual(tint, [], '强调色淡底上的字改用 text-accent-ink');
  assert.deepEqual(faded, [], '文字别用 opacity 调浅，用 text-ink-400 这类实色 token');
});
