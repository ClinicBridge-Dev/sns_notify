// UI 수정 기획서 3-4 언어 이름표.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/constants.js');

test('known codes get Korean names, regardless of case', () => {
  assert.equal(C.langName('JA'), '일본어');
  assert.equal(C.langName('ko'), '한국어');
  assert.equal(C.langName('EN'), '영어');
  assert.equal(C.langName('ZH-HANT'), '중국어 (번체)');
});

test('every send language and every DeepL source language in the list has a name', () => {
  C.SEND_LANGS.forEach(([code]) => assert.notEqual(C.langName(code), code, code));
  ['KO', 'JA', 'EN', 'ZH', 'ES', 'FR', 'DE', 'RU', 'VI', 'TH', 'ID', 'AR', 'PT', 'IT', 'NL', 'PL', 'TR', 'UK'].forEach((c) => assert.notEqual(C.langName(c), c, c));
});

test('unknown codes are shown as the code itself', () => {
  assert.equal(C.langName('XX'), 'XX');
  assert.equal(C.langName(''), '');
  assert.equal(C.langName(undefined), '');
});

test('sameLanguage compares the base part of the code', () => {
  assert.equal(C.sameLanguage('EN', 'EN-US'), true);
  assert.equal(C.sameLanguage('en-gb', 'EN'), true);
  assert.equal(C.sameLanguage('PT-BR', 'PT'), true);
  assert.equal(C.sameLanguage('JA', 'KO'), false);
  assert.equal(C.sameLanguage('', 'KO'), false);
});
