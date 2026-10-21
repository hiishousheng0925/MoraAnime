/**
 * 系列重建时合并主人的手排顺序（见 scripts/build-franchise.js）。
 *
 * @param {number[]} releaseIds 新系列的成员，已按播出顺序排好
 * @param {Map<number, number>} saved 重建前的 anime_id → user_order
 * @returns {Map<number, number> | null} 新的 anime_id → user_order；这个系列谁都没手排过就返回 null
 *
 * 手排过的保持手排的相对顺序；新成员（重建前不在、或不在手排里）插在它播出顺序上
 * 前一个已放好的成员后面，前面没有就放最前。
 */
export function mergeUserOrder(releaseIds, saved) {
  if (!releaseIds.some((id) => saved.has(id))) return null;
  const out = releaseIds.filter((id) => saved.has(id)).sort((a, b) => saved.get(a) - saved.get(b));
  releaseIds.forEach((id, i) => {
    if (saved.has(id)) return;
    const prev = releaseIds.slice(0, i).reverse().find((p) => out.includes(p));
    out.splice(prev === undefined ? 0 : out.indexOf(prev) + 1, 0, id);
  });
  return new Map(out.map((id, i) => [id, i + 1]));
}
