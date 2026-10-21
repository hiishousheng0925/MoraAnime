/**
 * tools/ 共用的 GitHub Releases 工具：取授权、REST 调用、资产上传 / 原子替换、「草稿 → 传完 → 校验 → 发布」。
 *
 * 2026-10-22 审查：原来 export-catalog.js 和 publish-release.js 各抄一份取 token / api / 先删后传，
 * 而且两边都不是原子的（发版时 latest 先亮出来、资产几分钟后才齐；manifest 先删后传，传失败就没了）。
 * 抽到这里统一修，fetch 可注入，单元测试（tests/unit/mora-github.test.js）打桩验证整个流程。
 *
 * 仓库 owner/repo 在 tools/ 里只写这一处（DEFAULT_REPO）。客户端代码里另有几处同样的值，不在 tools 范围：
 * desktop/catalog.js（DEFAULT_MANIFEST）、desktop/main.js（DOWNLOAD）、desktop/build.js（electron-builder publish）。
 */
import { spawnSync } from 'node:child_process';

export const DEFAULT_REPO = 'hiishousheng0925/MoraAnime';
const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

/** 本仓库 origin 指向的 github.com/<owner>/<repo>；没有就返回 null */
export function originRepo() {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  return r.status === 0 ? (r.stdout.trim().match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1] ?? null) : null;
}

/** 目标仓库：MORA_GITHUB_REPO > git origin > DEFAULT_REPO（fork 出去的仓库自然发到自己那里） */
export function resolveRepo() {
  return process.env.MORA_GITHUB_REPO || originRepo() || DEFAULT_REPO;
}

/** 向 git 凭据管理器要 github.com 上某个账号的授权（不弹窗：GCM_INTERACTIVE=never）；拿不到返回 null */
export function credentialToken(user) {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=github.com\nusername=${user}\n\n`, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' }
  });
  return r.status === 0 ? (r.stdout.match(/^password=(.+)$/m)?.[1] ?? null) : null;
}

/** MORA_GITHUB_TOKEN 优先，否则用 repo 所属账号在 git 凭据管理器里的登录（git push 过一次就有） */
export function resolveToken(repo) {
  const owner = repo.split('/')[0];
  const token = process.env.MORA_GITHUB_TOKEN || credentialToken(owner);
  if (!token) throw new Error(`拿不到 GitHub 授权：设 MORA_GITHUB_TOKEN，或者先用 ${owner} 账号 git push 登录一次`);
  return token;
}

/**
 * GitHub REST 客户端（只包本工具用到的几个接口）。
 * @param {{ repo: string, token: string, fetch?: typeof fetch }} o
 */
export function createClient({ repo, token, fetch: fetchFn = globalThis.fetch }) {
  const H = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  const raw = (p, init = {}) => fetchFn(`${API}/repos/${repo}${p}`, { ...init, headers: { ...H, ...init.headers } });
  /** 非 2xx 一律抛错 —— 原来 DELETE 的返回值没人看，删失败了也继续往下走 */
  const call = async (what, p, init = {}) => {
    const r = await raw(p, init);
    if (!r.ok) throw new Error(`${what}失败 HTTP ${r.status} ${await r.text().catch(() => '')}`);
    return r.status === 204 ? null : r.json();
  };
  const jsonInit = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return {
    repo,
    raw,
    getRelease: (id) => call('取 release ', `/releases/${id}`),
    /** 按 tag 找 release，草稿也算（/releases/tags/<tag> 不返回草稿：草稿还没真正打 tag） */
    async findReleaseByTag(tag) {
      for (let page = 1; page <= 10; page++) {
        const list = await call('列 release ', `/releases?per_page=100&page=${page}`);
        const hit = list.find((x) => x.tag_name === tag);
        if (hit) return hit;
        if (list.length < 100) break;
      }
      return null;
    },
    createRelease: (body) => call('建 release ', '/releases', jsonInit('POST', body)),
    updateRelease: (id, body) => call('改 release ', `/releases/${id}`, jsonInit('PATCH', body)),
    deleteAsset: (id) => call('删资产 ', `/releases/assets/${id}`, { method: 'DELETE' }),
    renameAsset: (id, name) => call('资产改名 ', `/releases/assets/${id}`, jsonInit('PATCH', { name })),
    /** 上传一个资产（同名已存在时 GitHub 会 422，调用方先处理） */
    async upload(releaseId, name, body, type = 'application/octet-stream') {
      const r = await fetchFn(`${UPLOADS}/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST', body, headers: { ...H, 'content-type': type, 'content-length': String(body.length) }
      });
      if (!r.ok) throw new Error(`上传 ${name} 失败 HTTP ${r.status} ${await r.text().catch(() => '')}`);
      return r.json();
    }
  };
}

/** 先删同名再传。⚠ 中间有一段时间这个名字不存在 —— 只用在「别人看不到」的场合（草稿 release、带版本号的新文件） */
export async function uploadReplacing(gh, release, name, body, type) {
  for (const a of (release.assets ?? []).filter((x) => x.name === name)) await gh.deleteAsset(a.id);
  return gh.upload(release.id, name, body, type);
}

/**
 * 原子替换一个对外可见的固定名资产（catalog.json）：
 *   1. 新内容先用临时名上传 —— 传失败旧的完全不受影响
 *   2. 旧的改成备份名，新的改成正式名 —— 两次 PATCH 之间只有亚秒级的空档（原来是「删了再传」的整个上传时长，失败就永久没了）
 *   3. 新的改名失败 → 把备份改回来；成功 → 删备份
 * 上次中途失败留下的临时 / 备份资产先清掉。
 */
export async function replaceAssetAtomic(gh, release, name, body, type, { stamp = Date.now() } = {}) {
  const tmpName = `${name}.tmp-${stamp}`, bakName = `${name}.bak-${stamp}`;
  const isLeftover = (n) => n.startsWith(`${name}.tmp-`) || n.startsWith(`${name}.bak-`);
  for (const a of (release.assets ?? []).filter((x) => isLeftover(x.name))) await gh.deleteAsset(a.id);
  const fresh = await gh.upload(release.id, tmpName, body, type);
  const old = (release.assets ?? []).filter((x) => x.name === name);
  for (const a of old) await gh.renameAsset(a.id, bakName + (old.length > 1 ? `-${a.id}` : ''));
  try {
    await gh.renameAsset(fresh.id, name);
  } catch (e) {
    for (const a of old) await gh.renameAsset(a.id, name).catch(() => {});
    throw e;
  }
  for (const a of old) await gh.deleteAsset(a.id);
  return fresh;
}

/**
 * 发客户端版本：草稿 → 传全部资产 → 校验资产齐全 → 才转正式版并标 latest。
 * 原来是先建正式版（latest）再传 ~400MB：传的那几分钟里 releases/latest/download/... 404，
 * 中途失败的话 latest 版本没有 latest.yml，所有客户端检查更新静默失败。
 *
 * 同 tag 已存在：
 *   · 草稿（上次没传完）→ 接着用，同名资产先删后传（草稿别人看不到，删了没关系）
 *   · 已发布且资产齐全 → 不动，返回 { already: true }
 *   · 已发布但缺资产（旧脚本中途失败的遗留）→ 先退回草稿（latest 回落到上一个完整版本，客户端照常工作），再补传、发布
 *
 * @param {ReturnType<typeof createClient>} gh
 * @param {{ tag: string, name: string, body: string, target?: string,
 *           files: { name: string, size: number, read: () => Buffer }[], log?: (s: string) => void }} o
 */
export async function publishReleaseAtomic(gh, { tag, name, body, target = 'main', files, log = () => {} }) {
  const complete = (rel) => missingAssets(rel, files).length === 0;
  let rel = await gh.findReleaseByTag(tag);
  if (rel && !rel.draft && complete(rel)) { log(`${tag} 已经发布且资产齐全，不重复发布`); return { release: rel, already: true }; }
  if (rel && !rel.draft) {
    log(`${tag} 已发布但缺资产：先退回草稿再补传`);
    rel = await gh.updateRelease(rel.id, { draft: true });
  }
  if (!rel) rel = await gh.createRelease({ tag_name: tag, target_commitish: target, name, body, draft: true, prerelease: false });
  else rel = await gh.updateRelease(rel.id, { name, body, target_commitish: target });

  for (const f of files) {
    const have = (rel.assets ?? []).find((a) => a.name === f.name);
    // 断点续传：上次已经完整传上去的同名同大小资产不重传（安装包 ~100MB）
    if (have && have.state === 'uploaded' && have.size === f.size) { log(`= ${f.name} 已在草稿里`); continue; }
    const t0 = Date.now();
    await uploadReplacing(gh, rel, f.name, f.read(), 'application/octet-stream');
    log(`⬆ ${f.name}  ${(f.size / 1048576).toFixed(1)} MB  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  // 重新取一次再核对：以服务器上的为准，不信本地记账
  const fresh = await gh.getRelease(rel.id);
  const missing = missingAssets(fresh, files);
  if (missing.length) throw new Error(`资产不齐，保持草稿不发布：${missing.join('、')}`);
  const published = await gh.updateRelease(rel.id, { draft: false, prerelease: false, make_latest: 'true' });
  return { release: published, already: false };
}

/** files 里哪些在 release 上缺失 / 没传完 / 大小不对 */
export function missingAssets(rel, files) {
  const assets = rel.assets ?? [];
  return files.filter((f) => !assets.some((a) => a.name === f.name && a.state === 'uploaded' && a.size === f.size))
    .map((f) => f.name);
}
