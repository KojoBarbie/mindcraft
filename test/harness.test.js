// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResultCollector, isCommandEcho } from '../scripts/lib/result_collector.js';
import { NoModel } from '../src/models/none.js';

test('isCommandEcho matches only the echo of our own sender', () => {
    assert.equal(isCommandEcho('*harness_user used collectBlocks*', 'harness_user'), true);
    assert.equal(isCommandEcho('*someone_else used collectBlocks*', 'harness_user'), false);
    assert.equal(isCommandEcho('Collected 3 oak_log.', 'harness_user'), false);
});

test('the result is the first message after the echo', () => {
    const c = createResultCollector('harness_user');
    assert.equal(c.push('*harness_user used collectBlocks*'), false);
    assert.equal(c.sawEcho, true);
    assert.equal(c.push('Collected 3 oak_log.'), true);
    assert.equal(c.result, 'Collected 3 oak_log.');
});

test('output that arrives before the echo is not mistaken for the result', () => {
    const c = createResultCollector('harness_user');
    assert.equal(c.push('Hello world! I am harness'), false);
    assert.equal(c.push('Picking up item!'), false);
    assert.equal(c.result, null);
    c.push('*harness_user used inventory*');
    c.push('INVENTORY - oak_log: 3');
    assert.equal(c.result, 'INVENTORY - oak_log: 3');
});

test('later messages do not overwrite a captured result', () => {
    const c = createResultCollector('harness_user');
    c.push('*harness_user used stats*');
    c.push('STATS ...');
    assert.equal(c.push('something else'), true);
    assert.equal(c.result, 'STATS ...');
});

test('the "none" model is discoverable and generates nothing', async () => {
    assert.equal(NoModel.prefix, 'none');
    const model = new NoModel('none');
    assert.equal(await model.sendRequest([], ''), '');
    await assert.rejects(() => model.embed('text'));
});
