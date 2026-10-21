/**
 * tools/github.js 的单元测试（2026-10-22 审查）：发版「草稿 → 上传 → 校验 → 发布」和 catalog.json 原子替换。
 * fetch 换成内存里的假 GitHub，不联网、不碰真仓库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, publishReleaseAtomic, replaceAssetAtomic, missingAssets } from '../../tools/github.js';

/** 内存假 GitHub：只实现 tools/github.js 用到的接口；log 记下每次写操作，方便核对顺序 */
function fakeGitHub({ releases = [], failUpload = () => false, failRename = () => false } = {}) {
  let nextId = 1000;
  const log = [];
  const res = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const findAsset = (id) => { for (const r of releases) { const a = r.assets.find((x) => x.id === id); if (a) return [r, a]; } return []; };
  /** 外部视角：未登录用户此刻能否下载到某个资产（草稿不可见） */
  const publicHas = (tag, name) => releases.some((r) => r.tag_name === tag && !r.draft && r.assets.some((a) => a.name === name && a.state === 'uploaded'));
  const fetch = async (url, init = {}) => {
    const u = new URL(url), m = init.method ?? 'GET', p = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (u.host === 'uploads.github.com') {
      const rid = Number(p.match(/^\/releases\/(\d+)\/assets$/)[1]), name = u.searchParams.get('name');
      log.push(`upload ${name}`);
      if (failUpload(name)) return res(500, { message: 'boom' });
      const r = releases.find((x) => x.id === rid);
      if (r.assets.some((a) => a.name === name)) return res(422, { message: 'already_exists' });
      const a = { id: nextId++, name, size: init.body.length, state: 'uploaded' };
      r.assets.push(a);
      return res(201, a);
    }
    if (m === 'GET' && p === '/releases') return res(200, releases.map((r) => structuredClone(r)));
    let g;
    if (m === 'GET' && (g = p.match(/^\/releases\/(\d+)$/))) return res(200, structuredClone(releases.find((x) => x.id === Number(g[1]))));
    if (m === 'POST' && p === '/releases') {
      log.push(`create draft=${body.draft}`);
      const r = { id: nextId++, assets: [], html_url: 'https://example.invalid/r', ...body, draft: !!body.draft };
      releases.push(r);
      return res(201, structuredClone(r));
    }
    if (m === 'PATCH' && (g = p.match(/^\/releases\/(\d+)$/))) {
      const r = releases.find((x) => x.id === Number(g[1]));
      log.push(`patch release ${JSON.stringify(body)}`);
      Object.assign(r, body);
      return res(200, structuredClone(r));
    }
    if ((g = p.match(/^\/releases\/assets\/(\d+)$/))) {
      const [r, a] = findAsset(Number(g[1]));
      if (!a) return res(404, { message: 'Not Found' });
      if (m === 'DELETE') { log.push(`delete ${a.name}`); r.assets = r.assets.filter((x) => x !== a); return res(204); }
      if (m === 'PATCH') {
        log.push(`rename ${a.name} -> ${body.name}`);
        if (failRename(a.name, body.name)) return res(500, { message: 'boom' });
        if (r.assets.some((x) => x !== a && x.name === body.name)) return res(422, { message: 'already_exists' });
        a.name = body.name;
        return res(200, a);
      }
    }
    return res(404, { message: `unhandled ${m} ${p}` });
  };
  return { fetch, releases, log, publicHas };
}

const file = (name, text) => ({ name, size: Buffer.byteLength(text), read: () => Buffer.from(text) });
const FILES = [file('MoraAnime-Setup-9.9.9.exe', 'setup-bytes'), file('latest.yml', 'version: 9.9.9'), file('MoraAnime-Setup.exe', 'setup-bytes')];

test('publishReleaseAtomic：新版本先建草稿，资产全部传完前外部看不到，最后才标 latest', async () => {
  const gh = fakeGitHub();
  const client = createClient({ repo: 'o/r', token: 't', fetch: gh.fetch });
  const seen = [];
  const res = await publishReleaseAtomic(client, { tag: 'v9.9.9', name: 'n', body: 'b', files: FILES,
    log: () => seen.push(gh.publicHas('v9.9.9', 'latest.yml')) });
  assert.equal(res.already, false);
  assert.ok(seen.length >= FILES.length && seen.every((x) => x === false), '上传过程中 release 不可见');
  assert.equal(gh.log[0], 'create draft=true');
  const last = gh.log.at(-1);
  assert.match(last, /"draft":false/);
  assert.match(last, /"make_latest":"true"/);
  assert.ok(gh.log.indexOf(last) > gh.log.lastIndexOf('upload MoraAnime-Setup.exe'), '发布在所有上传之后');
  for (const f of FILES) assert.ok(gh.publicHas('v9.9.9', f.name));
});

test('publishReleaseAtomic：上传中途失败 → 保持草稿、不发布；重跑接着用草稿且不重传已有资产', async () => {
  let broken = true;
  const gh = fakeGitHub({ failUpload: (n) => broken && n === 'latest.yml' });
  const client = createClient({ repo: 'o/r', token: 't', fetch: gh.fetch });
  await assert.rejects(publishReleaseAtomic(client, { tag: 'v9.9.9', name: 'n', body: 'b', files: FILES }), /上传 latest\.yml 失败/);
  assert.equal(gh.releases.length, 1);
  assert.equal(gh.releases[0].draft, true);
  assert.ok(!gh.log.some((l) => /"draft":false/.test(l)), '失败时绝不转正式版');

  broken = false;
  gh.log.length = 0;
  await publishReleaseAtomic(client, { tag: 'v9.9.9', name: 'n', body: 'b', files: FILES });
  assert.equal(gh.releases.length, 1, '同 tag 的草稿复用，不另建');
  assert.ok(!gh.log.includes('upload MoraAnime-Setup-9.9.9.exe'), '已完整传上去的不重传');
  assert.ok(gh.log.includes('upload latest.yml'));
  assert.equal(gh.releases[0].draft, false);
});

test('publishReleaseAtomic：草稿里有残缺的同名资产 → 先删再传', async () => {
  const gh = fakeGitHub({ releases: [{ id: 1, tag_name: 'v9.9.9', draft: true, assets: [{ id: 5, name: 'latest.yml', size: 3, state: 'uploaded' }] }] });
  const client = createClient({ repo: 'o/r', token: 't', fetch: gh.fetch });
  await publishReleaseAtomic(client, { tag: 'v9.9.9', name: 'n', body: 'b', files: FILES });
  assert.ok(gh.log.indexOf('delete latest.yml') < gh.log.indexOf('upload latest.yml'));
  assert.deepEqual(missingAssets(gh.releases[0], FILES), []);
});

test('publishReleaseAtomic：校验发现资产不齐 → 抛错并保持草稿', async () => {
  const gh = fakeGitHub();
  const client = createClient({ repo: 'o/r', token: 't', fetch: gh.fetch });
  // 模拟服务器上资产没传完（state 不是 uploaded）
  const orig = client.getRelease;
  client.getRelease = async (id) => { const r = await orig(id); r.assets[0].state = 'starter'; return r; };
  await assert.rejects(publishReleaseAtomic(client, { tag: 'v9.9.9', name: 'n', body: 'b', files: FILES }), /资产不齐/);
  assert.equal(gh.releases[0].draft, true);
});

test('publishReleaseAtomic：已发布且齐全 → 不动；已发布但缺资产 → 先退回草稿再补传、发布', async () => {
  const full = FILES.map((f, i) => ({ id: 10 + i, name: f.name, size: f.size, state: 'uploaded' }));
  const gh1 = fakeGitHub({ releases: [{ id: 1, tag_name: 'v9.9.9', draft: false, assets: full }] });
  const r1 = await publishReleaseAtomic(createClient({ repo: 'o/r', token: 't', fetch: gh1.fetch }), { tag: 'v9.9.9', name: 'n', body: 'b', files: FILES });
  assert.equal(r1.already, true);
  assert.deepEqual(gh1.log, []);

  const gh2 = fakeGitHub({ releases: [{ id: 1, tag_name: 'v9.9.9', draft: false, assets: full.slice(0, 1) }] });
  await publishReleaseAtomic(createClient({ repo: 'o/r', token: 't', fetch: gh2.fetch }), { tag: 'v9.9.9', name: 'n', body: 'b', files: FILES });
  assert.match(gh2.log[0], /"draft":true/);
  assert.match(gh2.log.at(-1), /"draft":false/);
  assert.deepEqual(missingAssets(gh2.releases[0], FILES), []);
});

const catalogRelease = () => ({ id: 1, tag_name: 'catalog', draft: false, prerelease: true,
  assets: [{ id: 7, name: 'catalog.json', size: 3, state: 'uploaded' }, { id: 8, name: 'catalog.json.tmp-1', size: 1, state: 'uploaded' }] });

test('replaceAssetAtomic：先传临时名 → 旧的改备份名 → 新的改正式名 → 删备份；临时名上传前清掉上次遗留', async () => {
  const gh = fakeGitHub({ releases: [catalogRelease()] });
  const client = createClient({ repo: 'o/r', token: 't', fetch: gh.fetch });
  const rel = structuredClone(gh.releases[0]);
  await replaceAssetAtomic(client, rel, 'catalog.json', Buffer.from('{"v":2}'), 'application/json', { stamp: 42 });
  assert.deepEqual(gh.log, [
    'delete catalog.json.tmp-1',
    'upload catalog.json.tmp-42',
    'rename catalog.json -> catalog.json.bak-42',
    'rename catalog.json.tmp-42 -> catalog.json',
    'delete catalog.json.bak-42'
  ]);
  assert.deepEqual(gh.releases[0].assets.map((a) => [a.name, a.size]), [['catalog.json', 7]]);
});

test('replaceAssetAtomic：上传失败 → 旧 manifest 原封不动', async () => {
  const gh = fakeGitHub({ releases: [catalogRelease()], failUpload: (n) => n.startsWith('catalog.json.tmp-') });
  const client = createClient({ repo: 'o/r', token: 't', fetch: gh.fetch });
  await assert.rejects(replaceAssetAtomic(client, structuredClone(gh.releases[0]), 'catalog.json', Buffer.from('x'), 'application/json'), /上传/);
  assert.ok(gh.publicHas('catalog', 'catalog.json'));
  assert.equal(gh.releases[0].assets.find((a) => a.name === 'catalog.json').id, 7);
});

test('replaceAssetAtomic：新的改名失败 → 旧的改回正式名', async () => {
  const gh = fakeGitHub({ releases: [catalogRelease()], failRename: (from, to) => from.startsWith('catalog.json.tmp-') && to === 'catalog.json' });
  const client = createClient({ repo: 'o/r', token: 't', fetch: gh.fetch });
  await assert.rejects(replaceAssetAtomic(client, structuredClone(gh.releases[0]), 'catalog.json', Buffer.from('x'), 'application/json', { stamp: 42 }), /改名/);
  assert.equal(gh.releases[0].assets.find((a) => a.name === 'catalog.json').id, 7, '旧 manifest 恢复');
});

test('replaceAssetAtomic：release 上还没有 catalog.json（第一次发布）也能用', async () => {
  const gh = fakeGitHub({ releases: [{ id: 1, tag_name: 'catalog', draft: false, assets: [] }] });
  const client = createClient({ repo: 'o/r', token: 't', fetch: gh.fetch });
  await replaceAssetAtomic(client, structuredClone(gh.releases[0]), 'catalog.json', Buffer.from('{}'), 'application/json', { stamp: 1 });
  assert.deepEqual(gh.releases[0].assets.map((a) => a.name), ['catalog.json']);
});

test('client：删除失败要抛错（原来 DELETE 的返回值没人看）', async () => {
  const gh = fakeGitHub({ releases: [{ id: 1, tag_name: 'x', draft: false, assets: [] }] });
  const client = createClient({ repo: 'o/r', token: 't', fetch: gh.fetch });
  await assert.rejects(client.deleteAsset(999), /删资产 失败 HTTP 404/);
});
