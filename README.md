# MoraAnime

Windows 上的本地追番客户端：番剧目录、搜索、详情、放送表、番单、快速标记、观看统计，以及站内播放。

**所有东西都在你自己的电脑上跑** —— 番剧库是本地的 SQLite 文件，片源搜索、播放地址解析、视频播放都由本机完成，
不经过任何服务器，也不需要注册账号。

## 下载安装

**直接下载最新版**：[MoraAnime-Setup.exe](https://github.com/hiishousheng0925/MoraAnime/releases/latest/download/MoraAnime-Setup.exe)（这个链接永远指向最新版本）

或在 [Releases](https://github.com/hiishousheng0925/MoraAnime/releases/latest) 页面下载：

| 文件 | 说明 |
|---|---|
| `MoraAnime-Setup-<版本>.exe` | 安装包：双击安装，可选安装目录，建开始菜单 / 桌面快捷方式；之后有新版本会自动更新 |
| `MoraAnime-<版本>-portable.exe` | 便携版：双击即用，不安装（每次启动要先解包，比安装版慢 20 秒左右；不会自动更新） |

系统要求：Windows 10 / 11（x64）。安装包没有代码签名，首次运行时 SmartScreen 可能提示「未知发布者」，点「更多信息 → 仍要运行」即可。

## 首次启动

第一次打开时会从本仓库的 Releases 下载番剧库数据包（约 50 MB，解压后约 210 MB），之后每天最多检查一次更新：
有新版本就在后台下载，**下次启动时换上**，你的番单、进度、评分、快速标记等个人记录会原样保留。

数据都在 `%APPDATA%\MoraAnime\` 下：

```
data\j-anime.db     番剧库 + 个人记录（卸载程序不会删除）
data\covers\        封面缓存（看过的才缓存）
data\backups\       换库前的旧库（保留最近 2 份）
logs\               运行日志
local-account.json  本地账号（客户端自动登录用，一般用不到）
```

备份个人记录：设置页 →「导出」。

## 片源与播放

片源规则来自 [Predidit/KazumiRules](https://github.com/Predidit/KazumiRules)（Kazumi 项目的规则仓库，MIT 许可），
启动后按需拉取并缓存。规则只描述「怎么在某个站点搜索、怎么取剧集列表」，本身不含任何视频。

部分站点的播放地址要在页面脚本运行后才能拿到，客户端会用本机已安装的 Chrome（没有 Chrome 时用系统自带的 Edge）在后台无界面地打开播放页取地址。

## 数据来源与许可

- [Bangumi 番组计划](https://bgm.tv/)（[bangumi/Archive](https://github.com/bangumi/Archive) 数据导出与 API）：中文名、评分、排名、放送日期、分集信息
- [anime-offline-database](https://github.com/manami-project/anime-offline-database)：MAL / AniList 等外部 ID、标签、制作公司、关联作品。
  该数据库以 [ODbL v1.0](https://opendatacommons.org/licenses/odbl/1-0/) 许可发布（内容以 DbCL v1.0 许可），
  本项目分发的番剧库是其衍生数据库，按 ODbL 要求同样以 ODbL v1.0 提供，并在应用的「设置 → 数据来源」中署名、说明所做的修改。

## 免责声明

- 本项目**不提供、不存储、不上传任何视频内容**；播放的内容来自第三方网站，与本项目无关。
- 仅供个人学习交流使用，请支持正版。

## 开发

本仓库的网站部分（`src/`、`scripts/`、`tests/`）与上游网站项目共享，客户端独有的代码在 `desktop/`（Electron 主进程、打包）和 `tools/`（导出番剧库、同步上游）。

```bash
npm ci                         # 网站依赖（构建用）
npm --prefix desktop ci        # Electron + electron-builder（没有 lock 时用 npm --prefix desktop install）
node desktop/build.js --run    # 构建并直接运行（需要番剧库：设 MORA_CATALOG_URL 指向本地的 catalog.json）
node desktop/build.js --dist   # 打 NSIS 安装包 + 便携版 → desktop/dist/
```

更多细节见 [CLAUDE.md](CLAUDE.md)。
