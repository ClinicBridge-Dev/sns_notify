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
  let fetchStatus = 200;
  let fetchJson = {};
  const urls = [];
  const denied = new Set(); // 사이트 액세스가 꺼진 origin 패턴
  let session = {};
  let optionsOpened = 0;
  const L = { msg: [], changed: [], connect: [], removed: [], startup: [], installed: [], alarm: [] };
  const ev = (arr) => ({ addListener: (f) => arr.push(f) });
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const chrome = {
    runtime: {
      id: EXT_ID, onMessage: ev(L.msg), onConnect: ev(L.connect), onStartup: ev(L.startup), onInstalled: ev(L.installed),
      openOptionsPage() { optionsOpened++; return Promise.resolve(); }
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
      onChanged: ev(L.changed),
      session: {
        get: async (keys) => { const o = {}; (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in session) o[k] = clone(session[k]); }); return o; },
        set: async (patch) => { Object.assign(session, clone(patch)); },
        remove: async (k) => { delete session[k]; }
      }
    },
    permissions: { contains: async ({ origins }) => origins.every((o) => !denied.has(o)) },
    tabs: { onRemoved: ev(L.removed) },
    alarms: { get: () => Promise.resolve({}), create() {}, onAlarm: ev(L.alarm) },
    action: { setBadgeText: ({ text }) => badgeTexts.push(text) }
  };
  const ctx = {
    chrome, console: { debug() {}, log() {} },
    setTimeout: () => 0, clearTimeout() {}, // 보류 해제 타이머 등은 돌리지 않는다
    fetch: async (url, init) => {
      urls.push(url);
      fetches.push(init.body ? JSON.parse(init.body) : null);
      if (fetchStatus === 0) throw new TypeError('Failed to fetch');
      return { status: fetchStatus, ok: fetchStatus === 200, headers: { get: () => null }, json: async () => clone(fetchJson) };
    },
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
  const setFetchStatus = (st) => { fetchStatus = st; };
  const setFetchJson = (j) => { fetchJson = j; };
  const deny = (origin) => denied.add(origin);
  return {
    store: () => store, writes, badgeTexts, fetches, urls, send, tabSender, settle, setSettings, setFetchStatus, setFetchJson, deny,
    session: () => session, optionsOpened: () => optionsOpened
  };
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

const optionsSender = { id: EXT_ID, url: 'chrome-extension://' + EXT_ID + '/options/options.html' };

test('test message is sent directly, never queued, even when the send fails', async () => {
  for (const status of [0, 429, 503]) {
    const env = makeEnv({ settings: SETTINGS() });
    await env.settle();
    env.setFetchStatus(status);
    const r = await env.send({ type: 'SEND_TEST_SLACK' }, optionsSender);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'FAILED');
    assert.equal(env.fetches.length, 1);
    assert.deepEqual(env.store().slackQueue || [], [], 'failed test message must not wait in the retry queue');
  }
});

test('test message config error is reported and recorded, not queued', async () => {
  const env = makeEnv({ settings: SETTINGS() });
  await env.settle();
  env.setFetchStatus(404);
  const r = await env.send({ type: 'SEND_TEST_SLACK' }, optionsSender);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CONFIG');
  assert.deepEqual(env.store().slackQueue || [], []);
  assert.equal(env.store().lastError.code, 'CONFIG');
});

test('test message success clears a previous Slack error and leaves the queue alone', async () => {
  const queued = { id: 'q1', type: 'badge', channel: 'wec', count: 1, badgeValue: 1, kind: 'new', manualHint: false, sender: null, preview: null, time: null, createdAt: Date.now(), status: 'hold', holdUntil: Date.now() + 60000, attempts: 0, nextTryAt: 0 };
  const env = makeEnv({ settings: SETTINGS(), slackQueue: [queued], lastError: { source: 'slack', code: 'CONFIG', message: 'x', status: 404, at: 1 } });
  await env.settle();
  const r = await env.send({ type: 'SEND_TEST_SLACK' }, optionsSender);
  assert.equal(r.ok, true);
  assert.equal(env.fetches.length, 1);
  assert.deepEqual(env.store().slackQueue.map((q) => q.id), ['q1']);
  assert.equal(env.store().lastError, null);
});

// ---- UI 수정 기획서 4-4: 대화별 번역 상태 { lang, on } ----
const OPT_SENDER = { id: EXT_ID, url: 'chrome-extension://' + EXT_ID + '/options/options.html' };

test('SET_THREAD_LANG stores { lang, on } and GET_THREAD_LANG returns it', async () => {
  const env = makeEnv({ settings: SETTINGS({ sendTargetLang: 'EN-US' }) });
  await env.settle();
  assert.deepEqual(await env.send({ type: 'SET_THREAD_LANG', threadId: 't1', lang: 'JA', on: false }, env.tabSender(1)), { ok: true });
  const e = env.store().threadLangs.t1;
  assert.equal(e.lang, 'JA'); assert.equal(e.on, false); assert.equal(typeof e.at, 'number');
  assert.deepEqual(await env.send({ type: 'GET_THREAD_LANG', threadId: 't1' }, env.tabSender(1)), { threadId: 't1', lang: 'JA', on: false });
});

test('SET_THREAD_LANG rejects a non-boolean on and the old "OFF" language', async () => {
  const env = makeEnv({ settings: SETTINGS() });
  await env.settle();
  for (const bad of [{ lang: 'JA' }, { lang: 'JA', on: 'false' }, { lang: 'JA', on: 0 }, { lang: 'OFF', on: false }, { lang: 'KO', on: true }]) {
    const r = await env.send(Object.assign({ type: 'SET_THREAD_LANG', threadId: 't1' }, bad), env.tabSender(1));
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  assert.equal((env.store().threadLangs || {}).t1, undefined);
});

test('GET_THREAD_LANG reads an old stored "OFF" as off with the default language', async () => {
  const env = makeEnv({ settings: SETTINGS({ sendTargetLang: 'VI' }), threadLangs: { old: { lang: 'OFF', at: 5 }, kept: { lang: 'JA', at: 6 } } });
  await env.settle();
  assert.deepEqual(await env.send({ type: 'GET_THREAD_LANG', threadId: 'old' }, env.tabSender(1)), { threadId: 'old', lang: 'VI', on: false });
  assert.deepEqual(await env.send({ type: 'GET_THREAD_LANG', threadId: 'kept' }, env.tabSender(1)), { threadId: 'kept', lang: 'JA', on: true });
  assert.deepEqual(await env.send({ type: 'GET_THREAD_LANG', threadId: 'none' }, env.tabSender(1)), { threadId: 'none', lang: 'VI', on: true });
});

// ---- UI 수정 기획서 7장 ----
test('7-3: OPEN_OPTIONS stores the requested section and opens the options page', async () => {
  const env = makeEnv({ settings: SETTINGS() });
  await env.settle();
  await env.send({ type: 'OPEN_OPTIONS', section: 'quick' }, env.tabSender(1));
  assert.equal(env.session().pendingOptionsSection, 'quick');
  assert.equal(env.optionsOpened(), 1);
  await env.send({ type: 'OPEN_OPTIONS', section: 'nope' }, env.tabSender(1));
  assert.equal(env.session().pendingOptionsSection, 'start');
  await env.send({ type: 'OPEN_OPTIONS' }, env.tabSender(1));
  assert.equal(env.session().pendingOptionsSection, 'start');
});

test('7-1: a DeepL network failure with site access off is PERMISSION_OFF, not "try later"', async () => {
  const env = makeEnv({ settings: SETTINGS({ deeplApiKey: 'k:fx' }) });
  await env.settle();
  env.setFetchStatus(0);
  env.deny('https://api-free.deepl.com/*');
  const r = await env.send({ type: 'TRANSLATE', text: 'hi', targetLang: 'KO', purpose: 'bubble' }, env.tabSender(1));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PERMISSION_OFF');
  assert.equal(r.message, '확장 프로그램의 사이트 액세스 권한이 꺼져 있습니다');
  const c = await env.send({ type: 'CHECK_DEEPL_KEY' }, OPT_SENDER);
  assert.equal(c.code, 'PERMISSION_OFF');
});

test('7-1: a DeepL network failure with site access on stays a retryable error', async () => {
  const env = makeEnv({ settings: SETTINGS({ deeplApiKey: 'k' }) });
  await env.settle();
  env.setFetchStatus(0);
  env.deny('https://api-free.deepl.com/*'); // 키는 유료(api.deepl.com)이므로 상관없다
  const r = await env.send({ type: 'TRANSLATE', text: 'hi', targetLang: 'KO', purpose: 'bubble' }, env.tabSender(1));
  assert.equal(r.code, 'RETRY');
});

test('7-1: a Slack test with site access off fails on the spot with PERMISSION_OFF and is not queued', async () => {
  const env = makeEnv({ settings: SETTINGS() });
  await env.settle();
  env.setFetchStatus(0);
  env.deny('https://hooks.slack.com/*');
  const r = await env.send({ type: 'SEND_TEST_SLACK' }, OPT_SENDER);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PERMISSION_OFF');
  assert.match(r.message, /사이트 액세스 권한이 꺼져 있습니다/);
  assert.equal((env.store().slackQueue || []).length, 0);
  assert.equal((env.store().statusInfo || {}).slackTestOkAt || 0, 0);
});

test('7-1: a real alert that fails with site access off stays queued and records PERMISSION_OFF', async () => {
  const item = { id: 'q1', type: 'system', channel: '', count: 0, kind: 'new', manualHint: false, sender: null, preview: null, time: null,
    text: 'x', createdAt: Date.now(), status: 'ready', holdUntil: null, attempts: 0, nextTryAt: 0 };
  const env = makeEnv({ settings: SETTINGS(), slackQueue: [item] });
  env.setFetchStatus(0);
  env.deny('https://hooks.slack.com/*');
  await env.settle();
  await env.send({ type: 'GET_STATUS' }, OPT_SENDER); // 메시지 처리 뒤 대기열을 보낸다
  await env.settle();
  assert.ok(env.fetches.length >= 1);
  assert.equal(env.store().slackQueue.length, 1);
  assert.equal(env.store().slackQueue[0].attempts, 1);
  assert.equal(env.store().lastError.code, 'PERMISSION_OFF');
});

test('7-2: a successful Slack test records slackTestOkAt; changing the webhook clears it', async () => {
  const env = makeEnv({ settings: SETTINGS() });
  await env.settle();
  const r = await env.send({ type: 'SEND_TEST_SLACK' }, OPT_SENDER);
  assert.equal(r.ok, true);
  assert.ok(env.store().statusInfo.slackTestOkAt > 0);
  await env.setSettings({ slackEnabled: false });
  assert.ok(env.store().statusInfo.slackTestOkAt > 0, 'other settings keep it');
  await env.setSettings({ slackWebhookUrl: 'https://hooks.slack.com/services/T/B/Y' });
  await env.settle();
  assert.equal(env.store().statusInfo.slackTestOkAt, 0);
});

test('7-2: CHECK_DEEPL_KEY stores the result; a key change resets it', async () => {
  const env = makeEnv({ settings: SETTINGS({ deeplApiKey: 'k' }) });
  await env.settle();
  env.setFetchJson({ character_count: 30, character_limit: 100 });
  await env.send({ type: 'CHECK_DEEPL_KEY' }, OPT_SENDER);
  const d = env.store().statusInfo.deepl;
  assert.ok(d.checkedAt > 0); assert.equal(d.ok, true); assert.equal(d.used, 30); assert.equal(d.limit, 100);
  await env.setSettings({ deeplApiKey: 'k2' });
  await env.settle();
  assert.deepEqual(env.store().statusInfo.deepl, { checkedAt: 0, ok: false, code: '', used: 0, limit: 0 });
});

test('7-2: TRANSLATE key errors mark the DeepL state; a later success marks it ok and keeps usage', async () => {
  const env = makeEnv({ settings: SETTINGS({ deeplApiKey: 'k' }) });
  await env.settle();
  env.setFetchJson({ character_count: 30, character_limit: 100 });
  await env.send({ type: 'CHECK_DEEPL_KEY' }, OPT_SENDER);
  env.setFetchStatus(456);
  await env.send({ type: 'TRANSLATE', text: 'hi', targetLang: 'KO', purpose: 'bubble' }, env.tabSender(1));
  assert.equal(env.store().statusInfo.deepl.ok, false);
  assert.equal(env.store().statusInfo.deepl.code, 'QUOTA');
  env.setFetchStatus(200);
  env.setFetchJson({ translations: [{ text: '안녕', detected_source_language: 'EN' }] });
  const r = await env.send({ type: 'TRANSLATE', text: 'hi', targetLang: 'KO', purpose: 'bubble' }, env.tabSender(1));
  assert.equal(r.ok, true);
  const d = env.store().statusInfo.deepl;
  assert.equal(d.ok, true); assert.equal(d.used, 30); assert.equal(d.limit, 100);
});

test('7-2: GET_STATUS adds permissions, DeepL and Slack state, retry count and detection, without secrets', async () => {
  const env = makeEnv({
    settings: SETTINGS({ deeplApiKey: 'secret:fx' }),
    slackQueue: [{ id: 'a', attempts: 0, createdAt: Date.now(), status: 'ready', nextTryAt: Date.now() + 3600000 }, { id: 'b', attempts: 2, createdAt: Date.now(), status: 'ready', nextTryAt: Date.now() + 3600000 }],
    watcherState: { channels: {}, ownerTabId: null, lastHeartbeat: 5, everSeen: true, stoppedAlertSent: false, lastAlarmAt: 0, failAlerts: ['login'], inboxTabIds: [] }
  });
  await env.settle();
  env.deny('https://hooks.slack.com/*');
  const st = await env.send({ type: 'GET_STATUS' }, OPT_SENDER);
  assert.deepEqual(st.permissions, {
    'https://business.facebook.com/*': true, 'https://hooks.slack.com/*': false,
    'https://api.deepl.com/*': true, 'https://api-free.deepl.com/*': true
  });
  assert.equal(st.deepl.hasKey, true); assert.equal(st.deepl.free, true); assert.equal(st.deepl.checkedAt, 0);
  assert.equal(st.webhookSet, true); assert.equal(st.slackEnabled, true); assert.equal(st.slackTestOkAt, 0);
  assert.equal(st.retryCount, 1); assert.equal(st.queueLength, 2);
  assert.deepEqual(st.detect, { everSeen: true, failing: true, failReason: 'login' });
  const raw = JSON.stringify(st);
  assert.equal(raw.indexOf('secret'), -1);
  assert.equal(raw.indexOf('hooks.slack.com/services'), -1);
});

// ---- UI 수정 기획서 12장: 내보내는 시점의 배지 숫자 ----
test('12-4: a queued alert is sent with the badge counts as they are at send time', async () => {
  const item = { id: 'q1', type: 'badge', channel: 'instagram_direct', count: 1, kind: 'new', manualHint: false, sender: null, preview: null,
    time: null, badgeValue: 1, createdAt: Date.now(), status: 'ready', holdUntil: null, attempts: 0, nextTryAt: 0 };
  const env = makeEnv({
    settings: SETTINGS(), slackQueue: [item],
    watcherState: { channels: { instagram_direct: { base: 3, known: true, pending: null }, wec: { base: 0, known: false, pending: null } },
      ownerTabId: null, lastHeartbeat: 0, everSeen: false, stoppedAlertSent: false, lastAlarmAt: 0, failAlerts: [], inboxTabIds: [] }
  });
  await env.settle();
  await env.send({ type: 'GET_STATUS' }, OPT_SENDER);
  await env.settle();
  const sent = env.fetches.find((f) => f && /새 메시지/.test(f.text));
  assert.ok(sent, 'alert sent');
  assert.match(sent.text, /^\[Instagram\] 새 메시지 · 미확인 대화 3개/);
  assert.match(sent.text, /미확인 현황: Instagram 3 · WhatsApp -/);
});
