// @ts-check
// Guards this fork adds to its dependencies through patch-package (patches/). A NaN position once sent the
// pathfinder's GoalLookAtBlock into a raycast that never ended, freezing the agent at 100% CPU: it answered
// nothing, ignored SIGINT and had to be killed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3');

test('prismarine-world: a raycast with a NaN direction ends at once', () => {
    const { RaycastIterator } = /** @type {any} */ (require('prismarine-world/src/iterators.js'));
    const it = new RaycastIterator(new Vec3(1, 2, 3), new Vec3(NaN, NaN, NaN), 4.5);
    assert.equal(it.next(), null);
    const fine = new RaycastIterator(new Vec3(1, 2, 3), new Vec3(1, 0, 0), 4.5);
    let steps = 0;
    while (fine.next() && steps < 100) steps++;
    assert.ok(steps > 0 && steps < 100);
});

test('mineflayer-pathfinder: GoalLookAtBlock is never reached from a non-finite node, and does not hang', () => {
    const { goals } = require('mineflayer-pathfinder');
    const world = { raycast: () => { throw new Error('must not be reached'); } };
    const goal = new goals.GoalLookAtBlock(new Vec3(0, 64, 0), world);
    assert.equal(goal.isEnd(/** @type {any} */ (new Vec3(NaN, 64, NaN))), false);
});
