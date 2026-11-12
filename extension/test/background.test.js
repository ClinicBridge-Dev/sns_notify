// background.js 배선 테스트. chrome API를 흉내 낸 vm 컨텍스트에서 실제 background.js 와 lib 파일을 돌린다.
// 다루는 것: Slack 꺼짐/주소 없음 처리(Ruling 13), 관련 없는 탭의 로그인 경고(최종 검토 8번), 대상 계정 변경 시 기준값 초기화(9번).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const EXT = path.join(__dirname, '..');
const EXT_ID = 'extid';

function makeEnv(initial) {
  let store = JSON.parse(JSON.stringify(initial || {}));
  const writes = [];
  const badgeTexts = [];
  const fetches = [];
  const L = { msg: [], changed: [], connect: [], removed: [], startup: [], installed: [], alarm: [] };
  const ev = (arr) => ({ addListener: (f) => arr.push(f) });
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const chrome = {
    runtime: {
      id: EXT_ID, onMessage: ev(L.msg), onConnect: ev(L.connect), onStartup: ev(L.startup), onInstalled: ev(L.installed),
      openOptionsPage() {}
    },
    storage: {
      local: {
        setAccessLevel: () => Promise.resolve(),
        get: async (keys) => { const o = {}; (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) o[k] = clone(store[k]); }); return o; },
        set: async (patch) => {
          const changes = {};
          Object.keys(patch).forEach((k) => { changes[k] = { oldValue: clone(store[k]), newValue: clone(patch[k]) }; store[k] = clone(patch[k]); });
          writes.push(Object.keys(patch));
          setImmediate(() => L.changed.forEach((f) => f(changes, 'local')));
        }
      },
      onChanged: ev(L.changed)
    },
    tabs: { onRemoved: ev(L.removed) },
    alarms: { get: () => Promise.resolve({}), create() {}, onAlarm: ev(L.alarm) },
    action: { setBadgeText: ({ text }) => badgeTexts.push(text) }
  };
  const ctx = {
    chrome, console: { debug() {}, log() {} },
    setTimeout: () => 0, clearTimeout() {}, // 보류 해제 타이머 등은 돌리지 않는다
    fetch: async (url, init) => { fetches.push(JSON.parse(init.body)); return { status: 200, ok: true, headers: { get: () => null } }; },
    crypto: { randomUUID: () => 'id-' + Math.random().toString(36).slice(2) },
    AbortController, URL, Promise, Date, Math, JSON, Object, Array, Number, String, Set, Map
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx, { filename: f }));
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });

  const settle = () => new Promise((r) => setTimeout(r, 30));
  const tabSender = (tabId) => ({ id: EXT_ID, tab: { id: tabId, url: 'https://business.facebook.com/latest/inbox/wec' } });
  async function send(msg, sender) {
    const res = await new Promise((resolve) => L.msg[0](msg, sender, resolve));
    await settle();
    return res;
  }
  async function setSettings(patch) {
    const s = Object.assign({}, store.settings, patch);
    await chrome.storage.local.set({ settings: s });
    await settle();
  }
  return { store: () => store, writes, badgeTexts, fetches, send, tabSender, settle, setSettings };
}

const SETTINGS = (o) => Object.assign({
  slackEnabled: true, slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X', assetId: 'A1', accountName: '',
  slackPreviewMaxLen: 100, slackMaskPhone: false
}, o);
const badge = (asset, wec, initial) => ({ type: 'BADGE_STATE', asset_id: asset, badges: { instagram_direct: 0, wec }, initial: !!initial, userActionRecent: false, at: Date.now() });
const hb = (o) => Object.assign({ type: 'HEARTBEAT', asset_id: 'A1', path: '/latest/inbox/wec' }, o);

async function becomeOwner(env, tabId, asset) {
  await env.send(hb({ ok: true, asset_id: asset || 'A1' }), env.tabSender(tabId));
  assert.equal(env.store().watcherState.ownerTabId, tabId);
}

test('Ruling 13: slackEnabled=false is a silent skip (no lastError, no "!")', async () => {
  const env = makeEnv({ settings: SETTINGS({ slackEnabled: false, slackWebhookUrl: '' }) });
  await env.settle();
  await becomeOwner(env, 5);
  await env.send(badge('A1', 1, true), env.tabSender(5));
  await env.send(badge('A1', 2), env.tabSender(5));
  await env.send(hb({ ok: false, reason: 'selector' }), env.tabSender(6));
  assert.equal(env.store().lastError, null);
  assert.ok(!env.badgeTexts.includes('!'), 'badge: ' + env.badgeTexts.join(','));
  assert.deepEqual(env.store().slackQueue, []);
});

test('Ruling 13: empty webhook is "not configured" and lastError is written once, not on every event', async () => {
  const env = makeEnv({ settings: SETTINGS({ slackWebhookUrl: '' }) });
  await env.settle();
  env.writes.length = 0; // 시작 시 기본값 저장은 세지 않는다
  await becomeOwner(env, 5);
  await env.send(badge('A1', 0, true), env.tabSender(5));
  for (const v of [1, 2, 3]) await env.send(badge('A1', v), env.tabSender(5));
  assert.equal(env.store().lastError.code, 'NOT_CONFIGURED');
  assert.equal(env.writes.filter((w) => w.includes('lastError')).length, 1);
  assert.ok(env.badgeTexts.includes('!'));
  // Slack 을 끄면 더는 맞지 않는 설정 필요 상태를 지운다
  await env.setSettings({ slackEnabled: false });
  assert.equal(env.store().lastError, null);
  assert.equal(env.badgeTexts[env.badgeTexts.length - 1], '');
});

test('item 8: a login/password screen in an unrelated Business tab does not send a Slack warning', async () => {
  const env = makeEnv({ settings: SETTINGS() });
  await env.settle();
  await env.send(hb({ ok: false, reason: 'login', path: '/settings/security' }), env.tabSender(9));
  await env.send(hb({ ok: false, reason: 'login', path: '/login/' }), env.tabSender(9)); // 수신함이었던 적 없는 탭
  assert.equal(env.fetches.length, 0);
  assert.deepEqual(env.store().watcherState.failAlerts, []);
});

test('item 8: the owner inbox tab redirected to /login still sends the login warning', async () => {
  const env = makeEnv({ settings: SETTINGS() });
  await env.settle();
  await becomeOwner(env, 5);
  await env.send(hb({ ok: false, reason: 'login', path: '/login/' }), env.tabSender(5));
  assert.equal(env.fetches.length, 1);
  assert.match(env.fetches[0].text, /로그인/);
});

test('item 9: changing the target account resets badge bases (no false "자리 비운 사이" alert)', async () => {
  const env = makeEnv({ settings: SETTINGS() });
  await env.settle();
  await becomeOwner(env, 5);
  await env.send(badge('A1', 1, true), env.tabSender(5)); // 기준값 1
  assert.equal(env.store().watcherState.channels.wec.base, 1);
  // options 에서 대상 계정을 바꿈
  await env.setSettings({ assetId: 'B2' });
  assert.equal(env.store().watcherState.channels.wec.known, false);
  await becomeOwner(env, 5, 'B2');
  await env.send(badge('B2', 7, true), env.tabSender(5)); // 새 계정의 첫 보고: 기준값만
  const q = env.store().slackQueue;
  assert.equal(q.filter((it) => it.kind === 'away').length, 0, JSON.stringify(q));
  assert.equal(env.fetches.filter((f) => /자리 비운/.test(f.text)).length, 0);
});

test('item 9: SET_ASSET_FROM_OPEN_TAB resets bases in the same save', async () => {
  const env = makeEnv({ settings: SETTINGS() });
  await env.settle();
  await becomeOwner(env, 5);
  await env.send(badge('A1', 4, true), env.tabSender(5));
  await env.send(hb({ ok: true, asset_id: 'B2' }), env.tabSender(6));
  const opt = { id: EXT_ID, url: 'chrome-extension://' + EXT_ID + '/options/options.html' };
  const r = await env.send({ type: 'SET_ASSET_FROM_OPEN_TAB', assetId: 'B2' }, opt);
  assert.equal(r.ok, true);
  assert.equal(env.store().settings.assetId, 'B2');
  assert.deepEqual(env.store().watcherState.channels.wec, { base: 0, known: false, pending: null });
  assert.equal(env.store().watcherState.channelsAsset, 'B2');
});

test('Ruling 11: two +1 badge events in the same minute are queued with distinct badge values and dedup keys', async () => {
  const env = makeEnv({ settings: SETTINGS() });
  await env.settle();
  await becomeOwner(env, 5);
  await env.send(badge('A1', 2, true), env.tabSender(5));
  await env.send(badge('A1', 3), env.tabSender(5));
  await env.send(badge('A1', 4), env.tabSender(5));
  const q = env.store().slackQueue.filter((it) => it.type === 'badge');
  assert.deepEqual(q.map((it) => [it.count, it.badgeValue]), [[1, 3], [1, 4]]);
  const K = require('../lib/slack.js');
  const now = Date.now();
  assert.notEqual(K.dedupKey(q[0], now), K.dedupKey(q[1], now));
});
