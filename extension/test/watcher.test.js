// watcher.js 시나리오 테스트. sel(DOM 조회)·util·타이머·MutationObserver를 흉내 내고 실제 watcher.js를 돌린다.
// 이 파일은 별도 프로세스에서 실행되므로(node --test) 전역을 바꿔도 다른 테스트에 영향이 없다. 끝나면 되돌린다.
const test = require('node:test');
const EXT = require('path').join(__dirname, '..') + '/';
test('watcher scenario: load, badge, candidate, own reply, scroll, hidden double observe, other account, heartbeat, login stop, late ready, stale debounce', () => {
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
  itemChannel: () => 'wec', listScrollTop: () => scrollTop, filterState: () => '', isListOrThreadMenu: () => false,
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
global.document.createElement = () => ({ style: {}, appendChild() {}, addEventListener() {} });
// DEBUG_FORCE_OWNER는 false 이므로 role 'owner'로 흉내 낸다
require(EXT + 'content/watcher.js');
const mut = () => mos[0].cb([]);
const types = () => sent.map(s => s.type + (s.type === 'LIST_CANDIDATE' ? ':' + s.sender : s.type === 'BADGE_STATE' ? ':' + s.badges.wec + (s.initial ? 'i' : '') : ''));
const assert = require('assert');

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
advance(1); // confirm timer
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
advance(1); // confirm → I 전송
advance(2000); // 예전 디바운스 타이머가 남아 있었다면 여기서 울림
document.visibilityState = 'visible'; listeners.visibilitychange[0]();
const b3 = sent.length;
list = [{ name: 'J', preview: 'half', time: '2:08 PM' }, ...list]; mut();
assert.equal(sent.length, b3, 'visible change waits for debounce (no stale flag)');
advance(1600);
assert.ok(sent.slice(b3).some(s => s.sender === 'J'));
} finally {
  Date.now = saved.now; global.setTimeout = saved.st; global.clearTimeout = saved.ct; global.setInterval = saved.si; console.debug = saved.dbg;
}
});

