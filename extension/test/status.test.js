// UI 수정 기획서 6-3 상태 줄 판정과 6-4 점검표 완료 판정. 표의 줄마다 확인한다.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/status.js');

const NOW = 10_000_000;
const ALL_ON = {
  'https://business.facebook.com/*': true, 'https://hooks.slack.com/*': true,
  'https://api.deepl.com/*': true, 'https://api-free.deepl.com/*': true
};
const base = (o) => Object.assign({
  assetId: 'A1', lastHeartbeat: NOW - 10_000, lastSend: { at: NOW - 5000, outcome: 'ok', status: 200 },
  queueLength: 0, retryCount: 0, lastError: null, ownerTabId: 3,
  permissions: Object.assign({}, ALL_ON), slackEnabled: true, webhookSet: true, slackTestOkAt: NOW - 1000,
  detect: { everSeen: true, failing: false, failReason: null },
  deepl: { hasKey: true, free: false, checkedAt: NOW - 1000, ok: true, code: '', used: 10, limit: 100 }
}, o);
const off = (origin) => Object.assign({}, ALL_ON, { [origin]: false });
const pick = (r) => [r.tone, r.label];

// ---- 감지 ----
test('detect 1: no target account → gray 설정 필요', () => {
  assert.deepEqual(pick(S.detectStatus(base({ assetId: '' }), NOW)), ['gray', '설정 필요']);
});
test('detect 2: last signal was a failure → red 확인 필요', () => {
  assert.deepEqual(pick(S.detectStatus(base({ detect: { everSeen: true, failing: true, failReason: 'login' } }), NOW)), ['red', '확인 필요']);
});
test('detect 3: seen before and no healthy signal for more than 3 minutes → red 중단됨', () => {
  assert.deepEqual(pick(S.detectStatus(base({ lastHeartbeat: NOW - 180_001 }), NOW)), ['red', '중단됨']);
  assert.deepEqual(pick(S.detectStatus(base({ lastHeartbeat: NOW - 180_000 }), NOW)), ['yellow', '수신함 탭 확인']);
});
test('detect 4: a healthy signal within 90 seconds → green 정상', () => {
  assert.deepEqual(pick(S.detectStatus(base({ lastHeartbeat: NOW - 90_000 }), NOW)), ['green', '정상']);
});
test('detect 5: never opened, or quiet for 90s–3min → yellow 수신함 탭 확인', () => {
  assert.deepEqual(pick(S.detectStatus(base({ lastHeartbeat: 0, detect: { everSeen: false, failing: false, failReason: null } }), NOW)), ['yellow', '수신함 탭 확인']);
  assert.deepEqual(pick(S.detectStatus(base({ lastHeartbeat: NOW - 120_000 }), NOW)), ['yellow', '수신함 탭 확인']);
});
test('detect: rows are applied top-down (no account beats a failure)', () => {
  assert.equal(S.detectStatus(base({ assetId: '', detect: { everSeen: true, failing: true, failReason: 'login' } }), NOW).tone, 'gray');
});

// ---- Slack ----
test('slack 1: off → gray 사용 안 함, no webhook → gray 설정 필요', () => {
  assert.deepEqual(pick(S.slackStatus(base({ slackEnabled: false }))), ['gray', '사용 안 함']);
  assert.deepEqual(pick(S.slackStatus(base({ webhookSet: false }))), ['gray', '설정 필요']);
});
test('slack 2: hooks.slack.com access off → red 권한 필요, links to start', () => {
  const r = S.slackStatus(base({ permissions: off('https://hooks.slack.com/*') }));
  assert.deepEqual(pick(r), ['red', '권한 필요']);
  assert.equal(r.section, 'start');
});
test('slack 3: last send failed → red 확인 필요', () => {
  assert.deepEqual(pick(S.slackStatus(base({ lastSend: { at: 1, outcome: 'config', status: 404 } }))), ['red', '확인 필요']);
  assert.deepEqual(pick(S.slackStatus(base({ lastSend: { at: 1, outcome: 'retry', status: 0 } }))), ['red', '확인 필요']);
});
test('slack 4: items waiting for retry → yellow 재시도 중', () => {
  assert.deepEqual(pick(S.slackStatus(base({ retryCount: 2 }))), ['yellow', '재시도 중']);
});
test('slack 5: never sent → yellow 테스트 필요', () => {
  assert.deepEqual(pick(S.slackStatus(base({ lastSend: null }))), ['yellow', '테스트 필요']);
});
test('slack 6: last send ok → green 정상, links to slack', () => {
  const r = S.slackStatus(base());
  assert.deepEqual(pick(r), ['green', '정상']);
  assert.equal(r.section, 'slack');
});

// ---- 번역 ----
const dl = (o) => base({ deepl: Object.assign({}, base().deepl, o) });
test('translate 1: no key → gray 설정 필요', () => {
  assert.deepEqual(pick(S.translateStatus(dl({ hasKey: false }))), ['gray', '설정 필요']);
});
test('translate 2: access off for the key host → red 권한 필요 (free key checks api-free)', () => {
  const r = S.translateStatus(base({ permissions: off('https://api.deepl.com/*') }));
  assert.deepEqual(pick(r), ['red', '권한 필요']);
  assert.equal(r.section, 'start');
  assert.equal(S.translateStatus(base({ permissions: off('https://api.deepl.com/*'), deepl: Object.assign({}, base().deepl, { free: true }) })).tone, 'yellow');
  assert.equal(S.translateStatus(base({ permissions: off('https://api-free.deepl.com/*'), deepl: Object.assign({}, base().deepl, { free: true }) })).label, '권한 필요');
});
test('translate 3: last result was a key error or quota → red 확인 필요', () => {
  assert.deepEqual(pick(S.translateStatus(dl({ ok: false, code: 'BAD_KEY' }))), ['red', '확인 필요']);
  assert.deepEqual(pick(S.translateStatus(dl({ ok: false, code: 'QUOTA' }))), ['red', '확인 필요']);
});
test('translate 4: key saved but never checked → yellow 키 확인 필요', () => {
  assert.deepEqual(pick(S.translateStatus(dl({ checkedAt: 0, ok: false }))), ['yellow', '키 확인 필요']);
});
test('translate 5: usage at 90% or more → yellow 사용량 주의', () => {
  assert.deepEqual(pick(S.translateStatus(dl({ used: 90, limit: 100 }))), ['yellow', '사용량 주의']);
  assert.equal(S.translateStatus(dl({ used: 89, limit: 100 })).tone, 'green');
});
test('translate 6: free key → yellow 무료 키', () => {
  assert.deepEqual(pick(S.translateStatus(dl({ free: true }))), ['yellow', '무료 키']);
});
test('translate 7: key check ok → green 정상', () => {
  assert.deepEqual(pick(S.translateStatus(base())), ['green', '정상']);
});
test('translate: a failed check that is not a key error is not shown as healthy', () => {
  assert.equal(S.translateStatus(dl({ ok: false, code: 'RETRY' })).tone, 'yellow');
});

// ---- 6-4 점검표 ----
test('steps: all done when every condition holds', () => {
  assert.deepEqual(S.startSteps(base()).map((s) => s.state), ['done', 'done', 'done', 'done', 'done']);
  assert.equal(S.startSteps(base()).every((s) => s.state !== 'todo'), true);
});
test('steps: missing permission, webhook, account, key, test each leave that step open', () => {
  assert.equal(S.startSteps(base({ permissions: off('https://api-free.deepl.com/*') }))[0].state, 'todo');
  assert.equal(S.startSteps(base({ webhookSet: false }))[1].state, 'todo');
  assert.equal(S.startSteps(base({ assetId: '' }))[2].state, 'todo');
  assert.equal(S.startSteps(dl({ hasKey: false }))[3].state, 'todo');
  assert.equal(S.startSteps(base({ slackTestOkAt: 0 }))[4].state, 'todo');
});
test('steps: Slack off marks 2, 3, 5 as skipped (counted done) but not the DeepL key', () => {
  const st = S.startSteps(base({ slackEnabled: false, webhookSet: false, assetId: '', slackTestOkAt: 0, deepl: Object.assign({}, base().deepl, { hasKey: false }) }));
  assert.deepEqual(st.map((s) => s.state), ['done', 'skip', 'skip', 'todo', 'skip']);
});
