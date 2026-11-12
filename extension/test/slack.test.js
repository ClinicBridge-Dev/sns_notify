const test = require('node:test');
const assert = require('node:assert');
const K = require('../lib/slack.js');
const settings = { accountName: '', slackPreviewMaxLen: 100, slackMaskPhone: true };
const base = { id: '1', type: 'badge', channel: 'wec', count: 1, kind: 'new', manualHint: false, sender: 'Hong Gildong', preview: '예약 가능한 시간이 궁금합니다', time: '2:02 PM', createdAt: 0 };
const allText = (p) => JSON.stringify(p);

test('maskPhone keeps the last four digits of numeric names only', () => {
  assert.equal(K.maskPhone('821012345678'), '********5678');
  assert.equal(K.maskPhone('+82 10-1234-5678'), '+** **-****-5678');
  assert.equal(K.maskPhone('Hong Gildong'), 'Hong Gildong');
});

test('escapeSlackText escapes &, <, >', () => {
  assert.equal(K.escapeSlackText('a & <b>'), 'a &amp; &lt;b&gt;');
});

test('detailed notice: channel label, sender, preview, inbox link without thread id', () => {
  const p = K.buildSlackPayload(base, settings, 0);
  assert.match(p.text, /^\[WhatsApp\] 새 메시지/);
  assert.match(p.text, /보낸 사람: Hong Gildong/);
  assert.match(p.text, /내용: 예약 가능한 시간이 궁금합니다/);
  assert.match(p.text, /https:\/\/business\.facebook\.com\/latest\/inbox\/wec/);
  assert.doesNotMatch(p.text, /selected_item_id/);
  assert.ok(Array.isArray(p.blocks) && p.blocks.length > 0);
});

test('account name is prefixed when set', () => {
  const p = K.buildSlackPayload(base, { ...settings, accountName: '테스트의원' }, 0);
  assert.match(p.text, /^\[테스트의원\]\[WhatsApp\] 새 메시지/);
});

test('count-only notice names where to look and shows the count', () => {
  const p = K.buildSlackPayload({ ...base, channel: 'instagram_direct', count: 3, sender: null, preview: null }, settings, 0);
  assert.match(p.text, /^\[Instagram\] 새 메시지 3건/);
  assert.match(p.text, /수신함의 Instagram 탭에서 확인하세요/);
});

test('manual hint is added only to count-only notices', () => {
  const countOnly = K.buildSlackPayload({ ...base, manualHint: true, sender: null, preview: null }, settings, 0);
  assert.match(countOnly.text, /수동으로 읽지 않음 표시한 것일 수 있음/);
  const detailed = K.buildSlackPayload({ ...base, manualHint: true }, settings, 0);
  assert.doesNotMatch(detailed.text, /수동으로 읽지 않음/);
});

test('away, supplement and unsupported-type wording', () => {
  assert.match(K.buildSlackPayload({ ...base, kind: 'away', count: 4, sender: null, preview: null }, settings, 0).text, /자리 비운 사이 새 메시지 4건/);
  const sup = K.buildSlackPayload({ ...base, type: 'supplement' }, settings, 0);
  assert.match(sup.text, /방금 \[WhatsApp\] 알림의 상세/);
  assert.doesNotMatch(sup.text, /새 메시지/);
  assert.match(K.buildSlackPayload({ ...base, preview: "*Message can't be displayed* ..." }, settings, 0).text, /수신함에서 표시되지 않는 유형입니다\. WhatsApp Business 앱에서 확인하세요/);
});

test('preview is cut to slackPreviewMaxLen and phone names are masked', () => {
  const p = K.buildSlackPayload({ ...base, sender: '821012345678', preview: 'Z'.repeat(300) }, settings, 0);
  assert.match(p.text, /보낸 사람: \*{8}5678/);
  assert.equal((p.text.match(/Z/g) || []).length, 100);
});

test('customer text cannot trigger mentions or links', () => {
  const p = K.buildSlackPayload({ ...base, sender: '<!here>', preview: '<!channel> <https://evil.example|click> & more' }, settings, 0);
  assert.doesNotMatch(p.text, /<!channel>|<!here>|<https:\/\/evil/);
  assert.match(p.text, /&lt;!channel&gt;/);
  const customerBlocks = p.blocks.flatMap(b => [b.text, ...(b.fields || []), ...(b.elements || [])].filter(Boolean));
  for (const t of customerBlocks) if (/channel|here|evil/.test(t.text)) assert.equal(t.type, 'plain_text');
  assert.ok(allText(p).includes('evil.example'));
});

test('dedup key: same detailed item matches, badge-only key changes per minute and value', () => {
  assert.equal(K.dedupKey(base, 0), K.dedupKey({ ...base, id: '2' }, 999999));
  const b = { ...base, sender: null, preview: null, count: 2, badgeValue: 2 };
  assert.equal(K.dedupKey(b, 60000), K.dedupKey(b, 119999));
  assert.notEqual(K.dedupKey(b, 60000), K.dedupKey(b, 120000));
  assert.notEqual(K.dedupKey(b, 0), K.dedupKey({ ...b, badgeValue: 3 }, 0));
});

test('Ruling 11: count-only key uses the absolute badge value, not the delta count', () => {
  const b = { ...base, id: 'x1', sender: null, preview: null, count: 1, kind: 'new' };
  // 같은 분 안의 +1 두 번(배지 3, 4)은 서로 다른 알림이다
  assert.notEqual(K.dedupKey({ ...b, badgeValue: 3 }, 60000), K.dedupKey({ ...b, id: 'x2', badgeValue: 4 }, 60001));
  // 같은 배지 값, 같은 분이면 중복
  assert.equal(K.dedupKey({ ...b, badgeValue: 3 }, 60000), K.dedupKey({ ...b, id: 'x2', badgeValue: 3, count: 2 }, 60001));
  // 배지 값이 없는 항목(이전 버전 대기열)은 서로 겹치지 않는다
  assert.notEqual(K.dedupKey({ ...b, id: 'a' }, 0), K.dedupKey({ ...b, id: 'b' }, 0));
  // 상세 항목 키는 배지 값과 무관하다
  assert.equal(K.dedupKey({ ...base, badgeValue: 3 }, 0), K.dedupKey({ ...base, badgeValue: 9 }, 0));
});

test('duplicate window is 10 minutes, sent keys expire after 24h', () => {
  const keys = [{ key: 'k', at: 0 }];
  assert.equal(K.isDuplicate(keys, 'k', 599999), true);
  assert.equal(K.isDuplicate(keys, 'k', 600001), false);
  assert.deepEqual(K.pruneSentKeys(keys, 86400001), []);
});

test('status classes and retry schedule', () => {
  assert.equal(K.classifyStatus(200), 'ok');
  for (const s of [0, 429, 500, 503]) assert.equal(K.classifyStatus(s), 'retry');
  for (const s of [400, 403, 404]) assert.equal(K.classifyStatus(s), 'config');
  assert.deepEqual([0, 1, 2, 3, 9].map(a => K.nextRetryDelayMs(a, null)), [30000, 120000, 600000, 600000, 600000]);
  assert.equal(K.nextRetryDelayMs(0, 45), 45000);
});

test('sender is cut to 100 characters', () => {
  const p = K.buildSlackPayload({ ...base, sender: 'S'.repeat(300) }, settings, 0);
  assert.ok(!allText(p).includes('S'.repeat(101)));
  assert.ok(allText(p).includes('S'.repeat(100) + '...'));
});

test('Ruling 13: slackConfigState — disabled is a silent skip, only an empty webhook is not configured', () => {
  assert.equal(K.slackConfigState({ slackEnabled: false, slackWebhookUrl: '' }), 'disabled');
  assert.equal(K.slackConfigState({ slackEnabled: false, slackWebhookUrl: 'https://hooks.slack.com/services/x' }), 'disabled');
  assert.equal(K.slackConfigState({ slackEnabled: true, slackWebhookUrl: '' }), 'missing');
  assert.equal(K.slackConfigState({ slackEnabled: true, slackWebhookUrl: '  ' }), 'missing');
  assert.equal(K.slackConfigState({ slackEnabled: true, slackWebhookUrl: 'https://hooks.slack.com/services/x' }), 'ok');
});

test('Ruling 13: notConfiguredUpdate writes lastError only when it changes', () => {
  const nc = { source: 'slack', code: 'NOT_CONFIGURED', message: 'm', status: null, at: 1 };
  assert.equal(K.needsNotConfiguredWrite(nc), false); // 이미 같은 상태: 다시 쓰지 않는다(at 갱신 없음)
  assert.equal(K.needsNotConfiguredWrite(null), true);
  assert.equal(K.needsNotConfiguredWrite({ source: 'slack', code: 'CONFIG', status: 404, at: 1 }), true);
  // 설정 필요 상태가 더는 맞지 않으면 지운다(Slack 끔이거나 주소가 생김). 다른 오류는 그대로 둔다.
  assert.equal(K.staleNotConfigured(nc, { slackEnabled: false, slackWebhookUrl: '' }), true);
  assert.equal(K.staleNotConfigured(nc, { slackEnabled: true, slackWebhookUrl: 'https://hooks.slack.com/services/x' }), true);
  assert.equal(K.staleNotConfigured(nc, { slackEnabled: true, slackWebhookUrl: '' }), false);
  assert.equal(K.staleNotConfigured({ source: 'slack', code: 'CONFIG' }, { slackEnabled: false }), false);
  assert.equal(K.staleNotConfigured(null, { slackEnabled: false }), false);
});
