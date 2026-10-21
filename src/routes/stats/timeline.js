/**
 * 统计页时间线的展示层（纯函数，tests/unit/stats-view.test.js 守着）。
 *
 * 一天里同一部番常有好几条日志（+1 集点了三次、顺手改了状态），原来逐条一张卡片，
 * 一部番占好几行。这里把「同一天 · 同一部番」合并成一行：
 *   看到第 5 集 → 第 6 集 → 第 7 集        →  「看到第 5–7 集」
 *   看到第 7 集 ×2（重看 / 拖进度留下的）   →  「看到第 7 集 ×2」
 *   …再加一条改状态                         →  「看到第 7 集 ×2 · 改为在看」
 * 只合并展示，不动分页：一部番的记录跨了两页时，两页各显示一行。
 */
import { WATCH_STATUS } from '../../lib/constants.js';   // 相对路径：单测直接 import 这个文件，node 不认 $lib

const ACTION_CN = { triage: '快速标记', clear: '移出番单', import: '导入' };

/** 单条日志 → 片段。watch_ep 单独成「集数」片段，方便连号合并 */
function token(it) {
  if (it.action === 'watch_ep' && it.episode)
    return { ep: it.episode, done: !!(it.episodes && it.episode >= it.episodes) };
  // watch_ep 没带集数的旧日志：只写「看了」
  if (it.action === 'watch_ep') return { text: '看了' };
  if (it.action === 'status_change') return { text: `改为${WATCH_STATUS[it.detail] ?? '其他状态'}` };
  const t = ACTION_CN[it.action] ?? it.action;
  return { text: it.episode ? `${t} 第 ${it.episode} 集` : t };
}

const epText = (r) => {
  const range = r.from === r.to ? `第 ${r.to} 集` : `第 ${r.from}–${r.to} 集`;
  // 进度到头就写「看完」：拖进度条一下拖到底，写「看到第 12 集」是错的（12 集就是最后一集）
  return r.done ? (r.from === r.to ? `看完 · 全 ${r.to} 集` : `看完 · ${range}`) : `看到${range}`;
};

/**
 * 一段时间先后（旧 → 新）的日志 → 「看到第 5–7 集 · 改为在看」
 * @param {{action:string, episode?:number|null, episodes?:number|null, detail?:string|null}[]} items 旧 → 新
 */
export function describe(items) {
  /** @type {{text?:string, ep?:number, from?:number, to?:number, done?:boolean, n:number}[]} */
  const out = [];
  for (const it of items) {
    const t = token(it);
    const last = out.at(-1);
    if (t.ep != null && last?.to != null) {
      // 同一集再来一次 → ×2；紧接下一集 → 连成区间
      if (t.ep === last.to && last.from === last.to) { last.n++; last.done ||= t.done; continue; }
      if (t.ep === last.to + 1 && last.n === 1) { last.to = t.ep; last.done = t.done; continue; }
    }
    if (t.text && last?.text === t.text) { last.n++; continue; }
    out.push(t.ep != null ? { from: t.ep, to: t.ep, done: t.done, n: 1 } : { text: t.text, n: 1 });
  }
  return out.map((r) => (r.text ?? epText(r)) + (r.n > 1 ? ` ×${r.n}` : '')).join(' · ');
}

/**
 * 一天的日志（新 → 旧，即接口顺序）→ 每部番一行，按这部番最近一次记录的先后排
 * @returns {{ key: number, anime: object, text: string, time: string, n: number }[]}
 */
export function mergeDay(items) {
  const groups = new Map();
  for (const it of items) {
    const g = groups.get(it.anime_id);
    if (g) g.items.push(it);
    else groups.set(it.anime_id, { items: [it] });
  }
  return [...groups.values()].map(({ items: g }) => ({
    key: g[0].id,          // 这一行里最新那条日志的 id：本身唯一
    anime: { ...g[0], id: g[0].anime_id },
    text: describe(g.slice().reverse()),
    time: String(g[0].watched_at).slice(11, 16),
    n: g.length
  }));
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
/** 「10月20日」+「今天 / 昨天 / 周一」。today 是本地日期 YYYY-MM-DD */
export function dayLabel(date, today) {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - t) / 86400000);
  const rel = diff === 0 ? '今天' : diff === 1 ? '昨天' : WEEK[new Date(t).getUTCDay()];
  const head = today.slice(0, 4) === String(y) ? `${m}月${d}日` : `${y}年${m}月${d}日`;
  return { head, rel };
}
