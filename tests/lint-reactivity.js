/**
 * 静态检查：组件里从 $props() 取的值，不能用非响应式的 const 计算。
 *
 * 为什么需要这条：Chip.svelte 曾把样式写成 `const cls = ...on...`，
 * const 只求值一次，导致「URL 和内容都更新了，只有高亮不动，刷新才对」。
 * 这类 bug 没有浏览器很难测出来，所以用静态检查兜住。
 */
import { readFileSync, readdirSync } from 'node:fs';

const walk = (d) => readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));

export function checkReactivity(root = 'src') {
  const bad = [];
  for (const f of walk(root).filter((x) => x.endsWith('.svelte'))) {
    const src = readFileSync(f, 'utf8');
    const end = src.indexOf('</script>');
    if (end < 0) continue;
    const script = src.slice(0, end);
    const pm = script.match(/let\s*\{([^}]*)\}\s*=\s*\$props\(\)/);
    if (!pm) continue;
    // ⚠️ 先剥注释：$props() 的解构里写 JSDoc 是合法的（YearPill / Pager 都写了），
    // 但注释文本会被当成 prop 名拼进正则，里面的 * ( 直接让 RegExp 抛错 ——
    // 实测把整个静态检查搞崩了，而发布闸门第一步就是跑它。
    const props = pm[1]
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .split(',').map((x) => x.split(/[:=]/)[0].trim())
      .filter((x) => /^[A-Za-z_$][\w$]*$/.test(x) && x !== 'children');
    if (!props.length) continue;

    // 逐个 const 声明（含多行对象/模板串），跳过 $derived、函数、以及函数体内的声明
    const re = /^([ \t]*)const\s+(\w+)\s*=\s*([\s\S]*?);[ \t]*$/gm;
    for (const m of script.matchAll(re)) {
      const [, indent, name, rhs] = m;
      if (rhs.includes('$derived') || rhs.includes('$state')) continue;
      // 箭头函数（含 (o = {}) => 这类带默认值的参数）与普通函数都跳过 ——
      // 函数体每次调用都会重新求值，不存在捕获旧值的问题
      const t = rhs.trim();
      if (/^(async\s+)?(\([^)]*\)|\w+)\s*=>/.test(t)) continue;
      if (/^(async\s+)?function\b/.test(t)) continue;
      if (indent.length > 2) continue;                              // 缩进深 = 在函数体内
      // 只在「作为标识符」出现时才算引用，避免 grid-cols-3 撞 cols
      // 排除紧跟冒号的写法：Tailwind 的变体（disabled:opacity-40、hover:...）里
      // 会出现和 prop 同名的词，那不是在引用 prop。真正的引用后面是空格/?/)/}。
      const used = props.filter((p) => new RegExp(`(?<![\\w-])${p}(?![\\w-:])`).test(rhs));
      if (used.length) bad.push(`${f}: const ${name} 引用了 prop ${used.join(',')} 但没用 $derived`);
    }
  }
  return bad;
}
