const test = require('node:test');
const assert = require('node:assert');
const { chooseOwner } = require('../lib/owner.js');
const T = 90000;
const tab = (tabId, o = {}) => ({ tabId, assetId: '42', path: '/latest/inbox/wec', lastSeen: 0, ...o });

test('keeps the current owner while it is eligible and alive', () => {
  assert.equal(chooseOwner(1, [tab(1, { lastSeen: 50000 }), tab(2, { lastSeen: 99000 })], '42', 100000, T), 1);
});

test('hands over when the owner is silent for more than 90s', () => {
  assert.equal(chooseOwner(1, [tab(1, { lastSeen: 0 }), tab(2, { lastSeen: 95000 })], '42', 100000, T), 2);
});

test('hands over when the owner left the inbox or switched account, or is gone', () => {
  assert.equal(chooseOwner(1, [tab(1, { path: '/latest/home' }), tab(2)], '42', 0, T), 2);
  assert.equal(chooseOwner(1, [tab(1, { assetId: '99' }), tab(2)], '42', 0, T), 2);
  assert.equal(chooseOwner(1, [tab(2)], '42', 0, T), 2);
});

test('no eligible tab means no owner', () => {
  assert.equal(chooseOwner(1, [tab(3, { assetId: '99' })], '42', 0, T), null);
  assert.equal(chooseOwner(null, [], '42', 0, T), null);
});

// 추가: 대기 탭은 생존 신호를 보내지 않으므로 lastSeen이 멈춘 담당보다 오래됐을 수 있다.
test('a timed-out owner yields to another candidate even if that one was seen earlier', () => {
  assert.equal(chooseOwner(1, [tab(1, { lastSeen: 500000 }), tab(2, { lastSeen: 0 })], '42', 600000, T), 2);
  assert.equal(chooseOwner(1, [tab(1, { lastSeen: 0 })], '42', 600000, T), 1, 'only candidate stays');
});

test('no target account means no owner even for tabs without asset_id', () => {
  assert.equal(chooseOwner(null, [tab(1, { assetId: '' })], '', 0, T), null);
});
