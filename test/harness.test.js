// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCommandEcho } from '../scripts/lib/harness.js';
import { NoModel } from '../src/models/none.js';

test('isCommandEcho matches only the "*user used command*" line', () => {
    assert.equal(isCommandEcho('*harness_user used collectBlocks*'), true);
    assert.equal(isCommandEcho('Collected 3 oak_log.'), false);
    assert.equal(isCommandEcho('INVENTORY - oak_log: 3'), false);
});

test('the "none" model is discoverable and generates nothing', async () => {
    assert.equal(NoModel.prefix, 'none');
    const model = new NoModel('none');
    assert.equal(await model.sendRequest([], ''), '');
    await assert.rejects(() => model.embed('text'));
});
