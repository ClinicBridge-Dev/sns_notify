// R5 전송 가로채기 배선(composer.js)을 가짜 입력창·선택자·util로 확인한다. 브라우저 동작(U6, U7, U9)은 수동 확인 대상이다.
const test = require('node:test');
const assert = require('node:assert');

global.self = global;
global.MBX = {};
Object.assign(global.MBX, require('../lib/constants.js'), require('../lib/sendgate.js'));

let env;
const el = {
  nodeType: 1,
  get innerText() { return env.text; },
  contains(n) { return n === el; },
  focus() {},
  dispatchEvent(ev) {
    if (ev.type === 'paste') env.onPaste(ev.clipboardData.getData('text/plain'));
    if (ev.type === 'keydown') { env.syntheticKeys.push(ev); C._gate.onKeyEvent(ev); if (!ev.prevented && env.enterSends) env.text = ''; }
    return true;
  }
};
const btn = { click() { env.clicks++; if (env.emptyOnClick) env.text = ''; } };
const other = { nodeType: 1 };

global.MBX.sel = {
  composer: () => (env.hasComposer ? el : null),
  submitButton: () => (env.hasButton ? btn : null),
  isSubmitButton: (t) => t === btn,
  threadIdFrom: () => env.thread,
  channelFromPath: (p) => (p.indexOf('/latest/inbox') === 0 ? 'all' : null),
  dialogOpen: () => false
};
global.MBX.util = {
  send(type, payload) {
    env.sends.push(Object.assign({ type }, payload));
    if (type === 'TRANSLATE') return env.translate(payload);
    if (type === 'GET_PUBLIC_SETTINGS') return Promise.resolve({ sendTranslateEnabled: true });
    if (type === 'GET_THREAD_LANG') return Promise.resolve({ threadId: payload.threadId, lang: 'EN-US' });
    return Promise.resolve({ ok: true });
  },
  connected: () => env.connected,
  settings: () => env.settings,
  toast: (t) => env.toasts.push(t),
  host: () => null,
  onMessage() {}, onInboxChange() {}
};
Object.defineProperty(global, 'location', {
  configurable: true,
  get: () => ({ pathname: env.path, href: 'https://business.facebook.com' + env.path + '?asset_id=1&selected_item_id=' + env.thread })
});
global.document = {
  hidden: true,
  getSelection: () => ({ rangeCount: 0, removeAllRanges() {}, addRange() {} }),
  createRange: () => ({ selectNodeContents() {}, collapse() {} }),
  execCommand: () => false
};
global.DataTransfer = class { constructor() { this.d = {}; } setData(k, v) { this.d[k] = v; } getData(k) { return this.d[k]; } };
global.ClipboardEvent = class { constructor(type, init) { this.type = type; this.clipboardData = init.clipboardData; } };
class Ev {
  constructor(type, init) { Object.assign(this, { type, target: el }, init || {}); this.prevented = false; this.stopped = false; }
  preventDefault() { this.prevented = true; }
  stopImmediatePropagation() { this.stopped = true; }
}
global.KeyboardEvent = Ev;

require('../content/composer.js');
const C = global.MBX.composer;
const G = C._gate;

function reset(o) {
  env = Object.assign({
    text: '안녕하세요', thread: '1', path: '/latest/inbox/all', connected: true,
    settings: { sendTranslateEnabled: true }, hasComposer: true, hasButton: true, emptyOnClick: true, enterSends: true,
    clicks: 0, sends: [], toasts: [], syntheticKeys: [],
    onPaste(t) { env.text = t; }, // Lexical이 붙여넣기를 전체 교체로 반영
    translate: () => Promise.resolve({ ok: true, text: 'Hello', detectedLang: 'KO' })
  }, o || {});
  G.onThreadChanged();
  G.setLang(env.thread, o && o.lang !== undefined ? o.lang : 'EN-US');
  env.toasts.length = 0;
}
const enter = (o) => new Ev('keydown', Object.assign({ key: 'Enter', code: 'Enter', keyCode: 13 }, o));
const translates = () => env.sends.filter((m) => m.type === 'TRANSLATE');
async function idle() {
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 0));
  while (G.state().busy) {
    if (Date.now() - t0 > 5000) throw new Error('flow did not finish');
    await new Promise((r) => setTimeout(r, 10));
  }
}
function deferred() { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; }

test('Korean Enter: blocked, translated with source KO purpose, replaced, sent by button click, original shown not stored', async () => {
  reset();
  const e = enter();
  G.onKeyEvent(e);
  assert.equal(e.prevented, true); assert.equal(e.stopped, true);
  await idle();
  assert.deepEqual(translates().map((m) => [m.text, m.targetLang, m.purpose]), [['안녕하세요', 'EN-US', 'send']]);
  assert.equal(env.clicks, 1);
  assert.equal(env.text, '');
  assert.equal(G.state().lastTranslated, null);
  assert.equal(G.state().bypass, false);
  assert.deepEqual(env.toasts, []);
});

test('while translating, Enter / keyup / button are swallowed and only one translation runs', async () => {
  reset();
  const d = deferred();
  env.translate = () => d.p;
  G.onKeyEvent(enter());
  const again = enter();
  G.onKeyEvent(again);
  const up = new Ev('keyup', { key: 'Enter', code: 'Enter' });
  G.onKeyEvent(up);
  const click = new Ev('click', { target: btn });
  G.onPointerEvent(click);
  for (const ev of [again, up, click]) { assert.equal(ev.prevented, true); assert.equal(ev.stopped, true); }
  d.resolve({ ok: true, text: 'Hello' });
  await idle();
  assert.equal(translates().length, 1);
  assert.equal(env.clicks, 1);
});

test('DeepL error: nothing sent, original stays, error shown', async () => {
  reset({ translate: () => Promise.resolve({ ok: false, code: 'BAD_KEY', message: 'DeepL 키가 올바르지 않습니다' }) });
  G.onKeyEvent(enter());
  await idle();
  assert.equal(env.clicks, 0);
  assert.equal(env.text, '안녕하세요');
  assert.match(env.toasts.join('|'), /전송하지 않았습니다.*DeepL 키가 올바르지 않습니다/);
});

test('lost extension context (DISCONNECTED reply) never sends and shows the reload notice', async () => {
  reset({ translate: () => Promise.resolve({ ok: false, code: 'DISCONNECTED' }) });
  G.onKeyEvent(enter());
  await idle();
  assert.equal(env.clicks, 0);
  assert.equal(env.text, '안녕하세요');
  assert.ok(env.toasts.some((t) => /새로고침/.test(t)));
});

test('connected:false blocks Korean with the reload notice and no translation request', async () => {
  reset({ connected: false });
  const e = enter();
  G.onKeyEvent(e);
  assert.equal(e.prevented, true);
  await idle();
  assert.equal(translates().length, 0);
  assert.equal(env.clicks, 0);
  assert.ok(env.toasts.some((t) => /페이지를 새로고침하세요/.test(t)));
});

test('settings not yet received: Korean blocked with the loading message and settings re-requested; non-Korean passes', async () => {
  reset({ settings: null });
  const e = enter();
  G.onKeyEvent(e);
  assert.equal(e.prevented, true);
  assert.ok(env.toasts.includes('번역 설정을 불러오는 중입니다. 잠시 후 다시 시도하세요'));
  assert.ok(env.sends.some((m) => m.type === 'GET_PUBLIC_SETTINGS'));
  reset({ settings: null, text: 'hello' });
  const e2 = enter();
  G.onKeyEvent(e2);
  assert.equal(e2.prevented, false); assert.equal(e2.stopped, false);
});

test('thread language still loading blocks Korean', () => {
  reset({ lang: null });
  const e = enter();
  G.onKeyEvent(e);
  assert.equal(e.prevented, true);
  assert.equal(translates().length, 0);
});

test('thread changes during translation: nothing inserted, nothing sent', async () => {
  reset();
  const d = deferred();
  env.translate = () => d.p;
  G.onKeyEvent(enter());
  env.thread = '2';
  d.resolve({ ok: true, text: 'Hello' });
  await idle();
  assert.equal(env.clicks, 0);
  assert.equal(env.text, '안녕하세요');
});

test('user edits during translation: aborted, user content kept', async () => {
  reset();
  const d = deferred();
  env.translate = () => d.p;
  G.onKeyEvent(enter());
  env.text = '안녕하세요 반갑습니다';
  d.resolve({ ok: true, text: 'Hello' });
  await idle();
  assert.equal(env.clicks, 0);
  assert.equal(env.text, '안녕하세요 반갑습니다');
});

test('replacement failure: not sent, original restored', async () => {
  reset();
  let n = 0;
  env.onPaste = (t) => { n++; env.text = n === 1 ? env.text + t : t; }; // 1회째는 교체가 아니라 덧붙임
  G.onKeyEvent(enter());
  await idle();
  assert.equal(env.clicks, 0);
  assert.equal(env.text, '안녕하세요');
  assert.ok(env.toasts.some((t) => /바꾸지 못해 전송하지 않았습니다/.test(t)));
});

test('leftover Hangul: not sent automatically; pressing again unchanged passes to Meta', async () => {
  reset({ translate: () => Promise.resolve({ ok: true, text: 'Visit  강남\nclinic' }) });
  G.onKeyEvent(enter());
  await idle();
  assert.equal(env.clicks, 0);
  assert.ok(env.toasts.includes('번역 결과에 한글이 남아 있습니다. 확인 후 Enter를 한 번 더 누르면 그대로 전송됩니다'));
  const e = enter();
  G.onKeyEvent(e);
  assert.equal(e.prevented, false); assert.equal(e.stopped, false);
});

test('continuation does not empty the composer: manual-send message, next Enter passes', async () => {
  reset({ emptyOnClick: false });
  G.onKeyEvent(enter());
  await idle();
  assert.equal(env.clicks, 1);
  assert.equal(env.text, 'Hello');
  assert.ok(env.toasts.includes('번역되었습니다. Enter를 한 번 더 눌러 전송하세요'));
  const e = enter();
  G.onKeyEvent(e);
  assert.equal(e.prevented, false);
});

test('no submit button: synthetic Enter keydown passes through the gate (bypass) once', async () => {
  reset({ hasButton: false });
  G.onKeyEvent(enter());
  await idle();
  assert.equal(env.syntheticKeys.length, 1);
  assert.equal(env.syntheticKeys[0].prevented, false);
  assert.equal(env.syntheticKeys[0].stopped, false);
  assert.equal(env.text, '');
});

test('composing Enter: stopped but not prevented, flow starts once on compositionend; the following Enter is swallowed', async () => {
  reset();
  env.text = '안녕하세'; // 마지막 글자가 아직 확정되지 않음
  const k = enter({ key: 'Process', isComposing: true, keyCode: 229 });
  G.onKeyEvent(k);
  assert.equal(k.stopped, true); assert.equal(k.prevented, false);
  assert.equal(G.state().pending, true);
  env.text = '안녕하세요'; // 조합 확정
  G.onCompositionEnd(new Ev('compositionend'));
  const follow = enter();
  G.onKeyEvent(follow); // 조합 종료 후 뒤따르는 keydown
  assert.equal(follow.prevented, true); assert.equal(follow.stopped, true);
  await idle();
  assert.deepEqual(translates().map((m) => m.text), ['안녕하세요']);
  assert.equal(env.clicks, 1);
});

test('composing Enter then a following non-composing Enter (no compositionend first) starts the flow once', async () => {
  reset();
  G.onKeyEvent(enter({ isComposing: true, keyCode: 229 }));
  const follow = enter();
  G.onKeyEvent(follow);
  assert.equal(follow.prevented, true);
  G.onCompositionEnd(new Ev('compositionend')); // 늦게 와도 다시 시작하지 않는다
  await idle();
  assert.equal(translates().length, 1);
  assert.equal(env.clicks, 1);
});

test('composing Enter with translation OFF is left to Meta untouched', () => {
  reset({ lang: 'OFF' });
  const k = enter({ isComposing: true, keyCode: 229 });
  G.onKeyEvent(k);
  assert.equal(k.stopped, false); assert.equal(k.prevented, false);
  assert.equal(G.state().pending, false);
});

test('send-pending expires after 500ms, and focus loss clears it at once', async () => {
  reset();
  G.onKeyEvent(enter({ isComposing: true, keyCode: 229 }));
  await new Promise((r) => setTimeout(r, 550));
  G.onCompositionEnd(new Ev('compositionend'));
  await idle();
  assert.equal(translates().length, 0);
  reset();
  G.onKeyEvent(enter({ isComposing: true, keyCode: 229 }));
  G.onFocusOut(new Ev('focusout'));
  G.onCompositionEnd(new Ev('compositionend'));
  await idle();
  assert.equal(translates().length, 0);
});

test('submit button: mousedown/pointerdown blocked without starting a flow, click starts it', async () => {
  reset();
  const md = new Ev('mousedown', { target: btn });
  const pd = new Ev('pointerdown', { target: btn });
  G.onPointerEvent(pd); G.onPointerEvent(md);
  assert.equal(md.prevented, true); assert.equal(pd.prevented, true);
  assert.equal(G.state().busy, false);
  const c = new Ev('click', { target: btn });
  G.onPointerEvent(c);
  assert.equal(c.prevented, true);
  await idle();
  assert.equal(translates().length, 1);
  assert.equal(env.clicks, 1);
});

test('gate is inert off the inbox, when send translation is off, for modified Enter, and outside the composer', () => {
  for (const o of [{ path: '/latest/home' }, { settings: { sendTranslateEnabled: false } }]) {
    reset(o);
    const e = enter();
    G.onKeyEvent(e);
    assert.equal(e.prevented, false); assert.equal(e.stopped, false);
  }
  reset();
  const s = enter({ shiftKey: true });
  G.onKeyEvent(s);
  assert.equal(s.prevented, false);
  const outside = enter({ target: other });
  G.onKeyEvent(outside);
  assert.equal(outside.prevented, false);
  assert.equal(translates().length, 0);
});

test('Windows-style composing keydown (key Process, code Enter) is recognised', () => {
  reset();
  const k = enter({ key: 'Process', code: 'Enter', keyCode: 229 });
  G.onKeyEvent(k);
  assert.equal(k.stopped, true);
  G.onThreadChanged(); // 대화가 바뀌면 전송 대기를 즉시 끈다
  assert.equal(G.state().pending, false);
});
