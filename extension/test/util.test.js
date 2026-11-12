const test = require('node:test');
const assert = require('node:assert');

global.self = global;
global.MBX = { sel: require('../content/selectors.js').sel };
global.chrome = { runtime: { id: 'x', lastError: null, sendMessage() {} } };
require('../content/util.js');
const util = global.MBX.util;

function stub(fn) { global.chrome.runtime.sendMessage = fn; }

test('send: undefined response is ok, no notice', async () => {
  stub((m, cb) => cb(undefined));
  assert.deepEqual(await util.send('OPEN_OPTIONS'), { ok: true });
  assert.equal(util._test.noticeShown(), false);
});

test('send: real response passes through', async () => {
  stub((m, cb) => cb({ ok: true, text: 'a' }));
  assert.deepEqual(await util.send('TRANSLATE', { text: 'x' }), { ok: true, text: 'a' });
});

test('send: lastError -> DISCONNECTED and notice', async () => {
  stub((m, cb) => { global.chrome.runtime.lastError = { message: 'gone' }; cb(undefined); global.chrome.runtime.lastError = null; });
  assert.deepEqual(await util.send('X'), { ok: false, code: 'DISCONNECTED' });
  assert.equal(util._test.noticeShown(), true);
});

test('send: thrown error and missing runtime id -> DISCONNECTED', async () => {
  stub(() => { throw new Error('Extension context invalidated'); });
  assert.equal((await util.send('X')).code, 'DISCONNECTED');
  global.chrome.runtime.id = undefined;
  assert.equal((await util.send('X')).code, 'DISCONNECTED');
});
