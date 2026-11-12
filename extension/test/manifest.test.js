// manifest 요건(기획서 2-2, 6-3). 확장 아이콘 배지('!')는 chrome.action 이 있어야 동작한다.
const test = require('node:test');
const assert = require('node:assert');
const m = require('../manifest.json');

test('item 1: manifest declares an action so chrome.action badge "!" works', () => {
  assert.ok(m.action && typeof m.action === 'object', 'action key missing');
  assert.equal(m.action.default_title, m.name);
  assert.equal(m.action.default_popup, undefined); // 팝업 없음(설정은 options 페이지)
});

test('permissions stay exactly storage, alarms, clipboardWrite', () => {
  assert.deepEqual([...m.permissions].sort(), ['alarms', 'clipboardWrite', 'storage']);
  assert.deepEqual([...m.host_permissions].sort(), [
    'https://api-free.deepl.com/*', 'https://api.deepl.com/*', 'https://business.facebook.com/*', 'https://hooks.slack.com/*'
  ]);
});

test('item 6: options Slack section carries the multi-install notice (spec 6-1)', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '../options/options.html'), 'utf8');
  const sec = html.slice(html.indexOf('id="sec-slack"'), html.indexOf('id="sec-slack-connect"'));
  assert.match(sec, /여러 사람이 각자 설치하면 같은 알림이 사람 수만큼 게시됩니다/);
  assert.match(sec, /알림 담당 브라우저 1대에서만/);
});
