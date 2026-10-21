/** bangumiArchive.js 解析的单元测试（#2）。样例取自 2026-10-13 那份 dump 里的真实格式。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ibField, ibAliases, parseDate, parseEps, parseWeekday, seasonOf, jpVerdict, parseSubject }
  from '../../src/lib/server/bangumiArchive.js';

const IB = '{{Infobox animanga/TVAnime\r\n|中文名= Code Geass 反叛的鲁路修R2\r\n|别名={\r\n[叛逆的鲁路修R2]\r\n'
  + '[Code Geass: Hangyaku no Lelouch R2]\r\n[ja|コードギアス R2]\r\n}\r\n|话数= 25\r\n|放送开始= 2008年4月6日\r\n'
  + '|放送星期= 星期日\r\n|播放结束= 2008年9月28日\r\n|动画制作= サンライズ\r\n|官方网站= \r\n}}';

test('ibField / ibAliases', () => {
  assert.equal(ibField(IB, '话数'), '25');
  assert.equal(ibField(IB, '动画制作'), 'サンライズ');
  assert.equal(ibField(IB, '官方网站'), null, '空值');
  assert.equal(ibField(IB, '不存在'), null);
  assert.deepEqual(ibAliases(IB), ['叛逆的鲁路修R2', 'Code Geass: Hangyaku no Lelouch R2', 'コードギアス R2'], '去掉 ja| 前缀');
  assert.deepEqual(ibAliases('|中文名= x'), []);
});

test('parseDate：四种写法', () => {
  assert.equal(parseDate('2008年4月6日'), '2008-04-06');
  assert.equal(parseDate('2009-07-09'), '2009-07-09');
  assert.equal(parseDate('2008-4-6'), '2008-04-06');
  assert.equal(parseDate('2002年9月'), '2002-09');
  assert.equal(parseDate('1987年'), '1987');
  assert.equal(parseDate('2015年2月25日（剧中：2014年10月）'), '2015-02-25');
  assert.equal(parseDate('*'), null);
  assert.equal(parseDate(''), null);
});

test('parseEps / parseWeekday / seasonOf', () => {
  assert.equal(parseEps('25'), 25);
  assert.equal(parseEps('24+2'), 26);
  assert.equal(parseEps('*'), null);
  assert.equal(parseEps('0'), null);
  assert.equal(parseWeekday('星期日'), 7);
  assert.equal(parseWeekday('星期一'), 1);
  assert.equal(parseWeekday('每天'), null);
  assert.equal(seasonOf('2026-10-05'), 'FALL');
  assert.equal(seasonOf('2026-01-09'), 'WINTER');
  assert.equal(seasonOf('2026'), 'UNDEFINED');
});

test('jpVerdict：A6 国创不算日本动画，合拍算日本', () => {
  const t = (...names) => names.map((name) => ({ name, count: 50 }));
  assert.equal(jpVerdict({ tags: t('日本', 'TV') }), 1);
  assert.equal(jpVerdict({ tags: t('国产', 'TV') }), 0);
  assert.equal(jpVerdict({ tags: t('日本', '中国') }), 1, '中日合拍');
  assert.equal(jpVerdict({ tags: t('欧美') }), 0);
  assert.equal(jpVerdict({ tags: [{ name: '国产', count: 1 }], name: 'テスト' }), 1, '计数太少的 tag 不算，退回看假名');
  assert.equal(jpVerdict({ tags: [], infobox: '|制片国家/地区= 美国' }), 0);
  assert.equal(jpVerdict({ tags: [], name: 'Some Title' }), null, '判不出交给 AOD');
});

test('parseSubject：整条', () => {
  const s = parseSubject({ id: 8, name: 'コードギアス 反逆のルルーシュR2', name_cn: 'Code Geass 反叛的鲁路修R2',
    platform: 1, date: '2008-04-06', infobox: IB, nsfw: false, score: 8.3, rank: 85,
    score_details: { 9: 10, 10: 5 }, favorite: { wish: 1, done: 2, doing: 3, on_hold: 4, dropped: 5 },
    tags: [{ name: '日本', count: 30 }, { name: '机战', count: 20 }, { name: '冷门', count: 1 }] });
  assert.equal(s.type, 'TV');
  assert.equal(s.year, 2008);
  assert.equal(s.season, 'SPRING');
  assert.equal(s.air_end, '2008-09-28');
  assert.equal(s.eps, 25);
  assert.equal(s.weekday, 7);
  assert.equal(s.collection, 15);
  assert.equal(s.votes, 15);
  assert.equal(s.is_jp, 1);
  assert.deepEqual(s.tags, ['日本', '机战'], '计数 <3 的标签不要');
});
