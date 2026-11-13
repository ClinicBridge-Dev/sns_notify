// bubbles.js(말풍선 액션 줄과 번역 상자, UI 수정 기획서 2·3장) 배선 테스트. test/fakedom.js 의 최소 DOM 위에서
// 실제 selectors.js 와 bubbles.js 를 돌린다. 스크롤 보정과 실제 렌더링은 브라우저에서 확인한다(9장 V6~V8).
const test = require('node:test');
const assert = require('node:assert');
const { install, dispatch, FakeEvent } = require('./fakedom.js');

const { doc } = install(global);
global.self = global;
global.MBX = {};
Object.assign(global.MBX, require('../lib/constants.js'), require('../lib/bubblecache.js'));
Object.defineProperty(global, 'location', { configurable: true, get: () => ({ pathname: '/latest/inbox/all', href: 'https://business.facebook.com/latest/inbox/all?selected_item_id=' + env.thread }) });
Object.assign(global.MBX, require('../content/selectors.js'), require('../content/inject.js'));
Object.defineProperty(global, 'navigator', { configurable: true, value: { clipboard: { writeText: (t) => { env.copied.push(t); return Promise.resolve(); } } } });

let env;
global.MBX.sel.blockedScreen = () => (env.blocked ? 'login' : null);
global.MBX.sel.dialogOpen = () => false;
global.MBX.util = {
  settings: () => env.settings,
  send: (type, p) => { env.sends.push(Object.assign({ type }, p)); return Promise.resolve(type === 'TRANSLATE' ? env.reply(p) : { ok: true }); },
  toast: (t) => env.toasts.push(t),
  host: () => doc.body,
  onMessage(type, fn) { handlers[type] = fn; },
  onInboxChange() {}
};
global.MBX.composer = { notify: (t, kind) => env.notices.push([t, kind]) };
const handlers = {};
require('../content/bubbles.js');
const B = global.MBX.bubbles._test;

// ---- 화면 만들기 ----
let region;
function bubble(id, text, out) {
  const wrap = doc.createElement('div');
  wrap.computed = { flexDirection: 'column', alignItems: out ? 'flex-end' : 'flex-start' };
  const b = doc.createElement('div');
  b.setAttribute('data-message-id', id);
  if (text === null) {
    b.appendChild(doc.createElement('img'));
  } else {
    const t = doc.createElement('div');
    t.setAttribute('dir', 'auto');
    t.appendChild(doc.createTextNode(text));
    b.appendChild(t);
  }
  wrap.appendChild(b);
  region.appendChild(wrap);
  return b;
}
function screen() {
  doc.body.textContent = '';
  region = doc.createElement('div');
  region.setAttribute('role', 'region');
  Object.assign(region, { scrollTop: 0, scrollHeight: 400, clientHeight: 400 });
  doc.body.appendChild(region);
  bubble('m1', 'Hello there', false);
  bubble('m2', '日本語です', false);
  bubble('m3', null, false); // 사진
  bubble('m4', 'Thanks!', true);
}
function reset(o) {
  env = Object.assign({
    thread: 't1', blocked: false, sends: [], copied: [], toasts: [], notices: [], handlers,
    settings: { bubbleButtonsEnabled: true, bubbleTargetLang: 'KO' },
    reply: () => ({ ok: true, text: '안녕하세요', detectedLang: 'EN' })
  }, o);
  env.handlers = handlers;
  B.resetState();
  screen();
  doc.textReads.length = 0;
}
const hosts = () => doc.querySelectorAll('[data-mbx="actions"]');
const hostOf = (id) => hosts().find((h) => h.getAttribute('data-mbx-id') === id);
const btn = (id, act) => hostOf(id).shadowRoot.querySelector('[data-act="' + act + '"]');
const box = (id) => hostOf(id).shadowRoot.querySelector('.mbx-tbox');
const flush = () => new Promise((r) => setTimeout(r, 5));
async function press(id, act) { btn(id, act).click(); await flush(); }
const translates = () => env.sends.filter((m) => m.type === 'TRANSLATE');

test('an action row goes right after every text bubble (received and sent), not after photos', () => {
  reset();
  B.scan();
  assert.deepEqual(hosts().map((h) => h.getAttribute('data-mbx-id')), ['m1', 'm2', 'm4']);
  hosts().forEach((h) => {
    assert.equal(h.previousElementSibling.getAttribute('data-message-id'), h.getAttribute('data-mbx-id'));
    assert.equal(h.parentNode.lastElementChild, h);
    assert.ok(h.shadowRoot, 'inside a shadow root');
  });
  assert.equal(btn('m1', 'toggle').textContent, '번역 보기');
  assert.ok(btn('m1', 'copy-src'));
  assert.equal(btn('m1', 'copy-tr'), null);
});

test('scanning does not read any bubble text, and scanning again does not duplicate rows', () => {
  reset();
  B.scan(); B.scan();
  assert.equal(hosts().length, 3);
  assert.equal(doc.textReads.length, 0);
});

test('translate reads only the pressed bubble, shows the box with names and a translation copy button', async () => {
  reset();
  B.scan();
  await press('m1', 'toggle');
  assert.deepEqual(translates().map((m) => [m.text, m.targetLang, m.purpose]), [['Hello there', 'KO', 'bubble']]);
  const m1Text = doc.querySelector('[data-message-id="m1"]').querySelector('[dir="auto"]');
  assert.ok(doc.textReads.length >= 1);
  assert.ok(doc.textReads.every((n) => n === m1Text), 'only the pressed bubble is read');
  assert.equal(box('m1').textContent, '안녕하세요');
  assert.equal(hostOf('m1').shadowRoot.querySelector('.mbx-lang').textContent, '영어 → 한국어');
  assert.equal(btn('m1', 'toggle').textContent, '번역 숨기기');
  assert.ok(btn('m1', 'copy-tr'));
  assert.equal(box('m2'), null);
});

test('hiding and showing again uses the cache, not DeepL', async () => {
  reset();
  B.scan();
  await press('m1', 'toggle');
  await press('m1', 'toggle');
  assert.equal(box('m1'), null);
  await press('m1', 'toggle');
  assert.equal(translates().length, 1);
  assert.equal(box('m1').textContent, '안녕하세요');
});

test('changing the result language makes the next open call DeepL again', async () => {
  reset();
  B.scan();
  await press('m1', 'toggle');
  await press('m1', 'toggle');
  env.settings = { bubbleButtonsEnabled: true, bubbleTargetLang: 'JA' };
  env.handlers.SETTINGS_CHANGED({});
  B.scan();
  await press('m1', 'toggle');
  assert.deepEqual(translates().map((m) => m.targetLang), ['KO', 'JA']);
});

test('after Meta redraws a bubble, its open translation is restored by message id', async () => {
  reset();
  B.scan();
  await press('m1', 'toggle');
  const old = doc.querySelector('[data-message-id="m1"]');
  const wrap = old.parentNode;
  wrap.textContent = ''; // Meta가 말풍선과 함께 넣은 요소를 지움
  const again = doc.createElement('div');
  again.setAttribute('data-message-id', 'm1');
  const t = doc.createElement('div'); t.setAttribute('dir', 'auto'); t.appendChild(doc.createTextNode('Hello there'));
  again.appendChild(t);
  wrap.appendChild(again);
  B.scan();
  assert.equal(box('m1').textContent, '안녕하세요');
  assert.equal(translates().length, 1);
});

test('a row whose bubble disappeared is removed', () => {
  reset();
  B.scan();
  const b = doc.querySelector('[data-message-id="m2"]');
  b.parentNode.removeChild(b);
  B.scan();
  assert.deepEqual(hosts().map((h) => h.getAttribute('data-mbx-id')), ['m1', 'm4']);
});

test('on a login/security screen every row is removed and none are added', () => {
  reset();
  B.scan();
  env.blocked = true;
  B.scan();
  assert.equal(hosts().length, 0);
  B.scan();
  assert.equal(hosts().length, 0);
});

test('turning the feature off in settings removes every row', () => {
  reset();
  B.scan();
  env.settings = { bubbleButtonsEnabled: false, bubbleTargetLang: 'KO' };
  env.handlers.SETTINGS_CHANGED({});
  assert.equal(hosts().length, 0);
  B.scan();
  assert.equal(hosts().length, 0);
});

test('same detected and result language shows a note instead of a translation', async () => {
  reset({ reply: () => ({ ok: true, text: 'x', detectedLang: 'KO' }) });
  B.scan();
  await press('m1', 'toggle');
  assert.equal(box('m1').textContent, '이미 한국어입니다');
  assert.ok(box('m1').classList.contains('mbx-note'));
  assert.equal(btn('m1', 'copy-tr'), null);
  reset({ settings: { bubbleButtonsEnabled: true, bubbleTargetLang: 'EN-US' }, reply: () => ({ ok: true, text: 'x', detectedLang: 'EN' }) });
  B.scan();
  await press('m1', 'toggle');
  assert.equal(box('m1').textContent, '이미 영어 (미국)입니다');
});

test('errors show in the box with retry; NO_KEY and PERMISSION_OFF open the right settings menu', async () => {
  let n = 0;
  reset({ reply: () => (n++ === 0 ? { ok: false, code: 'RETRY', message: '잠시 후 다시 시도하세요' } : { ok: true, text: '안녕', detectedLang: 'EN' }) });
  B.scan();
  await press('m1', 'toggle');
  assert.ok(box('m1').classList.contains('mbx-err'));
  assert.match(box('m1').textContent, /잠시 후 다시 시도하세요/);
  await press('m1', 'retry');
  assert.equal(box('m1').textContent, '안녕');
  assert.equal(translates().length, 2);

  reset({ reply: () => ({ ok: false, code: 'NO_KEY', message: 'DeepL 키를 설정하세요' }) });
  B.scan();
  await press('m1', 'toggle');
  await press('m1', 'open-settings');
  assert.deepEqual(env.sends.filter((m) => m.type === 'OPEN_OPTIONS').map((m) => m.section), ['translate']);

  reset({ reply: () => ({ ok: false, code: 'PERMISSION_OFF', message: '확장 프로그램의 사이트 액세스 권한이 꺼져 있습니다' }) });
  B.scan();
  await press('m1', 'toggle');
  assert.match(box('m1').textContent, /확장 프로그램의 사이트 액세스 권한이 꺼져 있습니다/);
  await press('m1', 'open-settings');
  assert.deepEqual(env.sends.filter((m) => m.type === 'OPEN_OPTIONS').map((m) => m.section), ['start']);
});

test('copy buttons copy the original and the translation, and show 복사됨', async () => {
  reset();
  B.scan();
  await press('m1', 'copy-src');
  assert.deepEqual(env.copied, ['Hello there']);
  assert.equal(btn('m1', 'copy-src').textContent, '복사됨');
  await press('m1', 'toggle');
  await press('m1', 'copy-tr');
  assert.deepEqual(env.copied, ['Hello there', '안녕하세요']);
});

test('events inside a row do not reach Meta; buttons keep focus, the box keeps text selection', () => {
  reset();
  B.scan();
  const seen = [];
  ['click', 'mousedown', 'pointerdown', 'keydown', 'contextmenu'].forEach((t) => region.addEventListener(t, () => seen.push(t)));
  const md = new FakeEvent('mousedown');
  dispatch(btn('m1', 'toggle'), md);
  assert.equal(md.defaultPrevented, true);
  ['click', 'pointerdown', 'keydown', 'contextmenu'].forEach((t) => dispatch(btn('m1', 'copy-src'), new FakeEvent(t)));
  assert.deepEqual(seen, []);
});

test('the box itself does not prevent mousedown (text can be selected)', async () => {
  reset();
  B.scan();
  await press('m1', 'toggle');
  const md = new FakeEvent('mousedown');
  dispatch(box('m1'), md);
  assert.equal(md.defaultPrevented, false);
});

test('when no row can be placed in a conversation with text bubbles, the toolbar notice is shown once', () => {
  reset();
  doc.querySelectorAll('[data-message-id]').forEach((b) => { b.parentNode.insertBefore = () => { throw new Error('no'); }; b.parentNode.appendChild = b.parentNode.insertBefore; });
  B.scan(); B.scan();
  assert.deepEqual(env.notices, [['말풍선 버튼을 표시하지 못했습니다', 'error']]);
});

test('an open row with neither a result nor an error is drawn closed', async () => {
  reset();
  B.scan();
  await press('m1', 'toggle');
  global.MBX.bubbles._cache._clear();
  env.handlers.SETTINGS_CHANGED({});
  assert.equal(btn('m1', 'toggle').textContent, '번역 보기');
  assert.equal(box('m1'), null);
});
