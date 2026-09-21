// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoalQueue } from '../../src/decision/index.js';
import { createGuardRole } from '../../src/decision/roles/guard.js';
import { createMinerRole } from '../../src/decision/roles/miner.js';
import { createLumberjackRole } from '../../src/decision/roles/lumberjack.js';

/** @param {Partial<any>} over */
const snap = over => /** @type {any} */ ({ pos: { x: 0, y: 64, z: 0 }, inventory: {}, timeOfDay: 1000, dimension: 'overworld', foodItems: ['bread', 'cooked_beef'], ...over });
const loop = () => ({ goals: new GoalQueue(), onEvent: () => {} });
const isFood = (/** @type {string} */ n) => ['bread', 'cooked_beef'].includes(n);
const kit = { iron_sword: 1, iron_chestplate: 1, shield: 1, torch: 16, cooked_beef: 8 };

test('guard: the post survives a restart, and at dusk a guard far from it goes back', () => {
    const first = createGuardRole();
    const l = loop();
    first.step(l, snap({ inventory: kit }), isFood);
    const saved = first.state();
    const again = createGuardRole();
    again.restore(saved);
    const far = again.step(l, snap({ pos: { x: 300, y: 70, z: 300 }, inventory: kit, timeOfDay: 11_500 }), isFood);
    assert.equal(far, '!goToCoordinates(0, 64, 0, 3)');
    const home = again.step(l, snap({ inventory: kit, timeOfDay: 14_000 }), isFood);
    assert.match(String(home), /^!patrol\(0, 64, 0, 24\)$/);
});

test('guard: by day, missing gear becomes goals and the loop pursues them', () => {
    const role = createGuardRole();
    const l = loop();
    assert.equal(role.step(l, snap({}), isFood), null);
    const goals = l.goals.toJSON().goals.map(q => JSON.stringify(q.goal));
    assert.ok(goals.some(g => g.includes('"sword"')) && goals.some(g => g.includes('torch')) && goals.some(g => g.includes('have_food')));
});

test('miner: equipped on the surface it goes down; underground without a pickaxe it makes a stone one first', () => {
    const role = createMinerRole({ center: [10, 20] });
    const l = loop();
    const equipped = { iron_pickaxe: 1, torch: 32, bread: 8, stick: 8, crafting_table: 1 };
    assert.equal(role.step(l, snap({ inventory: equipped }), isFood), '!descendTo(-58)');
    assert.equal(role.step(l, snap({ inventory: equipped, pos: { x: 0, y: -58, z: 0 } }), isFood), '!branchMine(10, 20, 48)');
    const bare = createMinerRole();
    const l2 = loop();
    assert.equal(bare.step(l2, snap({ inventory: { stick: 8 }, pos: { x: 0, y: 20, z: 0 } }), isFood), null);
    const first = l2.goals.toJSON().goals.sort((a, b) => b.priority - a.priority)[0].goal;
    assert.deepEqual(first, { type: 'have_tool', tool: 'pickaxe', tier: 'stone' });
});

test('lumberjack: chops until a batch, delivers, counts what went in, and stops at the quota', () => {
    const role = createLumberjackRole({ quota: 8, chest: [5, 64, 5] });
    const l = loop();
    assert.equal(role.step(l, snap({ inventory: { wooden_axe: 1 } })), '!chopTree(0, 0, 32)');
    assert.equal(role.step(l, snap({ inventory: { wooden_axe: 1, oak_log: 9 } })), '!depositLogs(5, 64, 5)');
    assert.equal(role.step(l, snap({ inventory: { wooden_axe: 1, oak_log: 0 } })), null, 'quota met after the delivery');
    assert.equal(role.delivered, 9);
});
