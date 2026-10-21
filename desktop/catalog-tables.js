/**
 * 番剧库（公共数据）和「本机个人数据」的分界 —— 导出工具和客户端换库共用这一份清单。
 *
 * 导出（tools/export-catalog.js）：下面列出的表在发布的数据包里必须是空的。
 * 换库（desktop/catalog.js）：下面列出的表从旧库原样搬进新库（新库里的同名表先清空）。
 *
 * 加了新的个人数据表（看 src/lib/server/multiUser.js 的 PERSONAL、schema.sql）就加在这里，
 * 否则：导出会把站主的数据带出去，换库会把客户端用户的数据丢掉。tests 里有一条守着（desktop/test）。
 */

/** 按账号隔离的个人数据真表（multiUser.js 的 PERSONAL → `${name}_all`） */
export const PERSONAL_ALL = ['user_entry_all', 'triage_all', 'watch_log_all', 'saved_filter_all', 'user_tag_all'];

/** 账号层（multiUser.js 的 ACCOUNT_SQL） */
export const ACCOUNT_TABLES = ['account', 'session', 'signup_allow', 'user_setting'];

/**
 * 站点 / 本机配置：
 *   setting     站点设置（截图目录等）
 *   watch_site  观看站 URL 模板（站主自己配的，客户端由用户自己配）
 */
export const LOCAL_CONFIG = ['setting', 'watch_site'];

/** 发布前必须清空的表（顺序 = 外键依赖从子到父） */
export const CLEAR_ON_EXPORT = [...PERSONAL_ALL, 'user_setting', 'session', 'signup_allow', 'account', ...LOCAL_CONFIG];

/** 换库时从旧库整表搬到新库的（顺序 = 外键依赖从父到子） */
export const CARRY_ON_SWAP = ['account', 'session', 'signup_allow', 'user_setting', ...LOCAL_CONFIG, ...PERSONAL_ALL];

/** 个人记录里引用 anime.id 的列 —— 换库时要把指向 stub 的改到 dup_of 上 */
export const ANIME_REFS = {
  user_entry_all: 'anime_id', triage_all: 'anime_id', watch_log_all: 'anime_id', user_tag_all: 'anime_id'
};
