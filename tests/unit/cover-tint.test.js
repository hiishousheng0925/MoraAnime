/**
 * 按封面取色（方案 C）：$lib/coverTint.js 的公式 × 全色相扫描的对比度守卫，和 server/coverHue.js 的取色函数。
 * 公式 / 扫描逻辑搬自配色评估的 contrast.mjs：H 0–355° 每 5° 一档，深浅两套。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BASE, TINT, LIGHT_SKIP, tintPalette, coverTint, contrast, mixHex, oklchHex } from '../../src/lib/coverTint.js';
import { dominantHue, hueFromBuffer, okLch, isSkin } from '../../src/lib/server/coverHue.js';

const css = readFileSync(new URL('../../src/app.css', import.meta.url), 'utf8');
const block = (sel) => css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
const vars = (b) => Object.fromEntries([...b.matchAll(/--c-([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
const THEME = { dark: { ...vars(block(':root {')) }, light: { ...vars(block(":root[data-theme='light'] {")) } };
// 亮色块只写了覆盖项，没写的沿用暗色（实际上要比的 token 两边都有）
THEME.light = { ...THEME.dark, ...THEME.light };
const HUES = Array.from({ length: 72 }, (_, i) => i * 5);

test('coverTint 里抄的默认色和 app.css 一致（改了主题色要一起改）', () => {
  for (const t of ['dark', 'light']) for (const [k, v] of Object.entries(BASE[t]))
    assert.equal(v.toLowerCase(), THEME[t][k]?.toLowerCase(), `${t} --c-${k}`);
});

for (const t of ['dark', 'light']) {
  test(`${t === 'dark' ? '暗' : '亮'}色：色相 0–355° 每 5° 全扫，正文 / 次要字 / 强调字 / 按钮字 / 淡底上强调字 ≥4.5`, () => {
    let worst = { r: 99 };
    const chk = (what, fg, bg, h) => {
      const r = contrast(fg, bg);
      if (r < worst.r) worst = { r, what, h };
      assert.ok(r >= 4.5, `H=${h}° ${what}：${fg} on ${bg} 只有 ${r.toFixed(2)}:1`);
    };
    let tested = 0;
    for (const h of HUES) {
      const p = tintPalette(h, t);
      if (!p) continue;            // 亮色黄绿段不换色 = 默认色板，ui-audit 守着
      tested++;
      const v = { ...THEME[t], ...p };
      const bgs = ['bg', 'surface', 'surface-2'];
      for (const fg of ['text', 'text-soft', 'muted', 'accent']) for (const bg of bgs) chk(`${fg} / ${bg}`, v[fg], v[bg], h);
      chk('主按钮字 on-accent / accent', v['on-accent'], v.accent, h);
      for (const b of [...bgs, 'border']) for (const a of [0.05, 0.1, 0.15, 0.2, 0.25])
        chk(`accent-ink / accent ${a * 100}% 淡底叠 ${b}`, v['accent-ink'], mixHex(v.accent, a, v[b]), h);
      chk('.is-current 正文 / accent 12% 淡底', v.text, mixHex(v.accent, 0.12, v.surface), h);
      // 染过底色后，页面里其他固定色字（评分 warm、删除 danger、金银铜、连载中绿）也不能掉下去
      for (const fg of ['warm', 'danger', 'gold', 'silver', 'bronze', 'live-ink']) for (const bg of bgs) chk(`${fg} / ${bg}`, v[fg], v[bg], h);
    }
    assert.ok(tested >= (t === 'dark' ? 72 : 60), `扫到的色相太少：${tested}`);
    console.log(`  ${t} 最差 ${worst.r.toFixed(2)}:1（${worst.what}，H=${worst.h}°）`);
  });
}

test('暗色染底只染 3–4%（边框 6%），亮色不染底', () => {
  assert.deepEqual(Object.values(TINT.dark.wash).filter((a) => a > 0.04 && a !== 0.06), []);
  assert.equal(TINT.light.wash, null);
  const p = tintPalette(200, 'light');
  assert.deepEqual(Object.keys(p).sort(), ['accent', 'accent-ink', 'on-accent']);
});

test('亮色黄 / 黄绿段回到默认蓝，暗色照常换；没有色相时不挂变量', () => {
  for (const h of [LIGHT_SKIP[0], 100, LIGHT_SKIP[1]]) {
    assert.equal(tintPalette(h, 'light'), null, `${h}°`);
    const c = coverTint(h);
    assert.equal(c.light, false);
    assert.match(c.style, /--cd-accent: #/);
    assert.doesNotMatch(c.style, /--cl-/);
  }
  const pink = coverTint(4);
  assert.equal(pink.light, true);
  assert.match(pink.style, /--cl-accent: #[0-9a-f]{6}/);
  for (const h of [null, undefined, -1, 360, NaN]) assert.equal(coverTint(h), null, String(h));
});

test('oklchHex：出色域时降彩度而不是截断（色相不偏）', () => {
  // 暗色 L 0.80 C 0.12 的紫在 sRGB 外，降彩度后色相仍在 ±3° 内
  for (const h of [0, 145, 200, 265, 300]) {
    const hex = oklchHex(0.8, 0.12, h);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [, , H] = okLch(r, g, b);
    assert.ok(Math.abs(((H - h + 540) % 360) - 180) <= 3, `${h}° → ${hex} 实际 ${H.toFixed(1)}°`);
  }
});

/** 造一张 w×h 的 RGBA 图：fill(x, y) → [r, g, b] */
const img = (w, h, fill) => {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; d.set([...fill(x, y), 255], i); }
  return d;
};
const hueOf = (rgb) => okLch(...rgb)[2];
const near = (a, b, tol = 3) => Math.abs(((a - b + 540) % 360) - 180) <= tol;

test('取色：灰图 / 黑白图返回 null', () => {
  assert.equal(dominantHue(img(60, 90, () => [128, 128, 128]), 60, 90), null);
  assert.equal(dominantHue(img(60, 90, (x, y) => ((x + y) % 2 ? [250, 250, 250] : [15, 15, 15])), 60, 90), null);
  // 黑白封面上零星一点红（< 6%）也不算有主色
  assert.equal(dominantHue(img(100, 100, (x, y) => (x < 4 ? [220, 30, 40] : [200, 200, 200])), 100, 100), null);
});

test('取色：纯色图返回对应色相', () => {
  for (const c of [[230, 60, 140], [40, 120, 230], [60, 180, 90], [240, 200, 40], [150, 70, 220]]) {
    const h = dominantHue(img(40, 60, () => c), 40, 60);
    assert.ok(near(h, hueOf(c)), `${c} 期望 ${hueOf(c).toFixed(0)}° 实际 ${h}`);
  }
});

test('取色：肤色被排除 —— 大片肤色 + 一块蓝衣服 → 蓝', () => {
  const skin = [245, 200, 170], shade = [225, 160, 125], blue = [50, 90, 200];
  assert.ok(isSkin(...okLch(...skin)) && isSkin(...okLch(...shade)), '样本肤色要落在肤色区间里');
  const h = dominantHue(img(100, 150, (x, y) => (y < 110 ? (x % 3 ? skin : shade) : blue)), 100, 150);
  assert.ok(near(h, hueOf(blue)), `期望蓝 ${hueOf(blue).toFixed(0)}° 实际 ${h}`);
  // 只有肤色 → 没有主色
  assert.equal(dominantHue(img(50, 50, () => skin), 50, 50), null);
});

test('取色：按彩度加权 —— 同样面积时鲜艳的颜色胜过灰扑扑的', () => {
  const dull = [120, 140, 110], vivid = [220, 40, 60];
  const h = dominantHue(img(100, 100, (x) => (x < 55 ? dull : vivid)), 100, 100);
  assert.ok(near(h, hueOf(vivid)), `实际 ${h}`);
});

test('取色：真实编码的 JPEG / PNG 能解出来，WebP 等解不开的返回 null', async () => {
  const { createRequire } = await import('node:module');
  const { jpegjs, PNG } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
  const w = 32, h = 48, data = Buffer.from(img(w, h, () => [200, 30, 90]));
  const jpg = jpegjs.encode({ data, width: w, height: h }, 90).data;
  assert.ok(near(await hueFromBuffer(jpg), hueOf([200, 30, 90]), 4));
  const png = new PNG({ width: w, height: h }); data.copy(png.data);
  assert.ok(near(await hueFromBuffer(PNG.sync.write(png)), hueOf([200, 30, 90])));
  assert.equal(await hueFromBuffer(Buffer.from('RIFF0000WEBPVP8 ')), null);
  assert.equal(await hueFromBuffer(Buffer.from([0xff, 0xd8, 0, 1, 2])), null, '坏 JPEG 不抛错');
});
