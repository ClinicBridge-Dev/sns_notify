const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/threadlang.js');
const C = require('../lib/constants.js');

const DEF = 'EN-US';
const get = (map, tid) => T.getThreadLang(map, tid, DEF, C.isValidThreadLang);

// ---- 4-4 변환 표: 위에서부터 차례로 ----
test('row 1: new form is returned as is', () => {
  assert.deepEqual(get({ t: { lang: 'JA', on: true, at: 1 } }, 't'), { lang: 'JA', on: true });
  assert.deepEqual(get({ t: { lang: 'JA', on: false, at: 1 } }, 't'), { lang: 'JA', on: false });
});

test('row 2: old form without on reads as on', () => {
  assert.deepEqual(get({ t: { lang: 'JA', at: 1 } }, 't'), { lang: 'JA', on: true });
});

test('row 3: old { lang: "OFF" } reads as off with the default language', () => {
  assert.deepEqual(get({ t: { lang: 'OFF', at: 1 } }, 't'), { lang: DEF, on: false });
});

test('row 4: bare string "OFF" reads as off', () => {
  assert.deepEqual(get({ t: 'OFF' }, 't'), { lang: DEF, on: false });
});

test('row 5: bare string language code reads as on', () => {
  assert.deepEqual(get({ t: 'JA' }, 't'), { lang: 'JA', on: true });
});

test('row 6: missing value reads as default and on', () => {
  assert.deepEqual(get({}, 't'), { lang: DEF, on: true });
  assert.deepEqual(get(null, 't'), { lang: DEF, on: true });
});

test('row 7: off with an unknown or broken language stays off', () => {
  assert.deepEqual(get({ t: { lang: 'KO', on: false, at: 1 } }, 't'), { lang: DEF, on: false });
  assert.deepEqual(get({ t: { lang: 42, on: false, at: 1 } }, 't'), { lang: DEF, on: false });
  assert.deepEqual(get({ t: { on: false, at: 1 } }, 't'), { lang: DEF, on: false });
});

test('row 8: other broken values read like a missing value', () => {
  assert.deepEqual(get({ t: { lang: 'KO', on: true, at: 1 } }, 't'), { lang: DEF, on: true });
  assert.deepEqual(get({ t: { lang: 'KO', at: 1 } }, 't'), { lang: DEF, on: true });
  assert.deepEqual(get({ t: 'bad' }, 't'), { lang: DEF, on: true });
  assert.deepEqual(get({ t: 7 }, 't'), { lang: DEF, on: true });
});

test('"OFF" is never returned as a language', () => {
  assert.notEqual(get({ t: { lang: 'OFF', on: true, at: 1 } }, 't').lang, 'OFF');
  assert.equal(get({ t: { lang: 'OFF', on: true, at: 1 } }, 't').on, false);
});

// ---- 저장 ----
test('set writes the new form and does not mutate the input', () => {
  const m0 = {};
  const m = T.setThreadLang(m0, 'a', 'JA', true, 5, 10);
  assert.deepEqual(m.a, { lang: 'JA', on: true, at: 5 });
  assert.deepEqual(m0, {});
});

test('turning off then on again keeps the language', () => {
  let m = T.setThreadLang({}, 'a', 'JA', true, 1, 10);
  m = T.setThreadLang(m, 'a', get(m, 'a').lang, false, 2, 10);
  assert.deepEqual(get(m, 'a'), { lang: 'JA', on: false });
  m = T.setThreadLang(m, 'a', get(m, 'a').lang, true, 3, 10);
  assert.deepEqual(get(m, 'a'), { lang: 'JA', on: true });
});

test('drops the oldest entries beyond the cap', () => {
  let m = {};
  m = T.setThreadLang(m, 'a', 'JA', true, 1, 2);
  m = T.setThreadLang(m, 'b', 'JA', true, 2, 2);
  m = T.setThreadLang(m, 'c', 'JA', true, 3, 2);
  assert.deepEqual(Object.keys(m).sort(), ['b', 'c']);
});

test('updating an existing thread refreshes its age and does not evict others', () => {
  let m = {};
  m = T.setThreadLang(m, 'a', 'JA', true, 1, 2);
  m = T.setThreadLang(m, 'b', 'JA', true, 2, 2);
  m = T.setThreadLang(m, 'a', 'JA', false, 3, 2);
  assert.deepEqual(Object.keys(m).sort(), ['a', 'b']);
  m = T.setThreadLang(m, 'c', 'JA', true, 4, 2);
  assert.deepEqual(Object.keys(m).sort(), ['a', 'c']);
});

test('old-form entries survive the cleanup unchanged and still read as off', () => {
  const old = { x: { lang: 'OFF', at: 10 }, y: { lang: 'JA', at: 11 }, z: { lang: 'KO', on: false, at: 12 } };
  const m = T.setThreadLang(old, 'n', 'VI', true, 20, 500);
  assert.deepEqual(m.x, { lang: 'OFF', at: 10 });
  assert.deepEqual(m.y, { lang: 'JA', at: 11 });
  assert.deepEqual(m.z, { lang: 'KO', on: false, at: 12 });
  assert.equal(get(m, 'x').on, false);
  assert.equal(get(m, 'z').on, false);
});

test('a defensive string "OFF" entry survives the cleanup', () => {
  const m = T.setThreadLang({ s: 'OFF' }, 'n', 'JA', true, 20, 500);
  assert.equal(get(m, 's').on, false);
});
