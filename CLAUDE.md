# MoraAnime — 给接手的 AI agent 看的定位卡

Windows 桌面追番客户端（类似 Kazumi）。做法是**把上游网站原样搬到用户电脑上跑**：
Electron 主进程用 `ELECTRON_RUN_AS_NODE=1` + 自己的 exe 当 Node，起一个子进程跑 SvelteKit（adapter-node）的产物，
听 `127.0.0.1` 上的端口（记在 state.json，下次先用同一个，被占才换 —— 端口一变 origin 就变，localStorage 里的主题 / 倍速 / 音量全丢），窗口加载它。番剧库是本地 SQLite，片源解析、视频代理、播放全在本机。

上游是一个私人追番网站项目（下文称「上游」，在 `UPSTREAM.json` 里叫 `j-anime`）。**开发以上游为主**：
上游合了若干个 PR 之后，用 `tools/sync-upstream.js` 把差异打进来，再发客户端新版本。

---

## 目录结构 & 共享代码的边界

```
src/ scripts/ tests/ static/      ← 与上游共享。每次同步会把上游的差异打进来
svelte.config.js vite.config.js
package.json package-lock.json    ← 也是共享的（网站依赖）；客户端的依赖不加在这里
DATA-SOURCES.md

desktop/                          ← 客户端独有
  main.js           主进程：启动顺序、服务子进程（崩溃重启、退出时按 PID 杀进程树）、窗口、外链、自动更新
  catalog.js        番剧库数据包：manifest → 下载 → sha256 → 解压 → 再校验（只做文件，不开库）
  db-tasks.js       需要开库的启动步骤（子进程跑）：bootstrap = 本地账号 + 会话；apply = 换库
  catalog-tables.js 「公共数据 vs 个人数据」的表清单（导出清空 / 换库搬运共用这一份）
  guard.mjs         服务子进程的进程级兜底（播放器中途断开的 EPIPE 之类不让进程退出）
  build.js          组装 .stage/app + electron-builder 打包
  assets/           图标（tools/make-icon.js 从 desktop/icon.svg 生成：客户端配色的追番猫）
  test/             客户端实测脚本（e2e.js / update.js / make-pack.js）
  package.json      Electron / electron-builder（devDependencies）；appDependencies = 只给客户端装的运行时依赖
tools/                            ← 客户端独有
  export-catalog.js       从上游正式库只读导出番剧库数据包
  install-export-task.ps1 注册每日导出的计划任务
  sync-upstream.js        同步上游
  make-icon.js            生成图标
UPSTREAM.json                     同步到上游的哪个提交、哪些路径不同步
```

**规则：客户端要的东西放 `desktop/` / `tools/`。** 共享代码确实非改不可时：改动要最小、用环境变量开关
（网站不设这个变量时行为完全不变），并且**同一处改动要提到上游**，否则下次同步会冲突。目前的共享代码改动：

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `src/routes/+layout.server.js`、`+layout.svelte` | 页头 / 标签页标题的品牌名读 `J_ANIME_BRAND`（缺省 `j-anime`） | 客户端显示 MoraAnime |
| `tests/lint-arch.js` 第 13 条 | 没有 `scripts/release.js` 时跳过「发布走 build.next」那一条断言 | 客户端仓库不同步网站的发布脚本 |

`UPSTREAM.json` 的 `excluded`：`deploy/ .claude/ CLAUDE.md docs/ REQUIREMENTS.md open-question.md scripts/release.js`
（网站部署、含个人信息的文档）。上游新增了含个人信息的文件就加进去。

---

## ⛔ 绝对不要做的事

1. **不把个人信息写进仓库**：真名、邮箱、内网 IP / 域名、本机用户目录路径、上游的 GitHub 账号名。
   提交前 grep 一遍（见下方「提交前自查」）。导出的番剧库也一样：`export-catalog.js` 会清空个人表并抹掉日志里的错误文本。
2. **不在上游仓库 / 上游正式站目录里做任何写操作**。同步只跑 `git diff / log`；导出只用 `readOnly` 连接 `VACUUM INTO`。
3. **不裸跑 `npx vite build`**（上游的纪律，同样适用）：缺省输出是 `build.dev`；客户端构建由 `desktop/build.js`
   显式给 `BUILD_OUT=desktop/.stage/app/build`。
4. **测试不碰真实用户目录**：客户端测试一律用 `MORA_HOME` 指到临时目录（e2e.js 会检查路径里有 tmp/temp/work/test）。
   上游的 `npm test` 要先把 `J_ANIME_DATA` 指到临时目录里的库副本，`TEST_PORT` 换一个不冲突的端口。
5. **杀进程只按 PID**，不按进程名杀 node / electron（用户机器上可能有别的 node 服务）。主进程只杀自己 spawn 的服务进程树。
6. 上游 CLAUDE.md 里仍然适用的几条：数据路径只走 `src/lib/server/paths.js`；`+page.server.js` 只能导出固定几个名字；
   界面里不写教学式说明文字、操作反馈只走全局 toast；从 `$props()` 派生的值用 `$derived`。`tests/lint-arch.js` 守着这些。

---

## 启动顺序（desktop/main.js）

1. 用户目录 `MORA_HOME`（缺省 `%APPDATA%\MoraAnime`），库在 `<它>\data\j-anime.db`
2. 没有库 → 启动画面里下载番剧库（首次启动）；`data\catalog-pending\` 里有上次后台下好的新库 → `db-tasks apply` 换上
3. `build/.sync/scripts/migrate.js`（应用自己不跑 `initSchema`，缺列会 500）
4. `db-tasks bootstrap`：确保账号 id 1（用户名 `me`、管理员、随机密码存 `local-account.json`）；删掉上次的客户端会话，建新会话
5. 子进程跑 `build/index.js`：`HOST=127.0.0.1`、`PORT=随机`、`ORIGIN`、`J_ANIME_DATA`、`NODE_ENV=production`、
   `BODY_SIZE_LIMIT=50M`、`J_ANIME_CHROME=本机 Chrome 或 Edge`、`J_ANIME_BRAND=MoraAnime`。网站的部署变量（`J_ANIME_*` 其余的、
   `TRUSTED_ORIGINS` 等）一概不继承
6. 等 `/api/health` → `session.cookies.set` 塞 `j_anime_sid` → 加载首页（**不改网站的鉴权代码**：账号先于服务存在，
   网站「库里没账号时第一个注册的是管理员」那条路走不到）
7. 5 秒后后台：番剧库更新检查（每天最多一次，`state.json` 记时间）、electron-updater（便携版 / 开发运行不查，失败静默）

窗口：外链（非本机地址）交给系统浏览器；大小位置记在 `state.json`；没有菜单栏，F5 刷新、F12 开发者工具、Alt+←/→、鼠标侧键、F11 全屏。
同时只允许一个实例（两个实例会同时写库）。

环境变量（开发 / 测试用）：`MORA_HOME`、`MORA_CATALOG_URL`（manifest 地址，可以是本地路径）、`MORA_NO_UPDATE=1`、`MORA_TEST_HOOKS=1`。

---

## 番剧库：导出、发布、换库

**导出**（维护者机器上，每天上游同步完之后）：

```bash
node tools/export-catalog.js [--src <上游库>] [--out <目录>] [--publish] [--keep 7]
```

- 源库缺省 = `J_ANIME_DATA`（环境变量或 `~/.j-anime.env`）下的 `j-anime.db`；输出缺省 `%LOCALAPPDATA%\MoraAnime-export`
- 清空的表见 `desktop/catalog-tables.js` 的 `CLEAR_ON_EXPORT`：
  `user_entry_all triage_all watch_log_all saved_filter_all user_tag_all user_setting session signup_allow account setting watch_site`；
  另外 `sync_log.error` 置空、`anime.cover_local_path` 置空、`meta.test_copy` 删除。清完自检，有残留就失败
- brotli q9 + 16MB 窗口（实测 214 MB → 51 MB，压缩约 28 秒，解压约 1 秒）
- `catalog.json`：`{ format:1, version:YYYY.MM.DD.HHmm（2026-10-22 起带时分，同一天重导也能下发；客户端只做相等比较）, file, compression:'br', sha256, size, db:{sha256,size,anime}, syncedAt, exportedAt }`
- `--publish`：上传到 GitHub Releases 的**固定 tag `catalog`（预发布）**——应用自动更新读的是 latest release，
  番剧库每天发一次，不能占掉它。需要 `MORA_GITHUB_TOKEN`、`MORA_GITHUB_REPO`。先传数据包再传 manifest
- 计划任务：`tools/install-export-task.ps1`（`-WhatIf` 先看，`-Publish` 带上传，`-Uninstall` 删除）

客户端缺省 manifest：`https://github.com/hiishousheng0925/MoraAnime/releases/download/catalog/catalog.json`（`desktop/catalog.js`）。

**换库**（`db-tasks.js apply`，只在服务起来之前做）：新库拷成 `j-anime.db.swap` → 跑 migrate → 旧库 checkpoint →
swap `ATTACH` 旧库，`CARRY_ON_SWAP` 里的表整表搬过去 → 个人记录指向 stub 的沿 `dup_of` 改挂（复用网站 `dedup.js` 的
`applyAliasDupes`，标签单独处理）→ 手动关联取并集、封面缓存路径沿用 → `quick_check` → 旧库挪到 `backups\j-anime.db.prev-*`、
swap 改名成 `j-anime.db`（失败就挪回来）。任何一步失败都只删 swap，现有库不动，并记下 `badVersion` 不再重下同一个坏包。

**上游加了新的个人数据表**（看 `src/lib/server/multiUser.js` 的 `PERSONAL`、`schema.sql`）→ 必须加进 `catalog-tables.js`，
否则导出会带出维护者的数据、换库会丢用户的数据。

---

## 同步上游

```bash
node tools/sync-upstream.js --upstream <上游仓库路径> --dry-run     # 先看会改哪些文件、包含哪些 PR
node tools/sync-upstream.js --upstream <上游仓库路径> [--to main]
```

- 工作区必须干净。`git apply --3way --index`；成功 → 更新 `UPSTREAM.json`、提交「同步 j-anime <旧>..<新>」，
  说明里列出 PR 编号和标题（不带账号名 / 分支名）
- 冲突 → 停下、列出冲突文件、不提交（exit 3）。解决后手动把 `UPSTREAM.json` 的 commit 改成目标提交再提交；放弃用 `git reset --hard HEAD`
- 只读上游：不 fetch、不切分支。要同步新提交先在上游仓库自己 pull
- 同步后：`node tests/lint-arch.js`、`node --test "tests/unit/*.test.js"`、`node desktop/build.js --dist`、`desktop/test/e2e.js` 实测

---

## 构建与打包

```bash
npm ci && npm --prefix desktop ci
node desktop/build.js            # 组装 desktop/.stage/app
node desktop/build.js --run      # 组装并运行（开发）
node desktop/build.js --dist     # NSIS 安装包 + 便携版 → desktop/dist/（--skip-vite 复用上次的网站产物）
```

- 组装：`vite build`（`TRUSTED_ORIGINS` 显式置空，不把构建机 `~/.j-anime.env` 里的地址烤进产物）→ `scripts/snapshot.js`
  拍 `build/.sync/{scripts,src/lib}`（migrate 和换库要用）→ 主进程代码 → 生成 package.json →
  `npm install --omit=dev`。**运行时依赖只装服务端产物里真正 import 到的**（目前 jsdom、playwright-core），
  phosphor-svelte / anime4k-webgpu 已打进前端包
- `asar: false`：服务子进程（ELECTRON_RUN_AS_NODE）要用真实文件系统读 build/ 和 node_modules/
- 自动更新：electron-updater，GitHub provider（owner `hiishousheng0925`、repo `MoraAnime`）；发版时要连 `latest.yml` 一起传
- **更新弹窗**（2026-10-21 主人定的）：每次启动查一次，有新版本就弹客户端样式的弹窗（`desktop/update.html`，不用 Windows 原生对话框）：版本号 + 几行更新内容，「立即更新」= 下载并自动重启安装，「关闭」= 这次不更新、**下次打开还弹**（不在退出时偷偷装）。便携版的「立即更新」打开下载链接
- **发版**：改 `desktop/package.json` 的 version → 在 `desktop/release-notes.json` 写这一版的更新内容（3–5 行、一句话一条，没写打包会失败）→ `node desktop/build.js --dist` → e2e → `node tools/publish-release.js`（同一份更新内容也写进 release 正文；另传不带版本号的 `MoraAnime-Setup.exe`，固定链接永远是最新版）
- 测试弹窗：`MORA_UPDATE_URL=<本地 generic 源>` 让客户端改从那里读 `latest.yml`（假的高版本 + 错的 sha512 = 能走完「弹窗 → 关闭 → 再弹 → 立即更新 → 下载失败」而不会真的安装）
- 体积：安装包 / 便携版各约 107 MB，安装后约 350 MB（Electron 本体占大头）

**实测**：

```bash
node tools/export-catalog.js --out <临时目录>\export
node desktop/test/e2e.js desktop\dist\MoraAnime-<版本>-portable.exe --home <临时目录>\home --catalog <临时目录>\export\catalog.json --shots <临时目录>\shots
node desktop/test/make-pack.js <基准库> <临时目录>\pack-ok --version 2099.01.01 --mode ok --fold <输家>:<赢家>
node desktop/test/update.js <exe> --home <上面跑过的 home> --catalog <临时目录>\pack-ok\catalog.json
```

e2e 的观看页用 `/anime/18386/watch`（真实片源，第三方站点时好时坏，失败时先换一部番确认）。

---

## 提交前自查

```bash
git grep -nIiE "<真名>|<公司域名>|<tailnet 名>|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|C:\\\\Users\\\\|<上游 GitHub 账号>"
```

（具体词表维护者自己保管，不写进仓库。）提交身份用仓库 local config 里配好的那个。

---

## 已知限制

- 便携版每次启动都要解包到临时目录（electron-builder portable 的机制），比安装版慢约 20 秒；不支持自动更新
- 安装后第一次启动服务要 10 秒左右（新文件第一次加载，杀毒软件扫描），之后约 1 秒
- 换库在**下次启动**时生效（库文件被服务占着，运行中不能替换）
- 网站里「登出」后会弹登录框：用 `local-account.json` 里的账号密码登回，或重启客户端
- 网站的多账号功能（注册白名单、其他账号）在客户端里没有意义，但没有隐藏（不改共享代码）
- 安装包没有代码签名（SmartScreen 警告）
- 观看站 URL 模板（`watch_site`）、站点设置（`setting`）是本机的，不随番剧库下发
