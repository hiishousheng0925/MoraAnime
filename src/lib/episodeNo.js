/**
 * 片源站的集名 → 集号。服务端（排顺序）和观看页（选集、记进度）共用这一份。
 * 站上写的「第 3 集」「03」「EP03」优先，认不出来返回 null，由调用方按位置算。
 */
export function epNum(name) {
  const s = String(name ?? '');
  const m = s.match(/第\s*(\d+)/) ?? s.match(/^\D*?(\d+)\D*$/);
  return m ? +m[1] : null;
}

/**
 * 倒序列表翻过来（#93）：DM84 的选集是新的在前（3 / 2 / 1），观看页按下标走上一集 / 下一集，
 * 方向就反了。按认得出的集号看相邻两项是升多还是降多，降的多就整列翻转；认不出的（PV、SP）跟着一起翻
 */
export function inOrder(eps) {
  const ns = eps.map((e) => epNum(e.name)).filter((n) => n != null);
  let up = 0, down = 0;
  for (let i = 1; i < ns.length; i++) { if (ns[i] > ns[i - 1]) up++; else if (ns[i] < ns[i - 1]) down++; }
  return down > up ? [...eps].reverse() : eps;
}
