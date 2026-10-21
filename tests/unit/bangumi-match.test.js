/**
 * bangumiMatch.js 的单元测试（#2，根治 #12 续作挂前作）。
 * 用一个小的合成索引，把正式库副本上评估时踩到的几类情况钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, matchRow, ordOf, normName } from '../../src/lib/server/bangumiMatch.js';

const S = (id, name, name_cn, platform, year, eps, aliases = []) =>
  [id, { id, name, name_cn, platform, year, eps, aliases, type: { 1: 'TV', 2: 'OVA', 3: 'MOVIE', 5: 'ONA' }[platform] }];
const subjects = new Map([
  S(1, 'ダンダダン', '胆大党', 1, 2024, 12),
  S(2, 'ダンダダン 第2期', '胆大党 第二季', 1, 2025, 12),
  S(3, '斉木楠雄のΨ難', '齐木楠雄的灾难', 1, 2016, 24),
  S(4, '彼女、お借りします', '租借女友', 1, 2020, 12),
  S(5, 'ARIA The ANIMATION', '水星领航员', 1, 2005, 13),
  S(6, 'ARIA The NATURAL', '水星领航员 第二季', 1, 2006, 26),
  S(7, '同名作品', '同名作品', 1, 2010, 12),
  S(8, '同名作品', '同名作品', 1, 2010, 12),
  S(9, '劇場総集編 SSSS.DYNAZENON', '剧场总集篇 SSSS.电光机王', 3, 2023, 1)
]);
const relations = [{ a: 1, b: 2, type: 3 }, { a: 5, b: 6, type: 3 }];
const idx = buildIndex(subjects, relations);
const row = (o) => ({ title: '', title_ja: null, title_cn: null, type: 'TV', year: null, episodes: 0, bgm_id: null, aliases: [], ...o });

test('ordOf：Bangumi 的各种季数 / 分部号写法', () => {
  assert.deepEqual(ordOf('胆大党 第二季'), { season: 2, part: 1 });
  assert.deepEqual(ordOf('Re：从零开始的异世界生活 第二季 后半部分'), { season: 2, part: 2 });
  assert.deepEqual(ordOf('進撃の巨人 Season3 Part.2'), { season: 3, part: 2 });
  assert.equal(ordOf('魔王学院の不適合者 Ⅱ').season, 2, '全角罗马数字');
  assert.equal(ordOf('因为太怕痛就全点防御力了。2').season, 2, '句读后的数字');
  assert.equal(ordOf('钻石王牌 act2').season, 2);
  assert.equal(normName('ＡＲＩＡ The NATURAL'), normName('aria the natural'));
});

test('续作挂前作：沿续集关系改挂到对的那一季（#12）', () => {
  // 「胆大党 第二季」那条 AOD 记录原来的 bgm_id 错指第一季
  const m = matchRow(idx, row({ title: 'Dandadan 2nd Season', title_ja: 'ダンダダン 第2期', year: 2025, episodes: 12, bgm_id: 1 }));
  assert.equal(m.id, 2);
  // 反过来：第一季挂着第二季（间谍过家家 S1 → S2 那类）
  assert.equal(matchRow(idx, row({ title: 'Dandadan', title_ja: 'ダンダダン', year: 2024, episodes: 12, bgm_id: 2 })).id, 1);
});

test('标题里不写季数的第二季（Aria the Natural）', () => {
  assert.equal(matchRow(idx, row({ title: 'Aria the Natural', year: 2006, episodes: 26, bgm_id: 6 })).id, 6);
});

test('数集口径不同但是同一部作品：主标题精确 / 原 bgm_id + 类型对口 + 同年', () => {
  // 齐木楠雄 AOD 按 5 分钟一段数成 120 集；title_ja 多了「 TV」后缀，靠原 bgm_id 认
  assert.equal(matchRow(idx, row({ title: 'Saiki Kusuo no Ψ-nan', title_ja: '斉木楠雄のΨ難 TV', year: 2016, episodes: 120, bgm_id: 3 })).id, 3);
});

test('集数差 4 倍以上且不是同一部作品 → 不配（租借女友 × halca 联动短片）', () => {
  const m = matchRow(idx, row({ title: 'Kanojo, Okarishimasu × halca', type: 'ONA', year: 2020, episodes: 1, bgm_id: 4 }));
  assert.equal(m.id, null);
});

test('两个候选打平且都不是原 bgm_id → 宁缺勿错', () => {
  assert.equal(matchRow(idx, row({ title_ja: '同名作品', year: 2010, episodes: 12 })).id, null);
  // 打平但其中一个就是原 bgm_id → 留着它
  assert.equal(matchRow(idx, row({ title_ja: '同名作品', year: 2010, episodes: 12, bgm_id: 8 })).id, 8);
});

test('类型 / 年份硬条件', () => {
  // 剧场版不会被配到 TV（除非主标题精确且集数一致）
  assert.equal(matchRow(idx, row({ title_ja: 'ダンダダン', type: 'MOVIE', year: 2024, episodes: 1 })).id, null);
  // 年份差 2 年以上不配
  assert.equal(matchRow(idx, row({ title_ja: 'ダンダダン', year: 2020, episodes: 12 })).id, null);
  // 剧场版之间正常配上（总集篇）
  assert.equal(matchRow(idx, row({ title: 'SSSS.Dynazenon Movie', title_cn: '剧场总集篇 SSSS.电光机王', type: 'MOVIE', year: 2023, episodes: 1, bgm_id: 9 })).id, 9);
});
