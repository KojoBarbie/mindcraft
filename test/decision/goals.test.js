// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoalQueue, SURVIVAL_CURRICULUM, describeGoal, haveFood, haveItem, haveTool, isDone, loadCurriculum } from '../../src/decision/index.js';

const isFood = (/** @type {string} */ name) => ['bread', 'cooked_beef'].includes(name);
/** @param {Record<string, number>} inventory @param {string[]} [foodItems] */
const snap = (inventory, foodItems) => /** @type {import('../../src/decision/snapshot.js').Snapshot} */ ({ inventory, foodItems });

test('isDone for each goal type', () => {
    assert.equal(isDone(haveItem('torch', 16), snap({ torch: 15 }), isFood), false);
    assert.equal(isDone(haveItem('torch', 16), snap({ torch: 16 }), isFood), true);
    assert.equal(isDone(haveTool('stone', 'pickaxe'), snap({ wooden_pickaxe: 1 }), isFood), false);
    assert.equal(isDone(haveTool('stone', 'pickaxe'), snap({ iron_pickaxe: 1 }), isFood), true); // better counts
    assert.equal(isDone(haveTool('stone', 'pickaxe'), snap({ iron_axe: 1 }), isFood), false);
    assert.equal(isDone(haveTool('stone', 'pickaxe'), snap({ golden_pickaxe: 1 }), isFood), false); // gold mines like wood
    assert.equal(isDone(haveTool('wooden', 'pickaxe'), snap({ golden_pickaxe: 1 }), isFood), true);
    assert.equal(isDone(haveTool('diamond', 'pickaxe'), snap({ netherite_pickaxe: 1 }), isFood), true);
    assert.equal(isDone(haveTool('stone', 'pickaxe'), snap({ stone_pickaxe: 0 }), isFood), false);
    assert.equal(isDone(haveFood(5), snap({ bread: 3, cooked_beef: 2, dirt: 64 }), isFood), true);
    assert.equal(isDone(haveFood(5), snap({ mystery_meat: 5 }, ['mystery_meat']), isFood), true); // registry list wins
    assert.equal(describeGoal(haveTool('iron', 'sword')), 'have iron_sword or better');
});

test('the queue serves goals by priority, then in the order they were added', () => {
    const queue = new GoalQueue();
    queue.add(haveItem('torch', 16));
    const urgent = queue.add(haveFood(4), { priority: 10 });
    queue.add(haveItem('furnace'));
    assert.equal(queue.current(snap({}), isFood)?.id, urgent);
    assert.deepEqual(queue.current(snap({ bread: 4 }), isFood)?.goal, haveItem('torch', 16));
});

test('goals that turn out to be done are closed, however that came about', () => {
    const queue = loadCurriculum(new GoalQueue());
    assert.deepEqual(queue.current(snap({}), isFood)?.goal, haveTool('wooden', 'pickaxe'));
    // a player hands the bot an iron pickaxe: every pickaxe rung up to iron is done at once
    const next = queue.current(snap({ iron_pickaxe: 1 }), isFood);
    assert.deepEqual(next?.goal, haveTool('stone', 'sword'));
    assert.equal(queue.goals.filter(g => g.status === 'done').length, 3);
});

test('the curriculum ends: with everything in hand there is nothing left to do', () => {
    const everything = { diamond_pickaxe: 1, diamond_sword: 1, diamond_axe: 1, furnace: 1, bread: 8, torch: 16, shield: 1, iron_chestplate: 1, iron_helmet: 1, iron_leggings: 1, iron_boots: 1 };
    assert.equal(loadCurriculum(new GoalQueue()).current(snap(everything), isFood), null);
    assert.ok(SURVIVAL_CURRICULUM.length >= 10);
});

test('repeated failure gives a goal up, along with the goals that serve it; progress resets the count', () => {
    const queue = new GoalQueue({ maxFailures: 3 });
    const parent = queue.add(haveTool('diamond', 'pickaxe'), { priority: 5 });
    const child = queue.add(haveItem('diamond', 3), { priority: 6, parent });
    const other = queue.add(haveItem('torch', 16));

    assert.equal(queue.reportFailure(parent), false);
    assert.equal(queue.reportFailure(parent), false);
    queue.reportProgress(parent);
    assert.equal(queue.reportFailure(parent), false); // the count started over
    assert.equal(queue.reportFailure(parent), false);
    assert.equal(queue.current(snap({}), isFood)?.id, child);
    assert.equal(queue.reportFailure(parent), true);
    assert.equal(queue.current(snap({}), isFood)?.id, other); // the child went with its parent
    assert.equal(queue.reportFailure(parent), false); // already given up
});

test('the queue survives a round trip through JSON', () => {
    const queue = new GoalQueue({ maxFailures: 2 });
    const a = queue.add(haveItem('furnace'), { priority: 3 });
    queue.add(haveFood(4), { parent: a });
    queue.reportFailure(a);
    const restored = GoalQueue.fromJSON(JSON.parse(JSON.stringify(queue)));
    assert.deepEqual(restored.toJSON(), queue.toJSON());
    assert.equal(restored.add(haveItem('torch')), 3);
    assert.equal(restored.reportFailure(a), true);
});

test('a damaged save is repaired on load instead of hanging or colliding', () => {
    const restored = GoalQueue.fromJSON({
        maxFailures: 'many', nextId: 1,
        goals: [
            { id: 1, goal: haveItem('furnace'), priority: 1, parent: 2, status: 'pending', failures: 0 },
            { id: 2, goal: haveItem('torch'), priority: 1, parent: 1, status: 'pending', failures: -4 }, // a cycle
            { id: 2, goal: haveItem('duplicate'), priority: 1, parent: null, status: 'pending', failures: 0 },
            { id: 7, goal: { type: 'build_castle' }, priority: 9, parent: 99, status: 'pending', failures: 0 },
            { id: 'x', goal: haveItem('junk') }, null, 'nonsense',
        ],
    });
    assert.equal(restored.maxFailures, 3);
    assert.deepEqual(restored.goals.map(g => g.id), [1, 2, 7]);
    assert.ok(restored.goals.filter(g => g.id !== 7).some(g => g.parent === null)); // the cycle is cut
    assert.equal(restored.goals[2].status, 'failed'); // unknown goal type: kept for the record, never pursued
    assert.equal(restored.goals[2].parent, null);
    assert.equal(restored.goals[1].failures, 0);
    assert.deepEqual(restored.current(snap({}), isFood)?.goal, haveItem('furnace')); // and it terminates
    assert.equal(restored.add(haveItem('stick')), 8); // ids are never reused
    assert.deepEqual(GoalQueue.fromJSON(null).goals, []);
});
