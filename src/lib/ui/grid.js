/**
 * 封面网格的列数。只在这里定义一次 —— 主人要求「以封面展示的地方一排都是 8 个」。
 * 之前有两套：CardGrid 的 md（8 列）和 sm（6 列），首页和统计页用的是 6 列那套，
 * 和目录/番单对不上。快速标记页自己内联了一份一样的 class，也改成引这里。
 */
export const CARD_GRID = 'grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8';
