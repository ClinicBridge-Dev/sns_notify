const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/threadlang.js');

test('set then get, fallback when missing', () => {
  const m = T.setThreadLang({}, 't1', 'OFF', 1000, 500);
  assert.equal(T.getThreadLang(m, 't1', 'EN-US'), 'OFF');
  assert.equal(T.getThreadLang(m, 't2', 'EN-US'), 'EN-US');
});

test('drops the oldest entries beyond the cap', () => {
  let m = {};
  m = T.setThreadLang(m, 'a', 'JA', 1, 2);
  m = T.setThreadLang(m, 'b', 'JA', 2, 2);
  m = T.setThreadLang(m, 'c', 'JA', 3, 2);
  assert.deepEqual(Object.keys(m).sort(), ['b', 'c']);
});

test('values are { lang, at } and input map is not mutated', () => {
  const m0 = {};
  const m = T.setThreadLang(m0, 'a', 'JA', 5, 10);
  assert.deepEqual(m.a, { lang: 'JA', at: 5 });
  assert.deepEqual(m0, {});
});

test('updating an existing thread refreshes its age and does not evict others', () => {
  let m = {};
  m = T.setThreadLang(m, 'a', 'JA', 1, 2);
  m = T.setThreadLang(m, 'b', 'JA', 2, 2);
  m = T.setThreadLang(m, 'a', 'OFF', 3, 2);
  assert.deepEqual(Object.keys(m).sort(), ['a', 'b']);
  m = T.setThreadLang(m, 'c', 'JA', 4, 2);
  assert.deepEqual(Object.keys(m).sort(), ['a', 'c']);
});

test('get tolerates null map and malformed entries', () => {
  assert.equal(T.getThreadLang(null, 'x', 'EN-US'), 'EN-US');
  assert.equal(T.getThreadLang({ x: 'bad' }, 'x', 'EN-US'), 'EN-US');
});
