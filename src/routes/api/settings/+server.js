import { json } from '@sveltejs/kit';
import { setSetting, getSetting, yearWindow } from '$lib/server/queries.js';
import { YEAR_HARD_MIN, YEAR_HARD_MAX } from '$lib/constants.js';
import { isAbsolute } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { shotDir } from '$lib/server/screenshot.js';

/**
 * 开关型设置：值只有 0/1。
 * 年份窗口和这些开关是个人设置：登录了存自己的 user_setting，访客存 cookie（见 prefs.js / hooks.server.js）
 */
const FLAGS = ['hide_nsfw'];

export async function POST({ request, locals }) {
  const b = await request.json();

  /**
   * 显示年份窗口。库里存的是 1950–2050 的全部数据，这里只决定界面显示哪一段。
   * 服务端必须自己夹一遍范围 —— 前端的滑块能被绕过（直接 POST 一个 3000 进来），
   * 而这个值会拼进 SQL（见 queries/triage.js: POOL）。
   */
  if (b.key === 'year_window') {
    const clamp = (v) => Math.max(YEAR_HARD_MIN, Math.min(YEAR_HARD_MAX, Math.round(+v) || YEAR_HARD_MIN));
    const min = clamp(b.min);
    const max = Math.max(min, clamp(b.max));
    setSetting('year_min', min);
    setSetting('year_max', max);
    return json({ ok: true, ...yearWindow() });
  }

  /**
   * 截图保存目录：这台电脑上的绝对路径（服务端写盘）。空串 = 回到缺省。
   * 只收绝对路径、不收 .. —— 写错了也只是写到别的文件夹，但别让相对路径落到站点目录里
   */
  if (b.key === 'screenshot_dir') {
    // 存的是服务器那台电脑上的路径：只有管理员能改（其他账号的截图下载到自己设备）
    if (locals.user?.role !== 'admin') return json({ error: '只有管理员能改' }, { status: 403 });
    const v = String(b.value ?? '').trim();
    if (v && (!isAbsolute(v) || v.length > 260 || /(^|[\\/])\.\.([\\/]|$)/.test(v))) return json({ error: '要填这台电脑上的完整路径，比如 D:\\图片\\截图' }, { status: 400 });
    if (v) { try { await mkdir(v, { recursive: true }); } catch (e) { return json({ error: `建不了这个文件夹：${e.message}` }, { status: 400 }); } }
    setSetting('screenshot_dir', v);
    return json({ ok: true, key: b.key, value: shotDir() });
  }

  if (!FLAGS.includes(b.key)) return json({ error: 'unknown setting' }, { status: 400 });
  setSetting(b.key, b.value ? '1' : '0');
  return json({ ok: true, key: b.key, value: getSetting(b.key) });
}
