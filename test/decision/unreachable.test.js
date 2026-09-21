// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnreachable, markUnreachable, pruneUnreachable, UNREACHABLE_MS } from '../../src/agent/library/unreachable.js';

test('a place it failed to reach is skipped for a while, then tried again', () => {
    /** @type {any} */
    const bot = {};
    const pos = { x: 10.4, y: 64, z: -3.7 };
    assert.equal(isUnreachable(bot, pos, 0), false);
    markUnreachable(bot, pos, 0);
    assert.equal(isUnreachable(bot, { x: 10, y: 64, z: -4 }, 1000), true, 'the same block, whatever the fraction');
    assert.equal(isUnreachable(bot, pos, UNREACHABLE_MS + 1), false);
    assert.equal(bot.unreachable.size, 0, 'an expired entry is dropped when looked at');
});

test('placeholder blocks without a position are not unreachable, and do not throw', () => {
    /** @type {any} */
    const bot = {};
    markUnreachable(bot, { x: 1, y: 2, z: 3 });
    assert.equal(isUnreachable(bot, null), false);
    assert.doesNotThrow(() => markUnreachable(bot, undefined));
});

test('the memory does not grow without bound', () => {
    /** @type {any} */
    const bot = {};
    for (let i = 0; i < 300; i++) markUnreachable(bot, { x: i, y: 0, z: 0 }, i < 200 ? 0 : UNREACHABLE_MS + 1);
    assert.ok(bot.unreachable.size <= 257);
    assert.equal(pruneUnreachable(bot, UNREACHABLE_MS * 3), 0);
});
