// node --test chrome-extension/test
const test = require('node:test');
const assert = require('node:assert');
const P = require('../parse.js');

test('unread row with name, preview, time', () => {
  const r = P.parseRowLines(['채원쓰님', '채원쓰님이 첨부 파일을 보냈습니다.', '·', '10시간', 'Unread']);
  assert.deepStrictEqual(r, { name: '채원쓰', preview: '채원쓰님이 첨부 파일을 보냈습니다.', time_label: '10시간', unread: true });
});

test('read row, own last message, English time', () => {
  const r = P.parseRowLines(['Valerie Myra님', '회원님: Hello, so sorry', ' · ', '14h']);
  assert.deepStrictEqual(r, { name: 'Valerie Myra', preview: '회원님: Hello, so sorry', time_label: '14h', unread: false });
});

test('verified badge text and multi-line preview are kept together', () => {
  const r = P.parseRowLines(['Mia 정지원님', 'Once again,', 'thank you', '18시간']);
  assert.strictEqual(r.name, 'Mia 정지원');
  assert.strictEqual(r.preview, 'Once again, thank you');
});

test('folder from tab label or path', () => {
  assert.strictEqual(P.folderFrom('General', '/direct/inbox/'), 'general');
  assert.strictEqual(P.folderFrom('Primary', '/direct/inbox/'), 'primary');
  assert.strictEqual(P.folderFrom('요청', '/direct/requests/'), 'requests');
  assert.strictEqual(P.folderFrom(null, '/direct/inbox/'), 'primary');
  assert.strictEqual(P.folderFrom('일반', '/direct/x/'), 'general');
});

test('unread total from title', () => {
  assert.strictEqual(P.unreadFromTitle('(3) Instagram • 메시지'), 3);
  assert.strictEqual(P.unreadFromTitle('Instagram'), 0);
});

test('requests path overrides an inbox tab retained in the sidebar', () => {
  assert.strictEqual(P.folderFrom('Primary', '/direct/requests/'), 'requests');
  assert.strictEqual(P.folderFrom('General', '/direct/requests/'), 'requests');
  assert.strictEqual(P.folderFrom('Message requests (2)', '/direct/inbox/'), 'requests');
  assert.strictEqual(P.folderFrom('메시지 요청', '/direct/inbox/'), 'requests');
  assert.strictEqual(P.folderFrom('リクエスト', '/direct/inbox/'), 'requests');
  assert.strictEqual(P.folderFrom(null, '/direct/t/123/'), 'unknown');
});

test('non-message rows (notes bubble, empty chat) are not message rows', () => {
  assert.strictEqual(P.isMessageRow(P.parseRowLines(['새 소식...', '내 메모'])), false);
  assert.strictEqual(P.isMessageRow(P.parseRowLines(['Instagram 사용자님', '채팅하려면 클릭하세요'])), false);
  assert.strictEqual(P.isMessageRow(P.parseRowLines(['A님', 'hi', '·', '3분'])), true);
  assert.strictEqual(P.isMessageRow(P.parseRowLines(['A님', 'hi', 'Unread'])), true);
});

test('avatar presence is not the sender name and does not change the preview', () => {
  const body = 'Loula Mosseri replied to an ad. View ad(https://www.instagram.com/p/De89w9tgSWn/)';
  const normal = P.parseRowLines(['Loula Mosseri님', body, '·', '7시간', 'Unread']);
  for (const presence of ['활동 중', '지금 활동 중', 'Active now', 'Active today', 'Online']) {
    assert.deepStrictEqual(P.parseRowLines([presence, 'Loula Mosseri님', body, '·', '7시간', 'Unread']), normal);
  }
  assert.strictEqual(normal.name, 'Loula Mosseri');
  assert.strictEqual(normal.preview, body);
});

test('presence wording in message content is preserved', () => {
  assert.strictEqual(P.parseRowLines(['Loula님', '활동 중', '1분', 'Unread']).preview, '활동 중');
  assert.strictEqual(P.isMessageRow(P.parseRowLines(['활동 중'])), false);
});
