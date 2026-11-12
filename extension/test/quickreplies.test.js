const test = require('node:test');
const assert = require('node:assert');
const Q = require('../lib/quickreplies.js');
const item = (o) => ({ id: 'a', title: '예약 양식', text: '예약을 위해 아래 정보를 보내 주세요.', tags: ['예약'], ...o });

test('accepts both the wrapped object and a bare array', () => {
  assert.equal(Q.validateImport({ version: 1, items: [item()] }).ok, true);
  assert.equal(Q.validateImport([item()]).ok, true);
});

test('reports which item is wrong and why', () => {
  const r = Q.validateImport([item(), item({ title: 123 }), item({ text: 'x'.repeat(2001) }), item({ title: 'x'.repeat(51) })]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map(e => e.index), [1, 2, 3]);
});

test('rejects more than 500 items and non-list input', () => {
  assert.equal(Q.validateImport(Array.from({ length: 501 }, () => item())).ok, false);
  assert.equal(Q.validateImport({ foo: 1 }).ok, false);
});

test('merge overwrites same id, adds new, issues id when missing', () => {
  const existing = [item({ id: 'a', title: '옛 제목' }), item({ id: 'b' })];
  const incoming = [item({ id: 'a', title: '새 제목' }), item({ id: undefined, title: '추가' })];
  const r = Q.mergeImport(existing, incoming, 'merge', () => 'new-1');
  assert.deepEqual(r.items.map(i => [i.id, i.title]), [['a', '새 제목'], ['b', '예약 양식'], ['new-1', '추가']]);
  assert.equal(r.added, 1);
  assert.equal(r.changed, 1);
});

test('replace discards existing items', () => {
  const r = Q.mergeImport([item({ id: 'a' })], [item({ id: 'z' })], 'replace', () => 'n');
  assert.deepEqual(r.items.map(i => i.id), ['z']);
});

test('export file name', () => {
  assert.equal(Q.exportFileName(new Date(2026, 10, 12)), 'quick-replies-20261112.json');
});

test('rejects empty title or text, bad tags, non-object items', () => {
  const r = Q.validateImport([item({ title: '' }), item({ text: '   ' }), item({ tags: 'a' }), null]);
  assert.deepEqual(r.errors.map(e => e.index), [0, 1, 2, 3]);
});

test('accepted items are normalized to id/title/text/tags', () => {
  const r = Q.validateImport([{ title: 't', text: 'x', extra: 1 }]);
  assert.deepEqual(r.items, [{ id: undefined, title: 't', text: 'x', tags: [] }]);
});

test('rejects wrapped object whose version is not 1', () => {
  const r = Q.validateImport({ version: 2, items: [item()] });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].index, -1);
  assert.equal(Q.validateImport({ items: [item()] }).ok, false);
});

test('duplicate ids inside one import get fresh ids', () => {
  let n = 0;
  const r = Q.mergeImport([], [item({ id: 'x' }), item({ id: 'x', title: '둘' }), item({ id: undefined })], 'replace', () => 'n' + (++n));
  assert.deepEqual(r.items.map(i => i.id), ['x', 'n1', 'n2']);
  const m = Q.mergeImport([item({ id: 'x' })], [item({ id: 'y' }), item({ id: 'y' })], 'merge', () => 'n9');
  assert.deepEqual(m.items.map(i => i.id), ['x', 'y', 'n9']);
  assert.equal(m.added, 2);
});
