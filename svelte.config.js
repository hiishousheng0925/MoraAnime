import adapter from '@sveltejs/adapter-node';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 登录表单的来源校验额外认哪些地址（逗号分隔，写在 ~/.j-anime.env 的 TRUSTED_ORIGINS）。
 * ORIGIN 只能填一个（run-app 里按 http://<tailnet IP>:<端口> 算），走 tailscale serve 的
 * https://<机器>.ts.net 发来的表单 Origin 对不上，登录会 403 —— 两种地址都要能用，就把 https 那几个加进信任列表。
 * 机器相关的地址不进仓库，构建时从本机配置读。
 */
function trustedOrigins() {
  let txt = '';
  try { txt = readFileSync(join(homedir(), '.j-anime.env'), 'utf8'); } catch { /* 没有就是空 */ }
  const v = process.env.TRUSTED_ORIGINS ?? txt.match(/^TRUSTED_ORIGINS=(.*)$/m)?.[1] ?? '';
  return v.split(',').map((x) => x.trim()).filter((x) => /^https?:\/\/[^/\s]+$/.test(x));
}

export default {
  kit: {
    /**
     * ⛔ 缺省绝对不能是 'build' —— 那是正式站正在跑的目录。
     *
     * 实测事故：调试组件时随手跑了几次裸的 `npx vite build`，把正式站的产物
     * 整个重写了；进程是更早启动的，adapter-node 按需加载 build/server/chunks/*.js，
     * 文件在脚下被换掉 → 每个请求 500。发布门禁只管 `npm run release`，
     * 管不住手动构建，所以必须让缺省输出落在一个没人跑的目录。
     *
     * 谁显式指定：release.js → build.next（测过再原子替换 build/）；
     * staging.js → build.staging。裸跑构建只会写 build.dev。
     */
    adapter: adapter({ out: process.env.BUILD_OUT || 'build.dev' }),
    alias: { $lib: 'src/lib' },
    /**
     * 发布后旧标签页会装错页面 —— 必须让它自己整页重载。
     *
     * 实测事故：主人有个标签页在发布前就开着，发布后点侧栏「设置」，
     * URL 变成 /settings、侧栏高亮也对，渲染出来的却是首页（标签标题是「首页」）。
     * 成因：SvelteKit 客户端路由靠 __data.json 里的 node 索引装配页面，
     * 而浏览器缓存里那份旧 app.js 的索引表和发布后服务端返回的索引对不上。
     * 服务端直连 /settings 是正确的（title 就是「设置」），只有客户端跳转会错。
     *
     * pollInterval 让客户端定时拉 /_app/version.json 比对版本；
     * 配合根布局里的 beforeNavigate 守卫，下一次跳转会走整页加载而不是客户端路由。
     * 5 分钟：发布不频繁，这个间隔的请求量可以忽略。
     */
    version: { pollInterval: 300_000 },
    csrf: { trustedOrigins: trustedOrigins() }
  }
};
