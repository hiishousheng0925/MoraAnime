/**
 * 按封面取色（2026-10 配色改进，方案 C）：详情页 / 观看页的强调色跟着封面主色相走。
 *
 * 只取色相 H（服务端算好存在 anime.cover_hue，见 server/coverHue.js），亮度和彩度固定：
 *   暗  accent = oklch(0.80 0.12 H)   accent-ink = oklch(0.90 0.06 H)   底色 / 卡片 / 边框往 H 染 3–4%（边框 6%）
 *   亮  accent = oklch(0.50 0.15 H)   accent-ink = oklch(0.39 0.12 H)   不染底
 * 固定亮度 + 封顶彩度 → 任何色相都过对比度；tests/unit/cover-tint.test.js 按 0–355° 每 5° 全扫守着。
 * 染底只到 3–4%：评估实测 4–5% 时最差一项（muted / surface-2）只剩 4.55，没有余量。
 *
 * 亮色下的黄 / 黄绿（85–125°）：L 0.50 的黄 / 黄绿只能是橄榄色，发脏 —— 压低亮度只会更像泥。
 * （实测色条：80° 以下还是赭石 / 金棕，130° 起是草绿，中间这段全是橄榄。）
 * 所以亮色在这一段不换色，回到默认蓝；暗色（L 0.80 是干净的芥黄 / 嫩绿）照常换。
 *
 * hex 在 JS 里算好再写进内联 style（不用 CSS 的 oklch()）：出色域时这里按「降彩度」映射，
 * 和测试量的是同一个值；浏览器的 oklch() 出色域是逐通道截断，色相会偏、对比度也不再是测过的那个。
 *
 * 变量只挂在详情 / 观看页的内容容器上（.cover-tint + 内联 style），不碰 :root ——
 * 侧栏、顶栏、其他页面不受影响。挂到 body 的弹窗 / Sheet 不在容器里，保持默认蓝。
 */

/** 默认两套主题里会被改写 / 参与对比度计算的值（和 app.css 一致；cover-tint.test.js 校验没走样） */
export const BASE = {
  dark: { bg: '#0a0c12', surface: '#181d29', 'surface-2': '#232a39', border: '#313a4d', 'border-strong': '#414c62',
          muted: '#8f9aad', 'text-soft': '#c6cedb', text: '#e8ecf3', 'on-accent': '#0a0c12' },
  light: { bg: '#e9ecf1', surface: '#ffffff', 'surface-2': '#f4f6f9', border: '#d3d9e3', 'border-strong': '#b6bfcd',
           muted: '#565f71', 'text-soft': '#3d465a', text: '#10141c', 'on-accent': '#ffffff' }
};

export const TINT = {
  dark: { L: 0.80, C: 0.12, inkL: 0.90, inkC: 0.06,
          // 染底比例：底色 3% / 卡片 4% / 二级底色 3% / 边框 6%
          wash: { bg: 0.03, surface: 0.04, 'surface-2': 0.03, border: 0.06, 'border-strong': 0.06 } },
  light: { L: 0.50, C: 0.15, inkL: 0.39, inkC: 0.12, wash: null }
};

/** 亮色下回到默认蓝的色相段（含两端） */
export const LIGHT_SKIP = [85, 125];

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hexOf = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/** fg 以 a 的比例叠在 bg 上（sRGB 线性插值，和 color-mix(in srgb) 一致） */
export const mixHex = (fg, a, bg) => hexOf(rgb(fg).map((v, i) => v * a + rgb(bg)[i] * (1 - a)));

const lum = (h) => {
  const [r, g, b] = rgb(h).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG 对比度 */
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** OKLCH → sRGB hex；出 sRGB 色域时逐步降彩度（色相、亮度不变） */
export function oklchHex(L, C, H) {
  const conv = (c) => {
    const a = c * Math.cos(H * Math.PI / 180), b = c * Math.sin(H * Math.PI / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  };
  let c = C, lin = conv(c);
  while (lin.some((v) => v < -1e-4 || v > 1 + 1e-4) && c > 0) { c = Math.max(0, c - 0.002); lin = conv(c); }
  return hexOf(lin.map((v) => {
    v = Math.max(0, Math.min(1, v));
    return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  }));
}

/** 色相是不是可用的值（null / -1「无」/ 越界 都不是） */
export const validHue = (h) => Number.isFinite(h) && h >= 0 && h < 360;

/**
 * 某个色相在一套主题下的整套色板；这套主题不换色（亮色黄绿段）时返回 null。
 * 只含要改写的 token；没改的（text / muted …）沿用默认。
 */
export function tintPalette(h, theme) {
  if (!validHue(h)) return null;
  if (theme === 'light' && h >= LIGHT_SKIP[0] && h <= LIGHT_SKIP[1]) return null;
  const t = TINT[theme], base = BASE[theme];
  const accent = oklchHex(t.L, t.C, h);
  const p = { accent, 'accent-ink': oklchHex(t.inkL, t.inkC, h) };
  // 主按钮字：默认值和反色里挑对比度高的那个（实际两套主题都是默认值胜出，留着兜底）
  const alt = base['on-accent'] === '#ffffff' ? base.bg : '#ffffff';
  p['on-accent'] = contrast(base['on-accent'], accent) >= contrast(alt, accent) ? base['on-accent'] : alt;
  if (t.wash) for (const [k, a] of Object.entries(t.wash)) p[k] = mixHex(accent, a, base[k]);
  return p;
}

/**
 * 详情 / 观看页内容容器的内联 style：两套主题的值都写上（--cd-* 暗 / --cl-* 亮），
 * app.css 的 .cover-tint 按当前主题取用 —— 切主题不用重算、不闪。
 * 没有可用色相返回 null（容器不加 .cover-tint，全用默认蓝）。
 */
export function coverTint(h) {
  const dark = tintPalette(h, 'dark');
  if (!dark) return null;
  const light = tintPalette(h, 'light');
  const decl = (pre, p) => Object.entries(p).map(([k, v]) => `--${pre}-${k}: ${v}`);
  return {
    style: [...decl('cd', dark), ...(light ? decl('cl', light) : [])].join('; '),
    // 亮色不换色（黄绿段）时不挂 data-tint-light，app.css 的亮色规则就不生效
    light: !!light
  };
}
