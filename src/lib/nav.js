/**
 * 全站导航的单一来源：侧栏（+layout.svelte）和手机底部标签栏（ui/TabBar.svelte）共用。
 *
 * 侧栏顺序（主人定的）：浏览类在前，个人记录类在后，设置垫底 —— tests/e2e.js 14x 把顺序写死了。
 *   发现：首页 · 目录 · 放送表 · 季度浏览 · 排行榜
 *   我的：快速标记 · 我的番单 · 我的统计 · 设置
 * 图标用 Phosphor 一套（同一笔画粗细），当前页用 fill。原来是 emoji：
 * 各系统字体渲染不一样（Windows 上 🗂 是灰的、⚙️ 带变体选择符），风格也互相不搭（2026-10-18 UI 体检）。
 *
 * tab: true 的几项在手机（<md）上进底部标签栏，「更多」抽屉里就不再重复列出。
 */
import House from 'phosphor-svelte/lib/House';
import SquaresFour from 'phosphor-svelte/lib/SquaresFour';
import CalendarDots from 'phosphor-svelte/lib/CalendarDots';
import Leaf from 'phosphor-svelte/lib/Leaf';
import Trophy from 'phosphor-svelte/lib/Trophy';
import Lightning from 'phosphor-svelte/lib/Lightning';
import Books from 'phosphor-svelte/lib/Books';
import ChartBar from 'phosphor-svelte/lib/ChartBar';
import GearSix from 'phosphor-svelte/lib/GearSix';

export const NAV_GROUPS = [
  { title: '发现', items: [
    { href: '/',         icon: House,        label: '首页',     tab: '首页' },
    { href: '/catalog',  icon: SquaresFour,  label: '目录',     tab: '目录' },
    { href: '/schedule', icon: CalendarDots, label: '放送表',   tab: '放送表' },
    { href: '/seasons',  icon: Leaf,         label: '季度浏览' },
    { href: '/ranking',  icon: Trophy,       label: '排行榜' }
  ] },
  { title: '我的', items: [
    { href: '/triage',   icon: Lightning,    label: '快速标记' },
    { href: '/mine',     icon: Books,        label: '我的番单', tab: '番单', auth: true },
    { href: '/stats',    icon: ChartBar,     label: '我的统计' },
    { href: '/settings', icon: GearSix,      label: '设置' }
  ] }
];

export const NAV = NAV_GROUPS.flatMap((g) => g.items);

/** 当前页是不是这一项（首页只认 /，其余按前缀） */
export const isActive = (href, path) => (href === '/' ? path === '/' : path === href || path.startsWith(href + '/'));
