const test = require('node:test');
const assert = require('node:assert');
const D = require('../lib/deepl.js');

test('free keys go to api-free, others to api', () => {
  assert.equal(D.deeplBase('abc:fx'), 'https://api-free.deepl.com');
  assert.equal(D.deeplBase('abc'), 'https://api.deepl.com');
});

test('bubble request has no source_lang', () => {
  const { url, init } = D.buildTranslateRequest({ text: 'Hello', targetLang: 'KO', purpose: 'bubble' }, 'k:fx');
  assert.equal(url, 'https://api-free.deepl.com/v2/translate');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'DeepL-Auth-Key k:fx');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { text: ['Hello'], target_lang: 'KO' });
});

test('send request pins source_lang to KO', () => {
  const { init } = D.buildTranslateRequest({ text: '안녕하세요', targetLang: 'EN-US', purpose: 'send' }, 'k');
  assert.deepEqual(JSON.parse(init.body), { text: ['안녕하세요'], target_lang: 'EN-US', source_lang: 'KO' });
});

test('error mapping', () => {
  assert.equal(D.mapDeeplError(403).code, 'BAD_KEY');
  assert.equal(D.mapDeeplError(456).code, 'QUOTA');
  for (const s of [429, 500, 503, 0]) assert.equal(D.mapDeeplError(s).code, 'RETRY');
});

test('error messages follow spec 7-3', () => {
  assert.equal(D.mapDeeplError(403).message, 'DeepL 키가 올바르지 않습니다');
  assert.equal(D.mapDeeplError(456).message, 'DeepL 사용 한도를 초과했습니다');
  assert.equal(D.mapDeeplError(0).message, '잠시 후 다시 시도하세요');
  assert.equal(D.NO_KEY.code, 'NO_KEY');
  assert.equal(D.NO_KEY.message, 'DeepL 키를 설정하세요');
});

test('usage request hits /v2/usage with auth header', () => {
  const { url, init } = D.buildUsageRequest('k:fx');
  assert.equal(url, 'https://api-free.deepl.com/v2/usage');
  assert.equal(init.method, 'GET');
  assert.equal(init.headers.Authorization, 'DeepL-Auth-Key k:fx');
});
