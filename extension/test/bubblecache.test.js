const test = require('node:test');
const assert = require('node:assert');
const B = require('../lib/bubblecache.js');

test('FIFO cache evicts oldest beyond 200', () => {
  const c = B.createFifoCache();
  for (let i = 0; i < 201; i++) c.set('m' + i, { text: 't' + i });
  assert.equal(c.size(), 200);
  assert.equal(c.has('m0'), false);
  assert.equal(c.has('m1'), true);
  assert.equal(c.get('m200').text, 't200');
});

test('re-setting an existing key does not evict', () => {
  const c = B.createFifoCache(2);
  c.set('a', 1); c.set('b', 2); c.set('a', 3);
  assert.equal(c.size(), 2);
  assert.equal(c.get('a'), 3);
  assert.equal(c.has('b'), true);
});

test('error texts follow spec 7-3', () => {
  assert.equal(B.bubbleErrorText({ code: 'NO_KEY' }), 'DeepL 키를 설정하세요');
  assert.equal(B.bubbleErrorText({ code: 'BAD_KEY' }), 'DeepL 키가 올바르지 않습니다');
  assert.equal(B.bubbleErrorText({ code: 'QUOTA' }), 'DeepL 사용 한도를 초과했습니다');
  assert.equal(B.bubbleErrorText({ code: 'RETRY' }), '잠시 후 다시 시도하세요');
  assert.equal(B.bubbleErrorText({ code: 'REJECTED' }), '잠시 후 다시 시도하세요');
  assert.equal(B.bubbleErrorText({ code: 'X', message: 'm' }), 'm');
  assert.equal(B.bubbleErrorText(undefined), '잠시 후 다시 시도하세요');
});

test('langPair', () => {
  assert.equal(B.langPair('en', 'KO'), 'EN → KO');
  assert.equal(B.langPair(undefined, 'KO'), 'KO');
});
