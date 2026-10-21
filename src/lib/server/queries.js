/**
 * 数据访问层的门面。
 *
 * 拆分前这里是一个 756 行、36 个导出的文件，混了检索 / 个人记录 /
 * 快速标记 / 统计 / 设置五种关注点 —— 找「快速标记的出题逻辑在哪」
 * 得在 756 行里翻。现在按语义拆成 queries/ 下五个文件，
 * 这里只做重导出，所以所有调用点一行都不用改。
 */
export * from './queries/catalog.js';
export * from './queries/schedule.js';
export * from './queries/recommend.js';
export * from './queries/user.js';
export * from './queries/triage.js';
export * from './queries/stats.js';
export * from './queries/prefs.js';
export * from './queries/watchSite.js';
export * from './queries/seasons.js';
export * from './queries/quicksearch.js';
