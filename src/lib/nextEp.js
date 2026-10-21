/**
 * 「下一集」：按钮上怎么说、点了从哪一集开始。
 *
 * 详情页主按钮、首页 hero、番单「继续看」书架、观看页起始集共用这一份（主人 2026-10-21 #7）。
 * 原来各处都是「进度 + 1」：转生就是剑 第二季 只播了 3 集、我看到第 3 集，详情页写「继续看第 4 集」，
 * 点进去观看页找不到第 4 集，就按位置夹到列表最后一条。
 *
 * 已播集数（aired）的口径和详情页进度条同一套：Bangumi 分集日期 + 先行配信容差（server/episodes.js 的
 * airedCount / episodeStatus，#98）。没有分集数据时 aired = null，只能按总集数判断。
 *
 * 纯函数、不 import $app —— 可以直接单测（tests/unit/next-ep.test.js）。
 */

/**
 * @typedef {'start' | 'resume' | 'caught' | 'upcoming' | 'rewatch'} NextKind
 *   start    还没开始看          → 第 1 集「开始观看」
 *   resume   看到一半、后面还有    → 第 N+1 集「继续看第 N+1 集」
 *   caught   追平了已播的集数      → 停在第 N 集「已追到第 N 集」，等下一集更新
 *   upcoming 一集都还没播          → 第 1 集「尚未开播」
 *   rewatch  看完了（状态看完，或进度到了总集数）→ 第 1 集「从头再看」
 */

/**
 * @param {{ status?: string|null, current?: number|null, total?: number|null, aired?: number|null }} e
 *   status  我的状态（user_entry.status）
 *   current 进度（看到第几集）
 *   total   总集数（未知给 null / 0）
 *   aired   已播几集（连载中才有；未知或已播完给 null）
 * @returns {{ kind: NextKind, ep: number, label: string }}
 */
export function nextEp({ status = null, current = 0, total = null, aired = null } = {}) {
  const cur = Math.max(0, Math.floor(current ?? 0));
  const tot = total > 0 ? total : null;
  if (status === 'completed' || (tot && cur >= tot)) return { kind: 'rewatch', ep: 1, label: '从头再看' };
  // aired ≥ 总集数 = 已经播完，按总集数算（上面已处理）
  const lim = aired != null && aired >= 0 && (!tot || aired < tot) ? aired : null;
  if (lim != null && cur >= lim) {
    return cur === 0
      ? { kind: 'upcoming', ep: 1, label: '尚未开播' }
      : { kind: 'caught', ep: cur, label: `已追到第 ${cur} 集` };
  }
  if (cur === 0) return { kind: 'start', ep: 1, label: '开始观看' };
  return { kind: 'resume', ep: cur + 1, label: `继续看第 ${cur + 1} 集` };
}

const WD = '日一二三四五六';

/**
 * 下一集什么时候播：有 Bangumi 分集日期就写日期（「10/28 周三更新」），否则写每周几（「每周三更新」），都没有给 null。
 * @param {{ airdate?: string|null, weekday?: number|null, verb?: string }} o
 *   airdate 下一集的播出日（YYYY-MM-DD，日本时间）
 *   weekday bgm_weekday（1 = 周一 … 7 = 周日）
 *   verb    「更新」/「开播」
 */
export function nextAirText({ airdate = null, weekday = null, verb = '更新' } = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(airdate ?? '');
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return `${+m[2]}/${+m[3]} 周${WD[d.getUTCDay()]}${verb}`;
  }
  if (weekday >= 1 && weekday <= 7) return `每周${WD[weekday % 7]}${verb}`;
  return null;
}

/**
 * 观看页从哪一集开始。
 *   · 网址带 ?ep=N → 第 N 集
 *   · 追平了：片源站已经有下一集（先行配信比 Bangumi 记的还早）就放下一集，没有就停在最新看过的那一集 ——
 *     原来是「进度 + 1」找不到就夹到列表最后一条（可能是 PV / 总集篇）
 *   · 其余按 nextEp；那一集片源上没有、但当前进度那集有时，退回当前进度那集
 * @param {{ asked?: number, status?: string|null, current?: number|null, total?: number|null, aired?: number|null,
 *           has?: (n: number) => boolean }} o  has：片源的选集列表里有没有第 n 集
 * @returns {number} 集号
 */
export function startEp({ asked = 0, has = () => true, ...e } = {}) {
  if (asked > 0) return asked;
  const n = nextEp(e);
  if (n.kind === 'caught') return has(n.ep + 1) ? n.ep + 1 : n.ep;
  const cur = Math.max(0, Math.floor(e.current ?? 0));
  if (n.kind === 'resume' && !has(n.ep) && has(cur)) return cur;
  return n.ep;
}
