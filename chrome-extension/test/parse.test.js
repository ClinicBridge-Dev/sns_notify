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

test('non-message rows (notes bubble, empty chat) are not message rows', () => {
  assert.strictEqual(P.isMessageRow(P.parseRowLines(['새 소식...', '내 메모'])), false);
  assert.strictEqual(P.isMessageRow(P.parseRowLines(['Instagram 사용자님', '채팅하려면 클릭하세요'])), false);
  assert.strictEqual(P.isMessageRow(P.parseRowLines(['A님', 'hi', '·', '3분'])), true);
  assert.strictEqual(P.isMessageRow(P.parseRowLines(['A님', 'hi', 'Unread'])), true);
});
