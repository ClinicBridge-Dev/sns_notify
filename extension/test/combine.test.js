const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/combine.js');
let n = 0; const id = () => 'id' + (++n);
const empty = () => ({ queue: [], recent: [] });
const ev = (o = {}) => ({ channel: 'wec', count: 1, kind: 'new', manualHint: false, at: 0, ...o });
const cand = (o = {}) => ({ channel: 'wec', sender: 'Hong', preview: 'hi', time: '2:02 PM', at: 0, ...o });

test('badge event is held for 5 seconds', () => {
  const st = C.routeBadgeEvent(empty(), ev(), 1000, id);
  assert.equal(st.queue.length, 1);
  assert.deepEqual([st.queue[0].type, st.queue[0].status, st.queue[0].holdUntil], ['badge', 'hold', 6000]);
});

test('candidate within the hold joins the badge event and is released at once', () => {
  let st = C.routeBadgeEvent(empty(), ev(), 1000, id);
  st = C.routeCandidate(st, cand(), 2000, id);
  assert.equal(st.queue.length, 1);
  assert.deepEqual([st.queue[0].sender, st.queue[0].preview, st.queue[0].status], ['Hong', 'hi', 'ready']);
});

test('candidate first, badge event within 5s joins it', () => {
  let st = C.routeCandidate(empty(), cand(), 1000, id);
  assert.deepEqual([st.queue[0].type, st.queue[0].status, st.queue[0].holdUntil], ['list', 'hold', 6000]);
  st = C.routeBadgeEvent(st, ev({ count: 2 }), 3000, id);
  assert.equal(st.queue.length, 1);
  assert.deepEqual([st.queue[0].count, st.queue[0].sender, st.queue[0].status], [2, 'Hong', 'ready']);
});

test('a candidate for another channel does not join', () => {
  let st = C.routeBadgeEvent(empty(), ev({ channel: 'instagram_direct' }), 1000, id);
  st = C.routeCandidate(st, cand({ channel: 'wec' }), 2000, id);
  assert.equal(st.queue.length, 2);
});

test('badge event released without detail is recorded for supplements', () => {
  let st = C.routeBadgeEvent(empty(), ev({ count: 1 }), 1000, id);
  st = C.releaseDue(st, 6000);
  assert.equal(st.queue[0].status, 'ready');
  assert.deepEqual(st.recent, [{ channel: 'wec', at: 6000, remaining: 1 }]);
});

test('late candidate within 2 minutes becomes one supplement, the next one a new notice', () => {
  let st = C.releaseDue(C.routeBadgeEvent(empty(), ev({ count: 1 }), 1000, id), 6000);
  st = C.routeCandidate(st, cand(), 60000, id);
  assert.deepEqual([st.queue[1].type, st.queue[1].status], ['supplement', 'ready']);
  assert.equal(st.recent[0].remaining, 0);
  st = C.routeCandidate(st, cand({ sender: 'Kim' }), 61000, id);
  assert.deepEqual([st.queue[2].type, st.queue[2].status], ['list', 'hold']);
});

test('a held badge event takes priority over a recent count notice', () => {
  let st = C.releaseDue(C.routeBadgeEvent(empty(), ev(), 1000, id), 6000);
  st = C.routeBadgeEvent(st, ev(), 20000, id);
  st = C.routeCandidate(st, cand(), 21000, id);
  assert.equal(st.queue.filter(q => q.type === 'supplement').length, 0);
  assert.equal(st.queue[1].sender, 'Hong');
  assert.equal(st.recent[0].remaining, 1);
});

test('candidate after the 2 minute window is a new notice and the record is dropped', () => {
  let st = C.releaseDue(C.routeBadgeEvent(empty(), ev(), 1000, id), 6000);
  st = C.releaseDue(st, 6000 + 120001);
  assert.deepEqual(st.recent, []);
  st = C.routeCandidate(st, cand(), 6000 + 120002, id);
  assert.equal(st.queue[st.queue.length - 1].type, 'list');
});

test('list-only item is released as a detailed notice and leaves no supplement record', () => {
  let st = C.releaseDue(C.routeCandidate(empty(), cand(), 1000, id), 6000);
  assert.equal(st.queue[0].status, 'ready');
  assert.deepEqual(st.recent, []);
});
