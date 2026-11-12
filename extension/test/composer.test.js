const test = require('node:test');
const assert = require('node:assert');
// composer.js 는 브라우저 전용이라 순수 판단 함수만 node 에서 꺼내 쓴다.
global.self = global;
global.MBX = {};
require('../lib/constants.js');
Object.assign(global.MBX, require('../lib/sendgate.js'));
require('../content/composer.js');
const C = global.MBX.composer;

test('late paste (reflected after 500ms) is detected before the fallback -> no second insert', () => {
  // before0 = 'hi', paste landed late: now contains the text
  assert.equal(C._decideFallback(false, 'hi', 'hi hello', 'hello'), 'done');
});

test('replaceAll late reflection is also detected', () => {
  assert.equal(C._decideFallback(true, '한글', 'hello', 'hello'), 'done');
});

test('neither reflected -> fallback runs', () => {
  assert.equal(C._decideFallback(false, 'hi', 'hi', 'hello'), 'next');
  assert.equal(C._decideFallback(true, '한글', '한글', 'hello'), 'next');
});

test('insert mode: text that was already present before does not count as reflected', () => {
  assert.equal(C._isReflected(false, 'hello', 'hello', 'hello'), false);
});

test('composer compares through sendgate.normalizeForCompare (single implementation)', () => {
  assert.equal(C._normalize, undefined); // 중복 구현을 두지 않는다
  // 줄바꿈·연속 공백·이모지가 있는 번역문이 입력창에서 다르게 보여도 반영된 것으로 본다(Review Focus 4).
  const want = global.MBX.normalizeForCompare('Hello,  world 😀\n\nSecond');
  assert.equal(C._isReflected(true, '안녕', global.MBX.normalizeForCompare('Hello, world 😀\r\nSecond '), want), true);
});
