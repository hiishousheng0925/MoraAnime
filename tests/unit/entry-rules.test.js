/** entryRules.js：/api/entry、/api/triage 和备份导入共用的取值规则（2026-10-21 审核：导入原来不校验） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTRY_CHECK, TRIAGE_VERDICTS, isId, normScore } from '../../src/lib/server/entryRules.js';

test('status 只认 WATCH_STATUS 里的', () => {
  for (const s of ['plan', 'watching', 'completed']) assert.ok(ENTRY_CHECK.status(s), s);
  for (const s of ['bogus', '', null, undefined, 'toString']) assert.ok(!ENTRY_CHECK.status(s), String(s));
});

test('评分 1–10、最多一位小数；进度是整数', () => {
  assert.ok(ENTRY_CHECK.my_score(8.4));
  assert.ok(ENTRY_CHECK.my_score(null));
  for (const v of [8.45, 0, 11, '8', NaN]) assert.ok(!ENTRY_CHECK.my_score(v), String(v));
  assert.ok(ENTRY_CHECK.current_episode(0));
  for (const v of ['0abc', 1.5, -1]) assert.ok(!ENTRY_CHECK.current_episode(v), String(v));
  assert.equal(normScore(8.399999), 8.4);
  assert.equal(normScore(null), null);
});

test('短评长度上限、id 与快速标记取值', () => {
  assert.ok(ENTRY_CHECK.my_note('x'.repeat(2000)));
  assert.ok(!ENTRY_CHECK.my_note('x'.repeat(2001)));
  assert.ok(isId(1) && !isId(0) && !isId('1') && !isId(1.5));
  assert.deepEqual(TRIAGE_VERDICTS, ['seen', 'not_seen', 'never_heard', 'skipped']);
});
