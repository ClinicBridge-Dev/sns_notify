// bubbles.js(R2~R4 말풍선 도구 모음) 배선 테스트. 가짜 DOM·선택자·util 로 확인한다.
// 최종 검토 5번(금지 사항 9: 로그인·보안 확인 화면에서 멈춤), 7번(mouseover 에서 본문을 읽지 않음).
const test = require('node:test');
const assert = require('node:assert');

global.self = global;
global.MBX = {};
Object.assign(global.MBX, require('../lib/constants.js'), require('../lib/bubblecache.js'));

let env;
function fakeEl(tag) {
  const e = {
    tag, style: {}, className: '', textContent: '', disabled: false, children: [], listeners: {},
    appendChild(c) { this.children.push(c); return c; }, setAttribute() {},
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    get offsetHeight() { return 20; }, get offsetWidth() { return 80; }
  };
  return e;
}
const docListeners = {};
global.document = {
  readyState: 'complete',
  createElement: (t) => fakeEl(t),
  addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); }
};
global.window = { innerWidth: 1000, innerHeight: 800, addEventListener() {} };
global.requestAnimationFrame = (f) => setTimeout(f, 0);
Object.defineProperty(global, 'navigator', { configurable: true, value: { clipboard: { writeText: (t) => { env.copied.push(t); return Promise.resolve(); } } } });

let textReads = 0;
let textElCalls = 0;
const textEl = { get innerText() { textReads++; return 'Hello there'; } };
const bubble = {
  getAttribute: (k) => (k === 'data-message-id' ? 'm1' : null),
  getBoundingClientRect: () => ({ top: 100, bottom: 140, left: 50 }),
  contains: () => false
};
global.MBX.sel = {
  bubbleFrom: () => bubble,
  bubbleHasText: () => true,
  // 실제 bubbleTextEl 은 innerText 를 읽어 내용 있는 요소를 고른다: 호출 자체를 "본문 읽기"로 센다.
  bubbleTextEl: () => { textElCalls++; return textEl; },
  messageRegion: () => ({ querySelectorAll: () => [bubble] }),
  dialogOpen: () => false,
  blockedScreen: () => (env.blocked ? 'login' : null)
};
global.MBX.util = {
  settings: () => ({ bubbleButtonsEnabled: true, bubbleTargetLang: 'KO' }),
  host: () => fakeEl('host'),
  send: (type, p) => { env.sends.push({ type, ...p }); return Promise.resolve({ ok: true, text: '안녕', detectedLang: 'EN' }); },
  onMessage() {}, onInboxChange() {}
};
require('../content/bubbles.js');
const B = global.MBX.bubbles._test;

function reset(o) { env = Object.assign({ blocked: false, sends: [], copied: [] }, o); textReads = 0; textElCalls = 0; B.hide(); }
const over = () => docListeners.mouseover[0]({ target: bubble, composedPath: () => [bubble] });

test('item 7: hovering a bubble shows the bar without reading its text', () => {
  reset();
  over();
  assert.equal(B.ui().bar.style.display, 'flex');
  assert.equal(textReads, 0);
  assert.equal(textElCalls, 0);
});

test('item 7: text is read only on [복사] / [번역] click', async () => {
  reset();
  over();
  await B.onCopy();
  assert.deepEqual(env.copied, ['Hello there']);
  await B.onTranslate();
  assert.equal(env.sends.filter((m) => m.type === 'TRANSLATE').length, 1);
  assert.equal(textReads, 2);
});

test('item 5: on a blocked screen hover shows nothing and the buttons read/translate/copy nothing', async () => {
  reset();
  over(); // 도구 모음이 떠 있는 상태에서 로그인 화면이 뜸
  env.blocked = true;
  over();
  assert.equal(B.ui().bar.style.display, 'none');
  B.setCurBubble(bubble);
  await B.onCopy();
  await B.onTranslate();
  assert.deepEqual(env.copied, []);
  assert.equal(env.sends.length, 0);
  assert.equal(textReads, 0);
  assert.equal(textElCalls, 0);
});
