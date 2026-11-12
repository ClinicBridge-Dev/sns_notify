const test = require('node:test');
const assert = require('node:assert');
const W = require('../lib/watchdog.js');
const ws = (o = {}) => ({ lastHeartbeat: 0, everSeen: true, stoppedAlertSent: false, lastAlarmAt: 0, ...o });
const MIN = 60000;

test('no watching before the first heartbeat or without a target account', () => {
  assert.equal(W.watchdogTick(ws({ everSeen: false, lastAlarmAt: 9 * MIN }), '42', 10 * MIN).alert, null);
  assert.equal(W.watchdogTick(ws({ lastAlarmAt: 9 * MIN }), '', 10 * MIN).alert, null);
});

test('stopped alert once after more than 3 minutes of silence', () => {
  const r = W.watchdogTick(ws({ lastHeartbeat: 0, lastAlarmAt: 3 * MIN }), '42', 4 * MIN);
  assert.equal(r.alert, 'stopped');
  assert.equal(r.ws.stoppedAlertSent, true);
  assert.equal(W.watchdogTick(r.ws, '42', 5 * MIN).alert, null);
});

test('no alert at exactly 3 minutes', () => {
  assert.equal(W.watchdogTick(ws({ lastHeartbeat: MIN, lastAlarmAt: 3 * MIN }), '42', 4 * MIN).alert, null);
});

test('after a gap of 3 minutes or more between alarms, skip one round', () => {
  const r = W.watchdogTick(ws({ lastHeartbeat: 0, lastAlarmAt: MIN }), '42', 60 * MIN);
  assert.equal(r.alert, null);
  assert.equal(r.ws.lastAlarmAt, 60 * MIN);
  assert.equal(W.watchdogTick(r.ws, '42', 61 * MIN).alert, 'stopped');
});

test('heartbeat after a stopped alert reports resumed once', () => {
  const r = W.onHeartbeat(ws({ stoppedAlertSent: true }), 9 * MIN);
  assert.equal(r.alert, 'resumed');
  assert.deepEqual([r.ws.stoppedAlertSent, r.ws.lastHeartbeat, r.ws.everSeen], [false, 9 * MIN, true]);
  assert.equal(W.onHeartbeat(r.ws, 10 * MIN).alert, null);
});

// 추가: 다른 필드(channels, ownerTabId)는 그대로 남는다.
test('watchdog keeps other watcherState fields', () => {
  const base = ws({ channels: { wec: { base: 1 } }, ownerTabId: 7, lastAlarmAt: 3 * MIN });
  assert.deepEqual(W.watchdogTick(base, '42', 4 * MIN).ws.channels, { wec: { base: 1 } });
  assert.equal(W.onHeartbeat(base, 4 * MIN).ws.ownerTabId, 7);
});

// Fix round 1: 원인별 실패 경고가 나가 있으면 일반 중단 경고는 보내지 않는다(한 원인, 한 경고).
test('no generic stopped alert while a reason-specific failure alert is active', () => {
  assert.equal(W.watchdogTick(ws({ lastAlarmAt: 3 * MIN, failAlerts: ['selector'] }), '42', 4 * MIN).alert, null);
  assert.equal(W.watchdogTick(ws({ lastAlarmAt: 3 * MIN, failAlerts: [] }), '42', 4 * MIN).alert, 'stopped');
});
