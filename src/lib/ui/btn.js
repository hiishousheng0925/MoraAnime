/**
 * 设置页一类表单的按钮 / 行样式（2026-10 UI 大改）。设置页和它专用的几个卡片组件（账号 / 备份 / 白名单 / 观看站）共用。
 * 禁用态：主按钮改成二级底色 + 弱色字 —— 原来是半透明的 accent，看着像坏掉了而不是「现在不能点」。
 */
export const PRIMARY = `shrink-0 rounded-lg bg-accent px-3.5 py-1.5 text-[13px] font-medium text-on-accent transition
  hover:brightness-110 disabled:bg-ink-800 disabled:text-ink-400 disabled:hover:brightness-100`;
export const SECONDARY = `shrink-0 rounded-lg border border-ink-600 bg-ink-900 px-3 py-1.5 text-[13px] text-ink-200 transition
  hover:border-ink-400 disabled:text-ink-400 disabled:hover:border-ink-600`;
/** 卡片里的一行（分隔线由 Group 的 divide-y 画） */
export const ROW = 'flex items-center justify-between gap-4 px-4 py-3';
/** 输入框 */
export const INPUT = `min-w-0 flex-1 rounded-lg border border-ink-600 bg-ink-950 px-3 py-1.5 text-[13px] text-ink-100 outline-none transition
  focus:border-accent`;
