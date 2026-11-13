// 입력창 위 도구 막대와 빠른 메시지 목록 창(UI 수정 기획서 4·5장) 배선 테스트. test/fakedom.js 위에서 실제 composer.js 를 돌린다.
// 화면 배치(폭, 잘림, 스크롤)는 브라우저에서 확인한다(9장 V5, V9, V10).
const test = require('node:test');
const assert = require('node:assert');
const { install, dispatch, FakeEvent } = require('./fakedom.js');

const { doc, win } = install(global);
global.self = global;
global.MBX = {};
Object.assign(global.MBX, require('../lib/constants.js'), require('../lib/sendgate.js'));
Object.defineProperty(global, 'location', { configurable: true, get: () => ({ pathname: '/latest/inbox/all', href: 'https://business.facebook.com/latest/inbox/all?asset_id=1' + (env.thread ? '&selected_item_id=' + env.thread : '') }) });
Object.assign(global.MBX, require('../content/selectors.js'), require('../content/inject.js'));
global.MBX.sel.blockedScreen = () => (env.blocked ? 'login' : null);
global.MBX.sel.dialogOpen = () => env.dialog;
global.DataTransfer = class { constructor() { this.d = {}; } setData(k, v) { this.d[k] = v; } getData(k) { return this.d[k]; } };
global.ClipboardEvent = class extends FakeEvent { constructor(t, i) { super(t, i); } };
global.KeyboardEvent = FakeEvent;
doc.getSelection = () => ({ rangeCount: 0, removeAllRanges() {}, addRange() {}, anchorNode: null });
doc.createRange = () => ({ selectNodeContents() {}, collapse() {} });
doc.execCommand = () => false;

let env = { thread: null, blocked: false, dialog: false, sends: [], toasts: [], settings: null, quick: [] };
const rootHost = doc.createElement('mbx-root');
rootHost.attachShadow({ mode: 'open' });
global.MBX.util = {
  send(type, p) {
    env.sends.push(Object.assign({ type }, p));
    if (type === 'GET_THREAD_LANG') return env.langReply ? Promise.resolve(Object.assign({ threadId: p.threadId }, env.langReply)) : new Promise(() => {});
    if (type === 'GET_QUICK_REPLIES') return Promise.resolve({ version: 1, items: env.quick });
    return Promise.resolve({ ok: true });
  },
  connected: () => true, alive: () => true,
  settings: () => env.settings,
  toast: (t) => env.toasts.push(t),
  host: () => rootHost.shadowRoot,
  onMessage(type, fn) { handlers[type] = fn; }, onInboxChange() {}
};
const handlers = {};
require('../content/composer.js');
const U = global.MBX.composer._ui;
const G = global.MBX.composer._gate;

let panel, region, area, composer;
function screen() {
  doc.body.textContent = '';
  panel = doc.createElement('div');
  const head = doc.createElement('div');
  region = doc.createElement('div'); region.setAttribute('role', 'region');
  const m = doc.createElement('div'); m.setAttribute('data-message-id', 'm1'); region.appendChild(m);
  Object.assign(region, { scrollTop: 0, scrollHeight: 400, clientHeight: 400 });
  area = doc.createElement('div');
  const inner = doc.createElement('div');
  composer = doc.createElement('div');
  composer.setAttribute('role', 'textbox'); composer.setAttribute('contenteditable', 'true'); composer.setAttribute('data-lexical-editor', 'true');
  inner.appendChild(composer); area.appendChild(inner);
  panel.appendChild(head); panel.appendChild(region); panel.appendChild(area);
  doc.body.appendChild(panel);
}
function reset(o) {
  env = Object.assign({
    thread: 't1', blocked: false, dialog: false, sends: [], toasts: [], pastes: [],
    settings: { sendTranslateEnabled: true, quickRepliesEnabled: true, sendTargetLang: 'EN-US' },
    langReply: { lang: 'JA', on: true },
    quick: [
      { id: 'a', title: '예약 양식', text: '예약을 위해 아래 정보를 보내 주세요', tags: ['예약'] },
      { id: 'b', title: '위치 안내', text: '홍대입구역 3번 출구', tags: ['안내'] }
    ]
  }, o);
  screen();
  composer.addEventListener('paste', (e) => env.pastes.push(e.clipboardData.getData('text/plain')));
  U.reset();
}
const flush = () => new Promise((r) => setTimeout(r, 5));
const bars = () => doc.querySelectorAll('[data-mbx="toolbar"]');
const q = (s) => bars()[0].shadowRoot.querySelector(s);
const popQ = (s) => (bars()[0].shadowRoot.querySelector(s) || rootHost.shadowRoot.querySelector(s));
async function ready(o) { reset(o); U.tick(); await flush(); U.tick(); }

test('one toolbar goes right before the composer area, inside the panel, and is not duplicated', async () => {
  await ready();
  assert.equal(bars().length, 1);
  assert.equal(bars()[0].parentNode, panel);
  assert.equal(bars()[0].nextElementSibling, area);
  U.tick(); U.tick();
  assert.equal(bars().length, 1);
  env.thread = 't2'; U.tick(); await flush(); U.tick();
  assert.equal(bars().length, 1);
});

test('no toolbar without a composer, and it is removed on a login/security screen', async () => {
  await ready();
  composer.parentNode.removeChild(composer);
  U.tick();
  assert.equal(bars().length, 0);
  await ready();
  env.blocked = true; U.tick();
  assert.equal(bars().length, 0);
});

test('states: loading, on, off, busy', async () => {
  reset({ langReply: null });
  U.tick();
  assert.equal(q('[data-part="state"]').textContent, '번역 …');
  assert.equal(q('[role="switch"]').disabled, true);
  assert.equal(q('[data-part="lang"]').disabled, true);
  G.setLang('t1', { lang: 'JA', on: true }); U.tick();
  assert.equal(q('[data-part="state"]').textContent, '번역 ON');
  assert.equal(q('[data-part="langname"]').textContent, '일본어');
  assert.equal(q('[role="switch"]').getAttribute('aria-checked'), 'true');
  G.setLang('t1', { lang: 'JA', on: false }); U.tick();
  assert.equal(q('[data-part="state"]').textContent, '번역 OFF');
  assert.equal(q('[role="switch"]').getAttribute('aria-checked'), 'false');
  assert.equal(q('[data-part="langname"]').textContent, '일본어');
});

test('the switch saves on/off with the same language in one request', async () => {
  await ready();
  q('[role="switch"]').click();
  assert.deepEqual(env.sends.filter((m) => m.type === 'SET_THREAD_LANG').map((m) => [m.lang, m.on]), [['JA', false]]);
  assert.equal(q('[data-part="state"]').textContent, '번역 OFF');
  q('[role="switch"]').click();
  assert.deepEqual(env.sends.filter((m) => m.type === 'SET_THREAD_LANG').map((m) => [m.lang, m.on]), [['JA', false], ['JA', true]]);
});

test('the language list has names with codes, no "끔" item, and picking turns translation back on', async () => {
  await ready({ langReply: { lang: 'JA', on: false } });
  q('[data-part="lang"]').click();
  const items = popQ('[data-part="langlist"]').querySelectorAll('[role="option"]');
  assert.equal(items.length, global.MBX.SEND_LANGS.length);
  assert.ok(items.every((li) => !/끔/.test(li.textContent)));
  const vi = items.find((li) => li.getAttribute('data-code') === 'VI');
  assert.match(vi.textContent, /베트남어/); assert.match(vi.textContent, /VI/);
  vi.click();
  assert.deepEqual(env.sends.filter((m) => m.type === 'SET_THREAD_LANG').map((m) => [m.lang, m.on]), [['VI', true]]);
  assert.equal(q('[data-part="state"]').textContent, '번역 ON');
  assert.equal(popQ('[data-part="langpop"]').hidden, true);
});

test('settings hide the translate controls and the quick button', async () => {
  await ready({ settings: { sendTranslateEnabled: false, quickRepliesEnabled: false } });
  assert.equal(q('[data-part="tctl"]').hidden, true);
  assert.equal(q('[data-part="quick"]').hidden, true);
  env.settings = { sendTranslateEnabled: true, quickRepliesEnabled: true };
  handlers.SETTINGS_CHANGED({});
  assert.equal(q('[data-part="tctl"]').hidden, false);
  assert.equal(q('[data-part="quick"]').hidden, false);
});

test('quick messages: open, search, arrow + Enter inserts at the cursor without sending', async () => {
  await ready();
  q('[data-part="quick"]').click();
  await flush();
  assert.equal(q('[data-part="quick"]').getAttribute('aria-expanded'), 'true');
  const search = popQ('[data-part="qsearch"]');
  assert.equal(doc.activeElement, search);
  search.value = '안내';
  dispatch(search, new FakeEvent('input'));
  const items = popQ('[data-part="qlist"]').querySelectorAll('[role="option"]');
  assert.equal(items.length, 1);
  dispatch(search, new FakeEvent('keydown', { key: 'Enter' }));
  await flush();
  assert.deepEqual(env.pastes, ['홍대입구역 3번 출구']);
  assert.equal(popQ('[data-part="qpop"]').hidden, true);
  assert.equal(env.sends.filter((m) => m.type === 'TRANSLATE').length, 0);
});

test('quick messages: arrows move the selection and Esc closes', async () => {
  await ready();
  q('[data-part="quick"]').click();
  await flush();
  const search = popQ('[data-part="qsearch"]');
  dispatch(search, new FakeEvent('keydown', { key: 'ArrowDown' }));
  const sel = popQ('[data-part="qlist"]').querySelectorAll('[role="option"]').map((li) => li.getAttribute('aria-selected'));
  assert.deepEqual(sel, ['false', 'true']);
  dispatch(search, new FakeEvent('keydown', { key: 'Escape' }));
  assert.equal(popQ('[data-part="qpop"]').hidden, true);
});

test('quick messages: empty list offers settings; links open the quick menu', async () => {
  await ready({ quick: [] });
  q('[data-part="quick"]').click();
  await flush();
  const list = popQ('[data-part="qlist"]');
  assert.match(list.textContent, /저장된 빠른 메시지가 없습니다/);
  list.querySelector('button').click();
  assert.deepEqual(env.sends.filter((m) => m.type === 'OPEN_OPTIONS').map((m) => m.section), ['quick']);
  await ready();
  q('[data-part="quick"]').click();
  await flush();
  popQ('[data-part="qmanage"]').click();
  assert.deepEqual(env.sends.filter((m) => m.type === 'OPEN_OPTIONS').map((m) => m.section), ['quick']);
});

test('a Meta dialog closes the popups but keeps the toolbar', async () => {
  await ready();
  q('[data-part="quick"]').click();
  await flush();
  env.dialog = true; U.tick();
  assert.equal(bars().length, 1);
  assert.equal(popQ('[data-part="qpop"]').hidden, true);
});

test('notices go to the line above the toolbar when it exists, otherwise to a toast; errors win over the sent original', async () => {
  await ready();
  global.MBX.composer.notify('보낸 원문: 안녕', 'sent');
  assert.equal(q('[data-part="aux"]').hidden, false);
  assert.equal(q('[data-part="auxtext"]').textContent, '보낸 원문: 안녕');
  global.MBX.composer.notify('번역 실패', 'error');
  assert.equal(q('[data-part="auxtext"]').textContent, '번역 실패');
  assert.ok(q('[data-part="aux"]').classList.contains('mbx-err'));
  global.MBX.composer.notify('보낸 원문: 다음', 'sent');
  assert.equal(q('[data-part="auxtext"]').textContent, '번역 실패');
  dispatch(composer, new FakeEvent('input'));
  assert.equal(q('[data-part="aux"]').hidden, true);
  assert.deepEqual(env.toasts, []);
  composer.parentNode.removeChild(composer); U.tick();
  global.MBX.composer.notify('막대 없음', 'error');
  assert.deepEqual(env.toasts, ['막대 없음']);
});

test('the toolbar counts as missing only after 5 seconds without it on a conversation with a composer', async () => {
  await ready();
  const t0 = Date.now();
  bars()[0].insertAttempt = null;
  U.blockInsert(true);
  bars()[0].remove();
  U.checkToolbar(t0);
  assert.equal(U.toolbarMissing(), false);
  U.checkToolbar(t0 + 5001);
  assert.equal(U.toolbarMissing(), true);
  U.blockInsert(false);
  U.tick();
  assert.equal(U.toolbarMissing(), false);
});

test('events inside the toolbar do not reach Meta; buttons keep composer focus, the search box does not', async () => {
  await ready();
  const seen = [];
  ['click', 'mousedown', 'keydown', 'pointerdown'].forEach((t) => panel.addEventListener(t, () => seen.push(t)));
  const md = new FakeEvent('mousedown');
  dispatch(q('[data-part="quick"]'), md);
  assert.equal(md.defaultPrevented, true);
  q('[data-part="quick"]').click();
  await flush();
  const md2 = new FakeEvent('mousedown');
  dispatch(popQ('[data-part="qsearch"]'), md2);
  assert.equal(md2.defaultPrevented, false);
  dispatch(q('[role="switch"]'), new FakeEvent('keydown', { key: 'Enter' }));
  assert.deepEqual(seen, []);
});

test('on a login/security screen a notice goes to a toast even while the toolbar is still attached', async () => {
  await ready();
  env.blocked = true;
  global.MBX.composer.notify('로그인/보안 확인 화면이 떠 있어 번역 전송을 멈췄습니다. 전송하지 않았습니다', 'error');
  assert.equal(env.toasts.length, 1);
});

test('popups shield their own events (they may be moved under mbx-root)', async () => {
  await ready();
  q('[data-part="quick"]').click();
  await flush();
  const pop = popQ('[data-part="qpop"]');
  const seen = [];
  const outer = doc.createElement('div');
  doc.body.appendChild(outer);
  outer.appendChild(pop); // mbx-root 로 옮겨진 경우를 흉내 낸다
  outer.addEventListener('keydown', () => seen.push('keydown'));
  dispatch(popQ('[data-part="qsearch"]') || pop.querySelector('[data-part="qsearch"]'), new FakeEvent('keydown', { key: 'a' }));
  assert.deepEqual(seen, []);
});
