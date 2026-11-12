const test = require('node:test');
const assert = require('node:assert');
const { applyBadgeReport } = require('../lib/badge.js');
const W = 3000;
const ch = (base, pending = null) => ({ base, known: true, pending });

test('first report ever only stores the baseline', () => {
  const r = applyBadgeReport({ base: 0, known: false, pending: null }, 4, 1000, W);
  assert.deepEqual(r, { ch: { base: 4, known: true, pending: null }, event: null });
});

test('increase creates one event with the difference', () => {
  const r = applyBadgeReport(ch(1), 3, 1000, W);
  assert.deepEqual(r, { ch: ch(3), event: { count: 2 } });
});

test('spec example 1: read everything, new message 10s later', () => {
  let r = applyBadgeReport(ch(2), 0, 0, W);
  assert.deepEqual(r, { ch: ch(2, { value: 0, at: 0 }), event: null });
  r = applyBadgeReport(r.ch, 1, 10000, W);
  assert.deepEqual(r, { ch: ch(1), event: { count: 1 } });
});

test('spec example 2: flicker returns within 3s, no event', () => {
  let r = applyBadgeReport(ch(2), 0, 0, W);
  r = applyBadgeReport(r.ch, 2, 1000, W);
  assert.deepEqual(r, { ch: ch(2), event: null });
});

test('spec example 3: new message during flicker', () => {
  let r = applyBadgeReport(ch(2), 0, 0, W);
  r = applyBadgeReport(r.ch, 3, 1000, W);
  assert.deepEqual(r, { ch: ch(3), event: { count: 1 } });
});

test('second decrease keeps the first timestamp and updates the value', () => {
  let r = applyBadgeReport(ch(3), 2, 0, W);
  r = applyBadgeReport(r.ch, 1, 1000, W);
  assert.deepEqual(r.ch, ch(3, { value: 1, at: 0 }));
});

test('pending is committed after 3s even when the value stays low', () => {
  let r = applyBadgeReport(ch(2), 0, 0, W);
  r = applyBadgeReport(r.ch, 0, 3001, W);
  assert.deepEqual(r, { ch: ch(0), event: null });
});

test('drop wait of 0 lowers the baseline on the next report', () => {
  let r = applyBadgeReport(ch(2), 0, 0, 0);
  r = applyBadgeReport(r.ch, 1, 1, 0);
  assert.deepEqual(r, { ch: ch(1), event: { count: 1 } });
});

const { handleBadgeState } = require('../lib/badge.js');
const { createSerialQueue } = require('../lib/serial.js');

test('reports applied through the serial queue equal sequential application', async () => {
  let stored = { channels: { instagram_direct: { base: 0, known: true, pending: null }, wec: { base: 0, known: true, pending: null } } };
  const events = [];
  const run = createSerialQueue();
  const report = (wec, at, delay) => run(async () => {
    const snapshot = stored;                              // read
    await new Promise(r => setTimeout(r, delay));         // slow storage
    const r = handleBadgeState(snapshot, { badges: { instagram_direct: 0, wec }, initial: false, userActionRecent: false, at }, at);
    stored = r.state; events.push(...r.events);           // write
  });
  await Promise.all([report(1, 0, 20), report(2, 10, 1), report(3, 20, 1)]);
  assert.equal(stored.channels.wec.base, 3);
  assert.deepEqual(events.map(e => e.count), [1, 1, 1]);
});

test('initial report above the baseline becomes an away event', () => {
  const state = { channels: { instagram_direct: { base: 0, known: true, pending: null }, wec: { base: 1, known: true, pending: null } } };
  const r = handleBadgeState(state, { badges: { instagram_direct: 0, wec: 4 }, initial: true, userActionRecent: false, at: 0 }, 0);
  assert.deepEqual(r.events, [{ channel: 'wec', count: 3, kind: 'away', manualHint: false, at: 0 }]);
});

test('malformed reports leave the state untouched', () => {
  const state = { channels: { wec: { base: 1, known: true, pending: null } } };
  for (const m of [null, {}, { badges: { instagram_direct: -1, wec: 0 } }, { badges: { instagram_direct: 0, wec: 'x' } }, { badges: { instagram_direct: 0 } }]) {
    assert.deepEqual(handleBadgeState(state, m, 0), { state, events: [] });
  }
});

test('does not mutate the input state', () => {
  const state = { channels: { instagram_direct: ch(0), wec: ch(0) } };
  const copy = JSON.parse(JSON.stringify(state));
  handleBadgeState(state, { badges: { instagram_direct: 0, wec: 2 }, initial: false, at: 0 }, 0);
  assert.deepEqual(state, copy);
});
