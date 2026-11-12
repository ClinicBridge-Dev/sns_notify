const test = require('node:test');
const assert = require('node:assert');
const { createSerialQueue } = require('../lib/serial.js');

test('runs jobs one at a time in call order', async () => {
  const run = createSerialQueue();
  const log = [];
  const job = (name, ms) => run(async () => { log.push(name + ':start'); await new Promise(r => setTimeout(r, ms)); log.push(name + ':end'); return name; });
  const results = await Promise.all([job('a', 20), job('b', 1)]);
  assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'b:end']);
  assert.deepEqual(results, ['a', 'b']);
});

test('a rejected job does not block the next one', async () => {
  const run = createSerialQueue();
  await assert.rejects(run(async () => { throw new Error('x'); }));
  assert.equal(await run(async () => 1), 1);
});
