/** 观看页的纯工具（2026-10-21 从 +page.svelte 拆出来：页面贴着 400 行上限） */
import { epNum } from '$lib/episodeNo.js';

/** 集号：站上写的「第 3 集」「03」优先，认不出来按位置（和服务端排顺序共用 epNum） */
export const epNo = (ep, i) => epNum(ep.name) ?? i + 1;

/** 第 n 集在列表里的下标：按集号找（列表里可能夹着 PV / 总集篇），找不到按位置 */
export const indexOfEp = (list, n) => {
  const i = list.findIndex((ep, k) => epNo(ep, k) === n);
  return i >= 0 ? i : Math.min(Math.max(n - 1, 0), Math.max(list.length - 1, 0));
};

/**
 * 各站实际清晰度（videoHeight）记在本机浏览器 —— 只是给主人自己看的参考，丢了下次播放又会记上。
 * 隐私模式下 localStorage 读写都可能抛
 */
const QKEY = 'j-anime.sourceQuality';
export const loadQuality = () => { try { return JSON.parse(localStorage.getItem(QKEY) ?? '{}'); } catch { return {}; } };
export const saveQuality = (q) => { try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch { /* 隐私模式 */ } };
