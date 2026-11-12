// util.js sendHello: 수신함 밖에서는 새로 연결하지 않고, 이미 연결된 탭이 수신함을 벗어나면 새 경로로 HELLO를 보낸다.
const test = require('node:test');
const assert = require('node:assert');

global.self = global;
const realSel = require('../content/selectors.js').sel;
global.MBX = { sel: Object.assign({}, realSel, { channelTabs: () => [] }) };
global.location = { pathname: '/latest/home', href: 'https://business.facebook.com/latest/home?asset_id=42' };
const posted = [];
let connects = 0;
global.chrome = { runtime: { id: 'x', lastError: null, sendMessage() {}, connect() {
  connects++;
  return { postMessage: (m) => posted.push(m), onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {} };
} } };
require('../content/util.js');
const hello = global.MBX.util._test.sendHello;
const go = (path) => { location.pathname = path; location.href = 'https://business.facebook.com' + path + '?asset_id=42'; hello(); };

test('off-inbox without a port does not connect', () => {
  go('/latest/home');
  assert.equal(connects, 0);
  assert.equal(posted.length, 0);
});

test('inbox connects and says HELLO once per (asset_id, path)', () => {
  go('/latest/inbox/wec');
  go('/latest/inbox/wec');
  assert.equal(connects, 1);
  assert.deepEqual(posted.map(m => m.path), ['/latest/inbox/wec']);
});

test('leaving the inbox with a live port reports the new path once', () => {
  go('/latest/home');
  go('/latest/home');
  assert.equal(connects, 1);
  assert.deepEqual(posted.map(m => [m.type, m.asset_id, m.path]), [['HELLO', '42', '/latest/inbox/wec'], ['HELLO', '42', '/latest/home']]);
});
