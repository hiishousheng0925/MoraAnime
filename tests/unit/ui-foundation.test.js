/**
 * UI 大改（2026-10）基础段：新 token 的对比度、源码里不用未定义的颜色名。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(new URL('../../src/app.css', import.meta.url), 'utf8');
const block = (sel) => css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
const vars = (b) => Object.fromEntries([...b.matchAll(/--c-([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
const lum = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const THEMES = [['暗色', ':root {'], ['亮色', ":root[data-theme='light'] {"]];

test('金银铜 / 四季 / 连载中绿字：两套主题在底色、卡片、二级底色上都 ≥ 4.5:1', () => {
  for (const [name, sel] of THEMES) {
    const v = vars(block(sel));
    for (const fg of ['gold', 'silver', 'bronze', 'season-winter', 'season-spring', 'season-summer', 'season-fall', 'live-ink']) {
      assert.ok(v[fg], `${name} 没定义 --c-${fg}`);
      for (const bg of ['bg', 'surface', 'surface-2']) {
        const r = ratio(v[fg], v[bg]);
        assert.ok(r >= 4.5, `${name} ${fg} ${v[fg]} 在 ${bg} 上只有 ${r.toFixed(2)}:1`);
      }
    }
  }
});

test('亮色填充块（warm-fill / 金银铜 -fill）上的 on-fill 深字 ≥ 4.5:1', () => {
  for (const [name, sel] of THEMES) {
    const v = vars(block(sel));
    for (const f of ['warm-fill', 'gold-fill', 'silver-fill', 'bronze-fill', 'live']) {
      const r = ratio(v['on-fill'], v[f]);
      assert.ok(r >= 4.5, `${name} on-fill 在 ${f} ${v[f]} 上只有 ${r.toFixed(2)}:1`);
    }
  }
});

test('封面上「看完」徽标的亮绿字在最坏情况（白封面 + 黑 /70 玻璃底 = #4d4d4d）≥ 4.5:1', () => {
  for (const [name, sel] of THEMES) {
    const v = vars(block(sel));
    assert.ok(ratio(v.live, '#4d4d4d') >= 4.5, `${name} live ${v.live}`);
  }
});

test('源码里用到的 ink-NNN 颜色名都在 @theme 里定义过（曾有 text-ink-100 / text-ink-500 没定义、静默失效）', () => {
  const defined = new Set([...css.matchAll(/--color-ink-(\d+):/g)].map((m) => m[1]));
  const hits = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p);
    else if (/\.(svelte|js)$/.test(f)) for (const m of readFileSync(p, 'utf8').matchAll(/\b(?:text|bg|border|ring|from|via|to|fill|stroke|outline|divide|shadow|decoration|placeholder)-ink-(\d+)/g))
      if (!defined.has(m[1])) hits.push(`${p}: ${m[0]}`); } };
  walk(new URL('../../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.deepEqual(hits, []);
});
