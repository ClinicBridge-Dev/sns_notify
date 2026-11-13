const test = require('node:test');
const assert = require('node:assert');
const G = require('../lib/sendgate.js');
const ctx = (o = {}) => ({ text: '안녕하세요', bypass: false, busy: false, connected: true, settingsLoaded: true, langLoaded: true, enabled: true, lang: 'EN-US', on: true, toolbar: true, lastTranslated: null, ...o });

test('hasHangul covers syllables and bare jamo', () => {
  for (const s of ['가', 'ㅋㅋ', 'ㅏ', 'ok 네']) assert.equal(G.hasHangul(s), true);
  for (const s of ['hello', '日本語', '😀', '']) assert.equal(G.hasHangul(s), false);
});

test('Korean text with everything ready is intercepted', () => {
  assert.equal(G.decideSend(ctx()), 'intercept');
});

test('the continuation send the extension itself fires passes through', () => {
  assert.equal(G.decideSend(ctx({ bypass: true, busy: true })), 'pass');
});

test('a second Enter while translating is swallowed, never passed to Meta', () => {
  assert.equal(G.decideSend(ctx({ busy: true })), 'swallow');
  assert.equal(G.decideSend(ctx({ busy: true, text: 'hello' })), 'swallow');
});

test('text without Hangul always passes, even before settings arrive', () => {
  assert.equal(G.decideSend(ctx({ text: 'hello', settingsLoaded: false, langLoaded: false, connected: false })), 'pass');
});

test('Korean text is blocked until settings and the thread language arrive', () => {
  assert.equal(G.decideSend(ctx({ settingsLoaded: false })), 'block_loading');
  assert.equal(G.decideSend(ctx({ langLoaded: false })), 'block_loading');
});

test('Korean text passes untranslated when translation is off', () => {
  assert.equal(G.decideSend(ctx({ enabled: false })), 'pass');
  assert.equal(G.decideSend(ctx({ on: false })), 'pass');
});

test('the thread switch is read from on, not from the language value', () => {
  assert.equal(G.decideSend(ctx({ lang: 'OFF', on: true })), 'intercept');
  assert.equal(G.decideSend(ctx({ lang: 'JA', on: false })), 'pass');
});

test('Korean text is blocked when the toolbar could not be shown', () => {
  assert.equal(G.decideSend(ctx({ toolbar: false })), 'block_no_toolbar');
});

test('without the toolbar, non-Korean text, translation off and this thread off still pass', () => {
  assert.equal(G.decideSend(ctx({ toolbar: false, text: 'hello' })), 'pass');
  assert.equal(G.decideSend(ctx({ toolbar: false, enabled: false })), 'pass');
  assert.equal(G.decideSend(ctx({ toolbar: false, on: false })), 'pass');
});

test('order: missing toolbar is checked after this-thread-off and before the repeated translation', () => {
  assert.equal(G.decideSend(ctx({ toolbar: false, langLoaded: false })), 'block_loading');
  assert.equal(G.decideSend(ctx({ toolbar: false, text: 'Visit 강남', lastTranslated: 'Visit 강남' })), 'block_no_toolbar');
  assert.equal(G.decideSend(ctx({ toolbar: false, connected: false })), 'block_no_toolbar');
});

test('Korean text is blocked when the extension context is gone and translation is on', () => {
  assert.equal(G.decideSend(ctx({ connected: false })), 'block_disconnected');
});

test('unchanged translation result with leftover Hangul passes on the second press', () => {
  assert.equal(G.decideSend(ctx({ text: 'Visit 강남 clinic', lastTranslated: 'Visit 강남 clinic' })), 'pass');
  assert.equal(G.decideSend(ctx({ text: 'Visit 강남 clinic!', lastTranslated: 'Visit 강남 clinic' })), 'intercept');
});

test('key helpers', () => {
  assert.equal(G.isEnterKey({ key: 'Enter', code: 'Enter' }), true);
  assert.equal(G.isEnterKey({ key: 'Process', code: 'Enter' }), true);
  assert.equal(G.isEnterKey({ key: 'Process', code: 'NumpadEnter' }), true);
  assert.equal(G.isEnterKey({ key: 'a', code: 'KeyA' }), false);
  assert.equal(G.hasModifier({ shiftKey: true }), true);
  assert.equal(G.hasModifier({}), false);
  assert.equal(G.isComposingEvent({ isComposing: true }), true);
  assert.equal(G.isComposingEvent({ keyCode: 229 }), true);
  assert.equal(G.isComposingEvent({ keyCode: 13 }), false);
});

test('normalizeForCompare ignores whitespace differences but not content', () => {
  const a = 'Hello,  world 😀\r\n\r\nSecond line here ';
  const b = 'Hello, world 😀\nSecond line here';
  assert.equal(G.normalizeForCompare(a), G.normalizeForCompare(b));
  assert.notEqual(G.normalizeForCompare('Hello world'), G.normalizeForCompare('Hello  word'));
});

// 아래는 brief 밖의 보강 테스트다.
test('normalizeForCompare: nbsp, zero-width space and BOM do not matter; emoji ZWJ sequences are kept', () => {
  assert.equal(G.normalizeForCompare('a b​﻿'), G.normalizeForCompare('a b'));
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  assert.equal(G.normalizeForCompare(' ' + family + '\n'), family);
  assert.equal(G.normalizeForCompare(null), '');
});

test('order: bypass beats everything, busy beats missing settings and disconnection', () => {
  assert.equal(G.decideSend(ctx({ bypass: true, connected: false, settingsLoaded: false })), 'pass');
  assert.equal(G.decideSend(ctx({ busy: true, connected: false, settingsLoaded: false })), 'swallow');
  // 번역이 꺼져 있으면 연결이 끊겨도 한글 원문을 Meta에 맡긴다(⑤가 ⑨보다 먼저).
  assert.equal(G.decideSend(ctx({ enabled: false, connected: false, langLoaded: false })), 'pass');
  assert.equal(G.decideSend(ctx({ on: false, connected: false })), 'pass');
  // 설정이 없으면 enabled 값과 관계없이 막는다(④가 ⑤보다 먼저).
  assert.equal(G.decideSend(ctx({ settingsLoaded: false, enabled: false })), 'block_loading');
});
