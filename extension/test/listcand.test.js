const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/listcand.js');
const it = (name, preview, time = '1:59 PM') => { const o = { channel: 'wec', name, preview, time }; return { ...o, key: L.itemKey(o) }; };
const known = (...items) => new Set(items.map(i => i.key));

test('parseItemLines follows the confirmed line order', () => {
  assert.deepEqual(L.parseItemLines(['Hong Gildong', '예약 가능한가요', 'Today', '1:59 PM', 'Follow up']), { name: 'Hong Gildong', preview: '예약 가능한가요', time: '1:59 PM' });
  assert.deepEqual(L.parseItemLines(['821012345678', 'hi', 'Wednesday', 'Wed']), { name: '821012345678', preview: 'hi', time: 'Wed' });
  assert.equal(L.parseItemLines(['only name']), null);
});

test('time and preview classifiers', () => {
  assert.equal(L.isTodayTime('1:59 PM'), true);
  assert.equal(L.isTodayTime('13:05'), true);
  assert.equal(L.isTodayTime('Wed'), false);
  assert.equal(L.isOwnMessage('You: 네'), true);
  assert.equal(L.isTyping('Typing…'), true);
});

test('a new item above every known item is a candidate', () => {
  const a = it('A', 'old'), b = it('B', 'old');
  const r = L.findCandidates([it('C', 'new'), a, b], known(a, b));
  assert.deepEqual(r.candidates.map(c => c.name), ['C']);
  assert.equal(r.reset, false);
});

test('an existing thread with a new preview is a candidate', () => {
  const a = it('A', 'old'), b = it('B', 'old');
  const r = L.findCandidates([it('B', 'new one'), a], known(a, b));
  assert.deepEqual(r.candidates.map(c => c.preview), ['new one']);
});

test('an item that slid up from below after move-to-done is not a candidate', () => {
  const a = it('A', 'x'), b = it('B', 'x');
  const r = L.findCandidates([a, b, it('P', 'from below')], known(a, b));
  assert.deepEqual(r.candidates, []);
});

test('own messages, typing, and non-today items are skipped', () => {
  const a = it('A', 'x');
  const r = L.findCandidates([it('B', 'You: 네'), it('C', 'Typing…'), it('D', 'hi', 'Wed'), a], known(a));
  assert.deepEqual(r.candidates, []);
  assert.equal(r.reset, false);
});

test('no known item in view means the list was replaced', () => {
  const r = L.findCandidates([it('X', '1'), it('Y', '2')], known(it('A', 'x')));
  assert.deepEqual(r, { candidates: [], reset: true });
});

test('four or more candidates at once also reset', () => {
  const a = it('A', 'x');
  const r = L.findCandidates([it('P', '1'), it('Q', '2'), it('R', '3'), it('S', '4'), a], known(a));
  assert.deepEqual(r, { candidates: [], reset: true });
});

test('remember keeps at most cap keys, dropping the oldest', () => {
  const k = new Set(['1', '2']);
  L.remember(k, ['3', '4'], 3);
  assert.deepEqual([...k], ['2', '3', '4']);
});

// ---- 추가 테스트 ----

test('parseItemLines trims and skips empty lines; needs name, preview, date, time', () => {
  assert.deepEqual(L.parseItemLines(['  A ', '', ' hi ', 'Today', ' 9:05 AM ']), { name: 'A', preview: 'hi', time: '9:05 AM' });
  assert.equal(L.parseItemLines(['A', 'hi', 'Today']), null);
  assert.equal(L.parseItemLines(null), null);
});

test('isTodayTime accepts h:mm with optional AM/PM, rejects others', () => {
  assert.equal(L.isTodayTime('9:05 am'), true);
  assert.equal(L.isTodayTime('12:00PM'), true);
  assert.equal(L.isTodayTime('오후 1:59'), true);
  assert.equal(L.isTodayTime('1:5'), false);
  assert.equal(L.isTodayTime('Nov 3'), false);
  assert.equal(L.isTodayTime(''), false);
  assert.equal(L.isTodayTime(undefined), false);
});

test('isOwnMessage and isTyping do not match ordinary previews', () => {
  assert.equal(L.isOwnMessage('Your booking'), false);
  assert.equal(L.isOwnMessage(undefined), false);
  assert.equal(L.isTyping('typing...'), true);
  assert.equal(L.isTyping('Typing tips for you'), false);
  assert.equal(L.isTyping('예약 가능한가요'), false);
});

test('itemKey is an 8-digit hex FNV-1a hash and separates fields', () => {
  const k = L.itemKey({ channel: 'wec', name: 'A', preview: 'b', time: '1:00 PM' });
  assert.match(k, /^[0-9a-f]{8}$/);
  assert.equal(k, L.itemKey({ channel: 'wec', name: 'A', preview: 'b', time: '1:00 PM' }));
  assert.notEqual(L.itemKey({ channel: 'wec', name: 'Ab', preview: '', time: 'x' }), L.itemKey({ channel: 'wec', name: 'A', preview: 'b', time: 'x' }));
  assert.notEqual(k, L.itemKey({ channel: 'instagram_direct', name: 'A', preview: 'b', time: '1:00 PM' }));
  // FNV-1a 32비트 기준값: 빈 입력 3필드 구분자만 있을 때도 결정적이다
  assert.equal(L.fnv1a(''), '811c9dc5');
  assert.equal(L.fnv1a('a'), 'e40c292c');
});

test('findCandidates only looks at the top LIST_TOP_N items', () => {
  const a = it('A', 'x');
  const filler = Array.from({ length: 15 }, (_, i) => it('F' + i, 'old', 'Wed'));
  const r = L.findCandidates([...filler, a], known(...filler.slice(1)));
  assert.equal(r.reset, false);
  const r2 = L.findCandidates([...filler, a], known(a));
  assert.deepEqual(r2, { candidates: [], reset: true });
});

test('exactly three candidates are allowed', () => {
  const a = it('A', 'x');
  const r = L.findCandidates([it('P', '1'), it('Q', '2'), it('R', '3'), a], known(a));
  assert.deepEqual(r.candidates.map(c => c.name), ['P', 'Q', 'R']);
  assert.equal(r.reset, false);
});

test('a known item at the top yields no candidates', () => {
  const a = it('A', 'x'), b = it('B', 'y');
  assert.deepEqual(L.findCandidates([a, b], known(a, b)), { candidates: [], reset: false });
});

test('remember refreshes a re-seen key so it is not evicted first', () => {
  const k = new Set(['1', '2', '3']);
  L.remember(k, ['1', '4'], 3);
  assert.deepEqual([...k], ['3', '1', '4']);
});

// ---- 안정화 상태 ----

test('settle: load waits SETTLE_LOAD_MS of quiet, then ready once', () => {
  let s = L.settleStart(0);
  assert.equal(s.phase, 'load');
  let r = L.settleTick(s, 19999);
  assert.equal(r.becameReady, false);
  s = L.settleTouch(s, 10000);
  r = L.settleTick(s, 29999);
  assert.equal(r.becameReady, false);
  r = L.settleTick(s, 30000);
  assert.deepEqual([r.becameReady, r.from, r.state.phase], [true, 'load', 'ready']);
  r = L.settleTick(r.state, 99999);
  assert.equal(r.becameReady, false);
});

test('settle: change waits SETTLE_CHANGE_MS; touch in ready is ignored', () => {
  let s = L.settleEnter({ phase: 'ready', lastChange: 0 }, 'change', 1000);
  assert.equal(s.phase, 'change');
  assert.equal(L.settleTick(s, 3999).becameReady, false);
  const r = L.settleTick(s, 4000);
  assert.deepEqual([r.becameReady, r.from], [true, 'change']);
  assert.deepEqual(L.settleTouch(r.state, 5000), r.state);
});

test('settle: a change entry during load keeps the longer load wait', () => {
  let s = L.settleStart(0);
  s = L.settleEnter(s, 'change', 5000);
  assert.equal(s.phase, 'load');
  assert.equal(L.settleTick(s, 9000).becameReady, false);
  assert.equal(L.settleTick(s, 25000).becameReady, true);
});

test('settle: load entry during change switches to load', () => {
  const s = L.settleEnter({ phase: 'change', lastChange: 0 }, 'load', 100);
  assert.deepEqual(s, { phase: 'load', lastChange: 100 });
});

// ---- 가려진 탭: 연속 두 번 관찰 ----

test('confirmTwice sends only candidates seen in the previous observation too', () => {
  const c1 = it('C', 'partial'), c2 = it('C', 'final');
  let r = L.confirmTwice(null, [c1]);
  assert.deepEqual(r.confirmed, []);
  assert.deepEqual(r.unconfirmed.map(c => c.key), [c1.key]);
  r = L.confirmTwice(r.next, [c2]);
  assert.deepEqual(r.confirmed, []);
  r = L.confirmTwice(r.next, [c2]);
  assert.deepEqual(r.confirmed.map(c => c.key), [c2.key]);
  assert.deepEqual(r.unconfirmed, []);
});

// ---- service worker 쪽 형식 검사 ----

test('validCandidateMsg checks channel and field types', () => {
  const ok = { asset_id: '1', channel: 'wec', sender: 'A', preview: 'hi', time: '1:59 PM', at: 5 };
  assert.equal(L.validCandidateMsg(ok), true);
  assert.equal(L.validCandidateMsg({ ...ok, preview: '' }), true);
  assert.equal(L.validCandidateMsg({ ...ok, channel: 'all' }), false);
  assert.equal(L.validCandidateMsg({ ...ok, sender: '' }), false);
  assert.equal(L.validCandidateMsg({ ...ok, preview: 3 }), false);
  assert.equal(L.validCandidateMsg({ ...ok, time: 'Wed' }), false);
  assert.equal(L.validCandidateMsg({ ...ok, sender: 'x'.repeat(1001) }), false);
  assert.equal(L.validCandidateMsg(null), false);
});

test('isTyping ignores sentences that merely end in typing', () => {
  assert.equal(L.isTyping('Hong is typing…'), true);
  assert.equal(L.isTyping('I like typing'), false);
  assert.equal(L.isTyping('입력 중…'), true);
});
