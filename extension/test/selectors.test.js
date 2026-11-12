const test = require('node:test');
const assert = require('node:assert');
const sel = require('../content/selectors.js').sel;
const U = 'https://business.facebook.com/latest/inbox/wec?asset_id=1234567890123456&business_id=9&selected_item_id=555&thread_type=x';

test('asset id from url, then from tab links, else null', () => {
  assert.equal(sel.assetIdFrom(U, []), '1234567890123456');
  assert.equal(sel.assetIdFrom('https://business.facebook.com/latest/inbox/wec', ['/latest/inbox/all?asset_id=42']), '42');
  assert.equal(sel.assetIdFrom('https://business.facebook.com/latest/inbox/wec', []), null);
  assert.equal(sel.assetIdFrom('https://business.facebook.com/latest/inbox/wec', ['/latest/inbox/all', 'https://business.facebook.com/x?asset_id=7']), '7');
  assert.equal(sel.assetIdFrom('not a url', null), null);
});

test('thread id and channel', () => {
  assert.equal(sel.threadIdFrom(U), '555');
  assert.equal(sel.threadIdFrom('https://business.facebook.com/latest/inbox/wec'), null);
  assert.equal(sel.channelFromPath('/latest/inbox/wec'), 'wec');
  assert.equal(sel.channelFromPath('/latest/inbox/instagram_direct'), 'instagram_direct');
  assert.equal(sel.channelFromPath('/latest/inbox/all'), 'all');
  assert.equal(sel.channelFromPath('/latest/inbox/messenger'), 'other');
  assert.equal(sel.channelFromPath('/latest/home'), null);
});

test('badge text', () => {
  assert.equal(sel.parseBadgeText('2 new'), 2);
  assert.equal(sel.parseBadgeText('12 new  '), 12);
  assert.equal(sel.parseBadgeText(''), 0);
  assert.equal(sel.parseBadgeText(null), 0);
  assert.equal(sel.parseBadgeText('new 3'), 0);
});

test('label matching ignores case and spaces', () => {
  assert.equal(sel.labelMatches(' submit ', ['Submit']), true);
  assert.equal(sel.labelMatches('Attach a file', ['Submit']), false);
  assert.equal(sel.labelMatches(null, ['Submit']), false);
});

test('DOM lookups return null/empty without a document', () => {
  assert.equal(sel.composer(), null);
  assert.deepEqual(sel.listItems(), []);
  assert.deepEqual(sel.channelTabs(), []);
  assert.equal(sel.submitButton(), null);
  assert.equal(sel.searchValue(), null);
});

test('channelFromPath requires a path boundary', () => {
  assert.equal(sel.channelFromPath('/latest/inboxfoo'), null);
  assert.equal(sel.channelFromPath('/latest/inbox'), 'other');
  assert.equal(sel.channelFromPath('/latest/inbox/wec/x'), 'wec');
});

test('list state helpers are safe without a document', () => {
  assert.equal(sel.filterState(), '');
  assert.equal(sel.listScrollTop(), 0);
  assert.equal(sel.isListOrThreadMenu(null), false);
});

test('joinFilterState is stable and drops empties', () => {
  assert.equal(sel.joinFilterState(['q:a', '', 'on:Unread', null]), 'on:Unread|q:a');
  assert.equal(sel.joinFilterState(['on:Unread', 'q:a']), sel.joinFilterState(['q:a', 'on:Unread']));
  assert.equal(sel.joinFilterState(undefined), '');
});

test('HIDDEN_TAB_DOUBLE_OBSERVE constant is on', () => {
  assert.equal(require('../lib/constants.js').HIDDEN_TAB_DOUBLE_OBSERVE, true);
});
