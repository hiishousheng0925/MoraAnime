/**
 * 站点目录的 junction 操作（scripts/site.js）。
 * 2026-10-21 事故：git worktree remove 顺着 node_modules junction 把主仓库的依赖删光了。
 * 这里在临时目录里实测：删链接只删链接本身，目标目录里的东西一个不少。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeJunction, removeLink, isLink, safeRmTree, pointCurrent, currentRelease, sitePaths,
  pruneReleases, recordHistory, previousRelease, listReleases
} from '../../scripts/site.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'j-anime-site-unit-'));

/** 一个有内容的目标目录：target/keep.txt + target/sub/deep.txt */
function makeTarget(d) {
  const t = join(d, 'target');
  mkdirSync(join(t, 'sub'), { recursive: true });
  writeFileSync(join(t, 'keep.txt'), 'keep');
  writeFileSync(join(t, 'sub', 'deep.txt'), 'deep');
  return t;
}
const intact = (t) => readFileSync(join(t, 'keep.txt'), 'utf8') === 'keep'
  && readFileSync(join(t, 'sub', 'deep.txt'), 'utf8') === 'deep';

test('removeLink：只删 junction 本身，目标内容还在', () => {
  const d = tmp(), t = makeTarget(d), link = join(d, 'link');
  makeJunction(t, link);
  assert.ok(isLink(link), 'junction 建出来了');
  assert.ok(existsSync(join(link, 'sub', 'deep.txt')), '经 junction 能看到目标内容');
  removeLink(link);
  assert.ok(!existsSync(link) && !isLink(link), 'junction 没了');
  assert.ok(intact(t), '目标目录内容完整');
  rmSync(d, { recursive: true, force: true });
});

test('removeLink：不是链接就拒绝，什么都不删', () => {
  const d = tmp(), t = makeTarget(d);
  assert.throws(() => removeLink(t), /不是链接/);
  assert.ok(intact(t));
  rmSync(d, { recursive: true, force: true });
});

test('safeRmTree：里面有 junction 指向外面 → 只删链接，外面的目标完好；入口是链接直接拒绝', () => {
  const d = tmp(), t = makeTarget(d);
  const victim = join(d, 'rel');
  mkdirSync(join(victim, 'a'), { recursive: true });
  writeFileSync(join(victim, 'a', 'f.txt'), 'x');
  makeJunction(t, join(victim, 'a', 'node_modules'));   // 模拟事故里的 node_modules junction
  const entry = join(d, 'entry');
  makeJunction(victim, entry);
  assert.throws(() => safeRmTree(entry), /链接/, '入口是 junction → 拒绝');
  assert.ok(existsSync(join(victim, 'a', 'f.txt')), '拒绝时什么都没删');
  removeLink(entry);
  assert.throws(() => safeRmTree(victim, join(d, 'elsewhere')), /不在/, 'within 不对 → 拒绝');
  safeRmTree(victim, d);
  assert.ok(!existsSync(victim), '目录删掉了');
  assert.ok(intact(t), 'junction 指向的外部目录完好');
  rmSync(d, { recursive: true, force: true });
});

test('pointCurrent / previousRelease / pruneReleases：切换、回滚目标、只留 3 个', () => {
  const d = tmp();
  const P = sitePaths(d);
  mkdirSync(P.releases, { recursive: true });
  const names = ['20260101-000000-aaaaaaa', '20260102-000000-bbbbbbb', '20260103-000000-ccccccc',
                 '20260104-000000-ddddddd', '20260105-000000-eeeeeee'];
  for (const n of names) {
    mkdirSync(join(P.releases, n, 'build'), { recursive: true });
    writeFileSync(join(P.releases, n, 'build', 'index.js'), n);
  }
  // releases 下混一个链接：清理时必须跳过、不跟进去
  const outside = makeTarget(d);
  makeJunction(outside, join(P.releases, 'zz-link'));

  for (const n of names) { pointCurrent(P, n); recordHistory(P, n, 'test'); }
  assert.equal(currentRelease(P), names[4]);
  assert.equal(readFileSync(join(P.current, 'build', 'index.js'), 'utf8'), names[4], 'current 指向最新');
  assert.equal(previousRelease(P), names[3], '回滚目标是上一版');

  // 不完整的版本不切，current 原样
  mkdirSync(join(P.releases, 'broken'));
  assert.throws(() => pointCurrent(P, 'broken'), /不完整/);
  assert.equal(currentRelease(P), names[4]);
  safeRmTree(join(P.releases, 'broken'), P.releases);

  // 回滚到上一版后，previous 变成刚才那版（双向）
  pointCurrent(P, names[3]); recordHistory(P, names[3], 'rollback');
  assert.equal(previousRelease(P), names[4]);

  const removed = pruneReleases(P, 3);
  assert.deepEqual(removed.sort(), names.slice(0, 2));
  assert.deepEqual(listReleases(P), names.slice(2), '留最近 3 个，链接不计入');
  assert.ok(isLink(join(P.releases, 'zz-link')), 'releases 下的链接原样留着');
  assert.ok(intact(outside), '链接指向的目录完好');
  for (const n of names.slice(2)) assert.ok(existsSync(join(P.releases, n, 'build', 'index.js')));

  removeLink(P.current);
  removeLink(join(P.releases, 'zz-link'));
  assert.ok(readdirSync(outside).length === 2);
  rmSync(d, { recursive: true, force: true });
});
