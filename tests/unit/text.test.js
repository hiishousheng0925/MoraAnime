/**
 * text.js 纯函数的单元测试（#40）。原来这些全靠 e2e 间接覆盖，改一次要跑几分钟才知道对不对，
 * 而 CLAUDE.md 记录的 bug 有一大半出在这里。秒级反馈：node --test tests/unit/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seasonOrd, partOrd, fixCnSeason, pickTitleJa, hasForeignScript, dedupKey, segment }
  from '../../src/lib/server/text.js';

test('seasonOrd：既有写法', () => {
  assert.equal(seasonOrd('Shingeki no Kyojin Season 3'), 3);
  assert.equal(seasonOrd('Tensei shitara Slime Datta Ken 2nd Season Part 2'), 2);
  assert.equal(seasonOrd('Kaguya-sama wa Kokurasetai: Dai 2 ki'), 2);
  assert.equal(seasonOrd('Overlord IV'), 4);
  assert.equal(seasonOrd('关于我转生变成史莱姆这档事 第二季'), 2);
  // Part / Cour 不算季数（Lupin III: Part II 曾被数两次）
  assert.equal(seasonOrd('Lupin III: Part II'), 1);
});

test('seasonOrd：结尾阿拉伯数字只在 TV 时才认（#15）', () => {
  assert.equal(seasonOrd('One Punch Man 3'), 1, '缺省不认，保持原行为');
  assert.equal(seasonOrd('One Punch Man 3', { trailingNum: true }), 3);
  assert.equal(seasonOrd('Chihayafuru 2', { trailingNum: true }), 2);
  assert.equal(seasonOrd('Hibike! Euphonium 3', { trailingNum: true }), 3);
  assert.equal(seasonOrd("Asura Cryin' 2", { trailingNum: true }), 2);
  // 不该认的
  assert.equal(seasonOrd('Detective Conan Movie 19', { trailingNum: true }), 1, '两位数');
  assert.equal(seasonOrd('Kara no Kyoukai Movie 2', { trailingNum: true }), 1, 'movie N');
  assert.equal(seasonOrd('Something Vol 2', { trailingNum: true }), 1, 'vol N');
  assert.equal(seasonOrd('Steins;Gate 0', { trailingNum: true }), 1, '0 不是季数');
  assert.equal(seasonOrd('Mob Psycho 100', { trailingNum: true }), 1, '作品名里的数字');
});

test('partOrd', () => {
  assert.equal(partOrd('86 Part 2'), 2);
  assert.equal(partOrd('Mushoku Tensei II Part 2'), 2);
  assert.equal(partOrd('Lupin III: Part II'), 2);
  assert.equal(partOrd('86 -不存在的战区- 第2部分'), 2);
  assert.equal(partOrd('Plain Title'), 0);
});

test('fixCnSeason', () => {
  assert.equal(fixCnSeason('歌牌情缘', 'Chihayafuru 2', { tv: true }), '歌牌情缘 第二季');
  assert.equal(fixCnSeason('歌牌情缘', 'Chihayafuru 2'), '歌牌情缘', '非 TV 不按结尾数字改');
  assert.equal(fixCnSeason('间谍过家家 第二季', 'Spy x Family Season 2'), '间谍过家家 第二季', '已一致不改');
  assert.equal(fixCnSeason('关于我转生变成史莱姆这档事 第二季', 'Tensei shitara Slime Datta Ken 2nd Season Part 2'),
    '关于我转生变成史莱姆这档事 第二季 第2部分', '分割播出两段要能区分');
});

test('pickTitleJa：排除泰文 / 韩文 / 西里尔（#16）', () => {
  assert.equal(pickTitleJa(['โตเกียว卍รีเวนเจอร์ส', '東京卍リベンジャーズ'], 'Tokyo Revengers'), '東京卍リベンジャーズ');
  assert.equal(pickTitleJa(['미나미家 세자매', 'みなみけ'], 'Minami-ke'), 'みなみけ');
  assert.equal(pickTitleJa(['Тест'], 'Test'), null, '只有西里尔候选时不挑');
  assert.ok(hasForeignScript('초(超) 가구야 공주!'));
  assert.ok(!hasForeignScript('超かぐや姫!'));
});

test('pickTitleJa：既有规则不退化', () => {
  // 简体中文名不能赢过更短的日文原题（异世界药局 → 异世界舅舅 那次事故）
  assert.equal(pickTitleJa(['奇幻世界药局', '異世界薬局'], 'Isekai Yakkyoku'), '異世界薬局');
  // 缩写不能当 title_ja
  assert.equal(pickTitleJa(['ふつつかな悪女ではございますが', 'ふつつか'], 'Futsutsuka'), 'ふつつかな悪女ではございますが');
});

test('dedupKey：写法归一、分季不归一', () => {
  assert.equal(dedupKey('Yoroi Shinden Samurai Troopers (2026)', 2026), dedupKey('Yoroi Shinden Samurai Troopers', 2026));
  assert.equal(dedupKey('Foo Part II'), dedupKey('Foo 2nd Cour'));
  assert.notEqual(dedupKey('Foo'), dedupKey('Foo Season 2'));
});

test('segment：CJK 逐字，两字查询也能命中', () => {
  const s = segment('进击的巨人');
  for (const ch of '进击的巨人') assert.ok(s.includes(ch));
});
