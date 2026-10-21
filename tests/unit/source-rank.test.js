/**
 * 片源结果打分（观看页自动选片源用）：同季同名最高，别的季、剧场版不能过自动选的门槛。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreHit } from '../../src/lib/server/sources/rank.js';
import { WATCH_AUTO_PICK } from '../../src/lib/constants.js';

test('scoreHit：分得出季数', () => {
  const w = ['药屋少女的呢喃 第三季', '薬屋のひとりごと 第3期'];
  assert.ok(scoreHit('药屋少女的呢喃 第三季', w) >= WATCH_AUTO_PICK);
  assert.ok(scoreHit('药屋少女的呢喃第三季', w) >= WATCH_AUTO_PICK, '空格不影响');
  assert.ok(scoreHit('药屋少女的呢喃 第3季', w) >= WATCH_AUTO_PICK, '阿拉伯数字季数');
  assert.ok(scoreHit('药屋少女的呢喃 第二季', w) < WATCH_AUTO_PICK, '第二季不自动选');
  assert.ok(scoreHit('药屋少女的呢喃', w) < WATCH_AUTO_PICK, '第一季不自动选');
  assert.ok(scoreHit('剧场版 药屋少女的呢喃', w) < WATCH_AUTO_PICK);
  assert.equal(scoreHit('间谍过家家', w), 0, '不相干的 0 分');
});

test('scoreHit：同名精确的排在包含关系前面', () => {
  const w = ['葬送的芙莉莲'];
  assert.ok(scoreHit('葬送的芙莉莲', w) > scoreHit('葬送的芙莉莲 ～●●的魔法～', w));
});

test('季数：中日文名结尾的数字 / 罗马数字也认（转生就是剑 第二季页面曾给第一季打出 70 分）', async () => {
  const { seasonOf } = await import('../../src/lib/server/sources/rank.js');
  assert.equal(seasonOf('转生成为魔剑了 2'), 2);
  assert.equal(seasonOf('転生したら剣でしたII'), 2);
  assert.equal(seasonOf('Tensei shitara Ken deshita 2'), 2);
  assert.equal(seasonOf('转生就是剑第二季'), 2);
  assert.equal(seasonOf('Mob Psycho 100'), 1, '作品名里的数字不算');
  assert.equal(seasonOf('86'), 1);
  const s2 = ['转生就是剑 第二季', '转生成为魔剑了 2', '转生成为魔剑了 第二季'];
  assert.ok(scoreHit('转生成为魔剑了', s2) < WATCH_AUTO_PICK, '第二季页面不自动选第一季');
  assert.ok(scoreHit('转生成为魔剑了 第二季', s2) >= WATCH_AUTO_PICK);
  assert.ok(scoreHit('转生就是剑第二季', s2) >= WATCH_AUTO_PICK);
});

test('searchKeywords：原名 + 去季数 + 最常见的别名（各站名字不一样）', async () => {
  const { searchKeywords } = await import('../../src/lib/server/sources/rank.js');
  assert.deepEqual(searchKeywords('转生就是剑 第二季',
    ['转生就是剑 第二季', '転生したら剣でしたII', '转生成为魔剑了 2', '转生成为魔剑了 第二季', '转生成为魔剑 第二季']),
    ['转生就是剑 第二季', '转生就是剑', '转生成为魔剑了']);
  // 繁体别名转成简体后和原名相同，不另算一个词
  assert.deepEqual(searchKeywords('转生就是剑', ['转生就是剑', '轉生就是劍', '转生成为魔剑了']), ['转生就是剑', '转生成为魔剑了']);
  assert.ok(searchKeywords('间谍过家家', ['间谍过家家']).length === 1, '没别名就只搜一次');
});

test('季数以主标题为准：不带季数的别名不能让第一季在第二季页面拿满分', () => {
  const w = ['Fate/stay night [Unlimited Blade Works] 第二季', 'Fate/stay night: Unlimited Blade Works 2nd Season', '命运之夜 无限剑制'];
  assert.ok(scoreHit('命运之夜 无限剑制', w) < WATCH_AUTO_PICK);
  assert.ok(scoreHit('命运之夜 无限剑制 第二季', w) >= WATCH_AUTO_PICK);
});

test('分部：上半页不自动选「第2部分」；下半页优先明写的，合并成一条的也能用', () => {
  const p1 = ['无职转生 第二季 ～到了异世界就拿出真本事～'];
  const p2 = ['无职转生 第二季 ～到了异世界就拿出真本事～ 第2部分'];
  assert.ok(scoreHit('无职转生 第二季 ～到了异世界就拿出真本事～ 第2部分', p1) < WATCH_AUTO_PICK);
  assert.ok(scoreHit('无职转生 第二季 ～到了异世界就拿出真本事～', p1) >= WATCH_AUTO_PICK);
  const explicit = scoreHit('无职转生 第二季 ～到了异世界就拿出真本事～ 第2部分', p2);
  const merged = scoreHit('无职转生 第二季 ～到了异世界就拿出真本事～', p2);
  assert.ok(explicit > merged && merged >= WATCH_AUTO_PICK);
  assert.ok(scoreHit('进击的巨人 第三季', ['进击的巨人 第三季 Part.2']) < scoreHit('进击的巨人第三季 Part2', ['进击的巨人 第三季 Part.2']));
});

test('名字中间的罗马数字是季数：「无职转生Ⅱ ～…～」', async () => {
  const { seasonOf } = await import('../../src/lib/server/sources/rank.js');
  assert.equal(seasonOf('无职转生Ⅱ ～到了异世界就拿出真本事～'), 2);
  assert.ok(scoreHit('无职转生Ⅱ ～到了异世界就拿出真本事～', ['无职转生 第二季 ～到了异世界就拿出真本事～']) >= WATCH_AUTO_PICK);
  assert.equal(seasonOf('Fate/stay night [Unlimited Blade Works]'), 1);
});

test('包含关系：短名要够长、占一半以上（#92 太空小五义自动播了猪猪侠）', () => {
  const w = ['太空小五义', '小英雄'];
  assert.ok(scoreHit('猪猪侠大电影之竞速小英雄', w) < WATCH_AUTO_PICK);
  assert.ok(scoreHit('救难小英雄', w) < WATCH_AUTO_PICK);
  assert.ok(scoreHit('太空小五义', w) >= WATCH_AUTO_PICK);
  assert.ok(scoreHit('进击的巨人 最终季 完结篇 前篇', ['进击的巨人']) < WATCH_AUTO_PICK, '第一季页面不自动选最终季');
  assert.ok(scoreHit('剧场版 咒术回战 0', ['咒术回战 0']) >= WATCH_AUTO_PICK, '「剧场版 xxx」照样算');
});

test('searchKeywords：太短的别名不拿来搜；带假名的原名补罗马字（#92 #95）', async () => {
  const { searchKeywords } = await import('../../src/lib/server/sources/rank.js');
  assert.ok(!searchKeywords('太空小五义', ['太空小五义', 'Gordam', '小英雄']).includes('小英雄'));
  const k = searchKeywords('CLANNAD ~After Story~ クラナド アフターストーリー',
    ['ＣＬＡＮＮＡＤ ~After Story~ クラナド アフターストーリー', 'Clannad: After Story']);
  assert.ok(k.includes('Clannad: After Story'), JSON.stringify(k));
});
