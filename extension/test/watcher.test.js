// watcher.js 시나리오 테스트. sel(DOM 조회)·util·타이머·MutationObserver를 흉내 내고 실제 watcher.js를 돌린다.
// 이 파일은 별도 프로세스에서 실행되므로(node --test) 전역을 바꿔도 다른 테스트에 영향이 없다. 끝나면 되돌린다.
const test = require('node:test');
const EXT = require('path').join(__dirname, '..') + '/';
const assert = require('assert');

// 새 watcher.js 인스턴스와 흉내 낸 환경을 만든다. 각 테스트는 동기로 돌고 끝나면 전역을 되돌린다.
function withEnv(fn) {
  const saved = { now: Date.now, st: global.setTimeout, ct: global.clearTimeout, si: global.setInterval, dbg: console.debug };
  console.debug = () => {};
  try {
let now = 1000000;
Date.now = () => now;
const timers = [];
global.setTimeout = (fn, ms) => { const t = { fn, at: now + (ms || 0), id: Symbol() }; timers.push(t); return t; };
global.clearTimeout = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
const intervals = []; global.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return 0; };
function advance(ms) { const end = now + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const t = timers[0]; if (!t || t.at > end) break; timers.shift(); now = t.at; t.fn(); } now = end; }
const mos = [];
global.MutationObserver = class { constructor(cb) { this.cb = cb; mos.push(this); } observe() {} disconnect() {} };
const listeners = {};
global.document = { readyState: 'complete', visibilityState: 'visible', documentElement: {}, addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); } };
global.window = { innerHeight: 800 };
global.location = { pathname: '/latest/inbox/wec', href: 'https://business.facebook.com/latest/inbox/wec?asset_id=A1' };
global.self = global;
global.MBX = {};
Object.assign(MBX, require(EXT + 'lib/constants.js'), require(EXT + 'lib/listcand.js'));
const realSel = require(EXT + 'content/selectors.js').sel;
let badges = { instagram_direct: 0, wec: 0 };
let list = []; // [{name, preview, time}]
let scrollTop = 0; let blockedNow = null;
const tabArea = { isConnected: true }, listEl = { isConnected: true };
MBX.sel = Object.assign({}, realSel, {
  channelTabs: () => [{ getAttribute: () => '/latest/inbox/wec?asset_id=A1' }],
  channelTabArea: () => tabArea, listContainer: () => listEl,
  channelBadges: () => ({ ...badges }),
  listItems: () => list.map(x => ({ x, getBoundingClientRect: () => ({ top: 1, bottom: 2 }) })),
  itemLines: (el) => [el.x.name, el.x.preview, 'Today', el.x.time],
  itemChannel: (el) => el.x.ch || 'wec', isListHeaderControl: (t) => t === 'header', listScrollTop: () => scrollTop, filterState: () => '', isListOrThreadMenu: () => false,
  blockedScreen: () => blockedNow, dialogOpen: () => false
});
const sent = [];
let role = 'owner', settings = null;
const handlers = {};
MBX.util = {
  send: (type, p) => { sent.push({ type, ...p }); return Promise.resolve({ ok: true }); },
  settings: () => settings, role: () => role, host: () => ({ appendChild() {} }),
  onInboxChange() {}, onMessage: (t, f) => { (handlers[t] = handlers[t] || []).push(f); }
};
const created = [];
global.document.createElement = (tag) => { const e = { tag, style: {}, textContent: '', appendChild() {}, addEventListener() {} }; created.push(e); return e; };
// 기본은 담당(role 'owner')으로 흉내 낸다. 대기·다른 계정은 setRole 로 바꾼다.
delete require.cache[require.resolve(EXT + 'content/watcher.js')];
require(EXT + 'content/watcher.js');
const mut = () => mos[0].cb([]);
const types = () => sent.map(s => s.type + (s.type === 'LIST_CANDIDATE' ? ':' + s.sender : s.type === 'BADGE_STATE' ? ':' + s.badges.wec + (s.initial ? 'i' : '') : ''));

const hb = () => intervals.find(i => i.ms === 30000).fn();
const ready = () => { list = [{ name: 'A', preview: 'a', time: '1:00 PM' }, { name: 'B', preview: 'b', time: 'Wed' }]; settings = { assetId: 'A1' }; handlers.SETTINGS_CHANGED.forEach(f => f()); advance(21000); sent.length = 0; };
const noticeText = () => { const t = created.filter(e => e.className === 'mbx-wnotice-text').pop(); const b = created.filter(e => e.className === 'mbx-wnotice').pop(); return b && b.style.display !== 'none' ? t.textContent : null; };
if (fn === LEGACY) {

list = [{ name: 'A', preview: 'a', time: '1:00 PM' }, { name: 'B', preview: 'b', time: 'Wed' }];
settings = { assetId: 'A1' }; handlers.SETTINGS_CHANGED.forEach(f => f());
advance(10000); mut();
assert.deepEqual(types(), [], 'nothing during load');
advance(21000);
assert.deepEqual(types(), ['BADGE_STATE:0i'], 'initial badge after load');
// 새 메시지: 배지 1, 목록 맨 위 C
badges.wec = 1; list = [{ name: 'C', preview: 'hi', time: '2:00 PM' }, ...list]; mut();
assert.deepEqual(types(), ['BADGE_STATE:0i', 'BADGE_STATE:1'], 'badge immediate');
advance(1600);
assert.deepEqual(types().slice(2), ['LIST_CANDIDATE:C'], 'candidate after debounce');
// 내 답장
list[0] = { name: 'C', preview: 'You: ok', time: '2:01 PM' }; mut(); advance(2000);
assert.equal(types().length, 3, 'own reply ignored');
// 스크롤 내렸다 올림 → change 안정화 중 새 항목은 후보 아님
scrollTop = 100; listeners.scroll[0](); advance(200);
scrollTop = 0; list = [{ name: 'D', preview: 'new', time: '2:02 PM' }, ...list]; listeners.scroll[0](); advance(200); mut(); advance(5000);
assert.equal(types().length, 3, 'no candidate during change settle');
// 가려진 탭: 두 번 관찰
document.visibilityState = 'hidden'; listeners.visibilitychange[0]();
list = [{ name: 'E', preview: 'part', time: '2:03 PM' }, ...list]; mut();
assert.equal(types().length, 3, 'not sent on first observation');
advance(500); // confirm timer (400ms)
assert.deepEqual(types().slice(3), ['LIST_CANDIDATE:E'], 'sent on second identical observation');
// 다른 계정
location.href = 'https://business.facebook.com/latest/inbox/wec?asset_id=Z9';
MBX.sel.channelTabs = () => [{ getAttribute: () => '/latest/inbox/wec?asset_id=Z9' }];
badges.wec = 5; list = [{ name: 'F', preview: 'x', time: '2:04 PM' }, ...list]; mut(); advance(5000);
assert.equal(types().length, 4, 'other account: nothing');

// ---- 추가 시나리오 ----
// 계정 복귀 → load 다시
location.href = 'https://business.facebook.com/latest/inbox/wec?asset_id=A1';
MBX.sel.channelTabs = () => [{ getAttribute: () => '/latest/inbox/wec?asset_id=A1' }];
document.visibilityState = 'visible';
const hb = intervals.find(i => i.ms === 30000).fn;
sent.length = 0; mut();
hb();
assert.equal(sent.length, 1); assert.equal(sent[0].type, 'HEARTBEAT'); assert.equal(sent[0].ok, true);
assert.equal('badges' in sent[0], false, 'no badges during load');
advance(21000);
sent.length = 0; hb();
assert.deepEqual(sent[0].badges, { instagram_direct: 0, wec: 5 }, 'badges after load');
// 로그인 화면 60초
sent.length = 0; blockedNow = 'login'; mut();
hb(); assert.equal(sent.length, 0, 'no heartbeat before 60s');
badges.wec = 9; list = [{ name: 'G', preview: 'x', time: '2:05 PM' }, ...list]; mut();
advance(61000);
assert.deepEqual(sent.map(s => s.type + ':' + s.ok + ':' + s.reason), ['HEARTBEAT:false:login'], 'one login heartbeat, nothing else');
hb(); assert.equal(sent.length, 2, 'repeats on interval');
blockedNow = null; sent.length = 0; mut(); advance(5000); mut();
assert.equal(sent.filter(s => s.type !== 'HEARTBEAT').length, 0, 'load after login return');
advance(20000);
assert.ok(sent.some(s => s.type === 'BADGE_STATE' && s.initial), 'initial after login return');
// 늦은 ready: settle 타이머 제거 후 20초 지나 새 항목
const before = sent.length;
// change 안정화에 들어가게 필터 변경
MBX.sel.filterState = () => 'on:Unread'; mut();
timers.length = 0; // 타이머가 늦어진 상황
now += 4000;
list = [{ name: 'H', preview: 'late', time: '2:06 PM' }, ...list]; mut();
advance(1600);
assert.ok(sent.slice(before).some(s => s.type === 'LIST_CANDIDATE' && s.sender === 'H'), 'late ready: new top item is a candidate');
// 오래된 디바운스: 보일 때 변경 → 가려진 탭에서 즉시 판단 → 다시 보일 때 변경은 1.5초 기다린다
const b2 = sent.length;
list = [{ name: 'I', preview: '1', time: '2:07 PM' }, ...list]; mut();          // visible: debounce 예약
document.visibilityState = 'hidden'; listeners.visibilitychange[0]();            // hidden: 즉시 판단(첫 관찰)
advance(500); // confirm → I 전송
advance(2000); // 예전 디바운스 타이머가 남아 있었다면 여기서 울림
document.visibilityState = 'visible'; listeners.visibilitychange[0]();
const b3 = sent.length;
list = [{ name: 'J', preview: 'half', time: '2:08 PM' }, ...list]; mut();
assert.equal(sent.length, b3, 'visible change waits for debounce (no stale flag)');
advance(1600);
assert.ok(sent.slice(b3).some(s => s.sender === 'J'));

  return;
}
fn({
  get now() { return now; }, set now(v) { now = v; }, timers, advance, mut, types, sent, listeners, handlers, hb, ready, noticeText,
  setList: (l) => { list = l; }, getList: () => list, setBadges: (b) => { badges = b; }, setScroll: (v) => { scrollTop = v; },
  setBlocked: (v) => { blockedNow = v; }, setRole: (r) => { role = r; }, setSettings: (x) => { settings = x; }
});
  } finally {
    Date.now = saved.now; global.setTimeout = saved.st; global.clearTimeout = saved.ct; global.setInterval = saved.si; console.debug = saved.dbg;
  }
}

const LEGACY = () => {};
test('watcher scenario: load, badge, candidate, own reply, scroll, hidden double observe, other account, heartbeat, login stop, late ready, stale debounce', () => withEnv(LEGACY));

const cands = (e) => e.sent.filter(s => s.type === 'LIST_CANDIDATE').map(s => s.sender);

test('a click or input in the list header area starts the 3s change settle (U11 fallback)', () => withEnv((e) => {
  e.ready();
  e.listeners.click[0]({ target: 'header' });
  e.setList([{ name: 'C', preview: 'filtered', time: '2:00 PM' }, ...e.getList()]); e.mut();
  e.advance(2500);
  assert.deepEqual(cands(e), [], 'no candidate inside the 3s window after a header click');
  e.advance(2000);
  assert.deepEqual(cands(e), []);
  e.listeners.input[0]({ target: 'header' });
  e.setList([{ name: 'D', preview: 'search', time: '2:01 PM' }, ...e.getList()]); e.mut();
  e.advance(2500);
  assert.deepEqual(cands(e), [], 'same for input');
  // 다른 곳 클릭은 영향 없음
  e.advance(5000);
  e.listeners.click[0]({ target: 'elsewhere' });
  e.setList([{ name: 'E', preview: 'real', time: '2:02 PM' }, ...e.getList()]); e.mut();
  e.advance(1600);
  assert.deepEqual(cands(e), ['E']);
}));

test('login/security screen: 3s grace, notice while blocked, load again after', () => withEnv((e) => {
  e.ready();
  // 짧은 깜빡임(1초)은 차단으로 보지 않는다: load 재진입 없이 후보가 곧바로 나온다
  e.setBlocked('login'); e.mut(); e.advance(1000);
  e.setBlocked(null); e.mut();
  assert.equal(e.noticeText(), null);
  e.setList([{ name: 'C', preview: 'hi', time: '2:00 PM' }, ...e.getList()]); e.mut();
  e.advance(1600);
  assert.deepEqual(cands(e), ['C'], 'brief flap does not trigger load');
  // 3초 넘게 이어지면 차단: 안내 표시, 보고 없음
  e.sent.length = 0;
  e.setBlocked('login'); e.mut(); e.advance(3100);
  assert.equal(e.noticeText(), '로그인/보안 확인 화면에서 감지를 멈췄습니다');
  e.setBadges({ instagram_direct: 0, wec: 3 });
  e.setList([{ name: 'D', preview: 'x', time: '2:01 PM' }, ...e.getList()]); e.mut(); e.advance(5000);
  assert.deepEqual(e.sent.filter(s => s.type !== 'HEARTBEAT'), []);
  e.setBlocked(null); e.mut();
  assert.equal(e.noticeText(), null);
  e.advance(10000); e.mut();
  assert.deepEqual(e.sent.filter(s => s.type !== 'HEARTBEAT'), [], 'load settle after return');
  e.advance(11000);
  assert.ok(e.sent.some(s => s.type === 'BADGE_STATE' && s.initial));
}));

test('failure clock is not reset by a brief flap to another failure reason', () => withEnv((e) => {
  e.ready();
  const sel = global.MBX.sel;
  const origList = sel.listContainer;
  sel.listContainer = () => null; e.mut();       // selector 실패 시작
  e.advance(30000);
  e.setBlocked('login'); e.mut(); e.advance(1000); e.setBlocked(null); e.mut(); // 1초 깜빡임
  e.advance(30500);
  const fails = e.sent.filter(s => s.type === 'HEARTBEAT' && s.ok === false);
  assert.equal(fails.length, 1);
  assert.equal(fails[0].reason, 'selector');
  sel.listContainer = origList;
}));

test('comment inbox path produces no list candidates; channel path requires matching icon channel', () => withEnv((e) => {
  e.ready();
  global.location.pathname = '/latest/inbox/instagram';
  global.location.href = 'https://business.facebook.com/latest/inbox/instagram?asset_id=A1';
  e.mut(); e.advance(4000);
  e.setList([{ name: 'K', preview: 'comment', time: '2:00 PM', ch: 'instagram_direct' }, ...e.getList()]); e.mut();
  e.advance(5000);
  assert.deepEqual(cands(e), [], 'no candidates on the comments path');
  // wec 경로에서 Instagram 아이콘 항목은 후보가 아니다
  global.location.pathname = '/latest/inbox/wec';
  global.location.href = 'https://business.facebook.com/latest/inbox/wec?asset_id=A1';
  e.mut(); e.advance(4000);
  e.setList([{ name: 'L', preview: 'ig', time: '2:01 PM', ch: 'instagram_direct' }, ...e.getList()]); e.mut();
  e.advance(1600);
  assert.deepEqual(cands(e), []);
  e.setList([{ name: 'M', preview: 'wa', time: '2:02 PM', ch: 'wec' }, ...e.getList()]); e.mut();
  e.advance(1600);
  assert.deepEqual(cands(e), ['M']);
}));

test('hidden tab confirms with a 400ms second observation', () => withEnv((e) => {
  e.ready();
  global.document.visibilityState = 'hidden'; e.listeners.visibilitychange[0]();
  e.setList([{ name: 'C', preview: 'hi', time: '2:00 PM' }, ...e.getList()]); e.mut();
  e.advance(399);
  assert.deepEqual(cands(e), []);
  e.advance(2);
  assert.deepEqual(cands(e), ['C']);
}));

test('standby role sends LIST_CANDIDATE but never BADGE_STATE or HEARTBEAT', () => withEnv((e) => {
  e.setRole('standby');
  e.ready();
  e.setBadges({ instagram_direct: 0, wec: 2 });
  e.setList([{ name: 'C', preview: 'hi', time: '2:00 PM' }, ...e.getList()]); e.mut();
  e.advance(1600);
  e.hb();
  e.handlers.WATCHER_ROLE.forEach(f => f({ type: 'WATCHER_ROLE', role: 'standby' }));
  e.advance(70000); e.hb();
  assert.deepEqual(e.sent.map(s => s.type), ['LIST_CANDIDATE']);
}));

// Task 12: 실패 신호는 담당 여부와 관계없이 보낸다(asset_id를 못 읽은 탭은 담당이 될 수 없다). 정상 신호는 담당만.
test('standby tab reports a failure heartbeat after 60s, without badges', () => withEnv((e) => {
  e.setRole('standby');
  e.ready();
  const sel = global.MBX.sel;
  const origList = sel.listContainer;
  sel.listContainer = () => null; e.mut();
  e.advance(61000);
  sel.listContainer = origList;
  const hbs = e.sent.filter(s => s.type === 'HEARTBEAT');
  assert.equal(hbs.length, 1);
  assert.deepEqual([hbs[0].ok, hbs[0].reason, 'badges' in hbs[0]], [false, 'selector', false]);
  assert.equal(e.sent.filter(s => s.type === 'BADGE_STATE').length, 0);
}));

test('tab that cannot read asset_id (never owner) reports no_asset_id after 60s', () => withEnv((e) => {
  e.setRole('other_account');
  e.ready();
  const sel = global.MBX.sel;
  const origTabs = sel.channelTabs, origHref = global.location.href;
  sel.channelTabs = () => [{ getAttribute: () => '/latest/inbox/wec' }];
  global.location.href = 'https://business.facebook.com/latest/inbox/wec';
  e.mut();
  e.advance(61000);
  sel.channelTabs = origTabs; global.location.href = origHref;
  const hbs = e.sent.filter(s => s.type === 'HEARTBEAT');
  assert.equal(hbs.length, 1);
  assert.deepEqual([hbs[0].ok, hbs[0].reason, hbs[0].asset_id], [false, 'no_asset_id', '']);
}));
