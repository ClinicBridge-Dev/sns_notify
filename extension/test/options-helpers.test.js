// 설정 화면 순수 함수(options/helpers.js).
const test = require('node:test');
const assert = require('node:assert');
const H = require('../options/helpers.js');
const slack = require('../lib/slack.js');

test('sectionFromHash: known hashes map to menus, empty or unknown → start', () => {
  assert.equal(H.sectionFromHash('#slack'), 'slack');
  assert.equal(H.sectionFromHash('quick'), 'quick');
  assert.equal(H.sectionFromHash('#help'), 'help');
  assert.equal(H.sectionFromHash(''), 'start');
  assert.equal(H.sectionFromHash('#nope'), 'start');
  assert.equal(H.sectionFromHash(undefined), 'start');
});

test('previewLenChoices keeps a stored custom value so opening the page does not rewrite it', () => {
  assert.ok(H.previewLenChoices(100).includes(100));
  const c = H.previewLenChoices(123);
  assert.ok(c.includes(123));
  assert.deepEqual(c, [...c].sort((a, b) => a - b));
  assert.ok(!H.previewLenChoices(0).includes(0)); // 0 은 buildSlackPayload 에서 100 으로 취급되므로 선택지가 아니다
  assert.ok(!H.previewLenChoices(5000).includes(5000));
});

test('filterQuickReplies matches title, text and tags case-insensitively and keeps original index', () => {
  const items = [
    { id: 'a', title: 'Booking', text: 'form', tags: ['예약'] },
    { id: 'b', title: '위치', text: '홍대입구역', tags: [] },
    { id: 'c', title: '시간', text: 'hours', tags: ['안내'] }
  ];
  assert.deepEqual(H.filterQuickReplies(items, '').map((x) => x.index), [0, 1, 2]);
  assert.deepEqual(H.filterQuickReplies(items, 'book').map((x) => x.item.id), ['a']);
  assert.deepEqual(H.filterQuickReplies(items, '홍대').map((x) => x.index), [1]);
  assert.deepEqual(H.filterQuickReplies(items, '안내').map((x) => x.index), [2]);
});

test('moveById and stepById reorder by id without touching the input', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(H.moveById(items, 'a', 'c').map((x) => x.id), ['b', 'c', 'a']);
  assert.deepEqual(H.moveById(items, 'c', 'a').map((x) => x.id), ['c', 'a', 'b']);
  assert.equal(H.moveById(items, 'a', 'a'), null);
  assert.equal(H.moveById(items, 'x', 'a'), null);
  assert.deepEqual(H.stepById(items, 'b', -1).map((x) => x.id), ['b', 'a', 'c']);
  assert.equal(H.stepById(items, 'a', -1), null);
  assert.equal(H.stepById(items, 'c', 1), null);
  assert.deepEqual(items.map((x) => x.id), ['a', 'b', 'c']);
});

test('isDirty compares the editor with the saved item; tags compare after parsing', () => {
  const saved = { id: 'a', title: 't', text: 'x', tags: ['p', 'q'] };
  assert.equal(H.isDirty({ title: 't', text: 'x', tags: 'p, q' }, saved), false);
  assert.equal(H.isDirty({ title: 't', text: 'x', tags: 'p,q,' }, saved), false);
  assert.equal(H.isDirty({ title: 't2', text: 'x', tags: 'p, q' }, saved), true);
  assert.equal(H.isDirty({ title: '', text: '', tags: '' }, null), false);
  assert.equal(H.isDirty({ title: '', text: 'a', tags: '' }, null), true);
  assert.equal(H.isDirty(null, saved), false);
});

test('secret masks never contain the secret', () => {
  const url = 'https://hooks.slack.com/services/T000/B000/abcdef';
  assert.ok(!H.maskedWebhook(url).includes('T000'));
  assert.equal(H.maskedWebhook(''), '');
  assert.ok(!H.maskedKey('secret-key:fx').includes('secret'));
  assert.ok(H.maskedKey('k:fx').endsWith('(:fx)'));
});

test('missingOrigins lists only patterns not reported true', () => {
  const O = ['a/*', 'b/*', 'c/*'];
  assert.deepEqual(H.missingOrigins({ 'a/*': true, 'b/*': false }, O), ['b/*', 'c/*']);
  assert.deepEqual(H.missingOrigins(null, O), O);
  assert.equal(H.hostOf('https://hooks.slack.com/*'), 'hooks.slack.com');
});

test('lastSendText and usageInfo', () => {
  const now = new Date(2026, 10, 13, 15, 0, 0).getTime();
  assert.equal(H.lastSendText(null, now).tone, 'gray');
  assert.equal(H.lastSendText({ at: now - 1000, outcome: 'ok', status: 200 }, now).tone, 'green');
  const r = H.lastSendText({ at: now - 1000, outcome: 'retry', status: 0 }, now);
  assert.equal(r.tone, 'red');
  assert.match(r.text, /네트워크 오류/);
  assert.equal(H.usageInfo(0, 0), null);
  assert.deepEqual(H.usageInfo(250000, 500000).pct, 50);
  assert.equal(H.usageInfo(600, 500).pct, 100);
  assert.equal(H.fmtAgo(now - 12000, now), '12초 전');
  assert.match(H.fmtTime(now - 1000, now), /^오늘 /);
});

test('sample Slack preview follows preview length and phone mask settings', () => {
  const now = Date.now();
  const masked = H.splitSlackPreview(slack.buildSlackPayload(H.sampleSlackItem(now), { slackPreviewMaxLen: 20, slackMaskPhone: true, accountName: '' }, now));
  assert.match(masked.head, /\[Instagram\] 새 메시지/);
  assert.ok(masked.lines.some((l) => /^보낸 사람: .*\*/.test(l) && l.endsWith('5678')));
  assert.ok(masked.lines.some((l) => l.startsWith('내용: ') && l.endsWith('...')));
  const plain = H.splitSlackPreview(slack.buildSlackPayload(H.sampleSlackItem(now), { slackPreviewMaxLen: 1000, slackMaskPhone: false, accountName: '상담' }, now));
  assert.match(plain.head, /^\[상담\]/);
  assert.ok(plain.lines.some((l) => l === '보낸 사람: +82 10-1234-5678'));
  assert.ok(!plain.lines.some((l) => l.endsWith('...')));
});
