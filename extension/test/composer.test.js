const test = require('node:test');
const assert = require('node:assert');
// composer.js 는 브라우저 전용이라 순수 판단 함수만 node 에서 꺼내 쓴다.
global.self = global;
global.MBX = {};
require('../lib/constants.js');
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
