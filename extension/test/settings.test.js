const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/settings.js');
const EXT = 'abcdefghijklmnopabcdefghijklmnop';

test('publicSettings removes both secrets and keeps the rest', () => {
  const p = S.publicSettings({ ...S.DEFAULT_SETTINGS, slackWebhookUrl: 'https://hooks.slack.com/services/x', deeplApiKey: 'k:fx' });
  assert.equal('slackWebhookUrl' in p, false);
  assert.equal('deeplApiKey' in p, false);
  assert.equal(p.sendTargetLang, 'EN-US');
});

test('classifySender', () => {
  assert.equal(S.classifySender({ id: EXT, tab: { id: 1, url: 'https://business.facebook.com/latest/inbox/wec?asset_id=1' } }, EXT), 'content');
  assert.equal(S.classifySender({ id: EXT, url: `chrome-extension://${EXT}/options/options.html` }, EXT), 'options');
  assert.equal(S.classifySender({ id: EXT, tab: { id: 1, url: 'https://www.facebook.com/' } }, EXT), 'reject');
  assert.equal(S.classifySender({ id: 'other', url: `chrome-extension://${EXT}/options/options.html` }, EXT), 'reject');
});

test('isAllowed separates content and options messages', () => {
  assert.equal(S.isAllowed('TRANSLATE', 'content'), true);
  assert.equal(S.isAllowed('SEND_TEST_SLACK', 'content'), false);
  assert.equal(S.isAllowed('SEND_TEST_SLACK', 'options'), true);
  assert.equal(S.isAllowed('GET_QUICK_REPLIES', 'content'), true);
  assert.equal(S.isAllowed('GET_QUICK_REPLIES', 'options'), true);
  assert.equal(S.isAllowed('BADGE_STATE', 'options'), false);
});

test('classifySender: options page with sender.tab (open_in_tab)', () => {
  const optionsUrl = `chrome-extension://${EXT}/options/options.html`;
  assert.equal(S.classifySender({ id: EXT, tab: { id: 2, url: optionsUrl }, url: optionsUrl }, EXT), 'options');
  assert.equal(S.classifySender({ id: EXT, url: optionsUrl + '#x' }, EXT), 'options');
  assert.equal(S.classifySender({ id: EXT, url: optionsUrl + 'evil' }, EXT), 'reject');
});

test('classifySender: lookalike host and missing id are rejected', () => {
  assert.equal(S.classifySender({ id: EXT, tab: { id: 1, url: 'https://business.facebook.com.evil.com/latest/inbox' } }, EXT), 'reject');
  assert.equal(S.classifySender({ tab: { id: 1, url: 'https://business.facebook.com/latest/inbox' } }, EXT), 'reject');
});
