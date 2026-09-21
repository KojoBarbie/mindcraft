// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mcdata from 'minecraft-data';
import { GoalQueue, LoopGuard, createGameData, createStrategist, extractJson, haveTool, isAddressedTo, validateGoal } from '../../src/decision/index.js';

const data = createGameData(mcdata('1.21.6'));
/** @type {any} */
const snapshot = {
    hp: 20, food: 20, timeOfDay: 1000, dimension: 'overworld', raining: false, pos: { x: 0, y: 64, z: 0 },
    heldItem: null, armor: [], inventory: {}, entities: [], blocks: [], action: null, goal: null, recent: [],
};

/** A chat model that answers with `text` after `delayMs`, counting its calls. @param {string | (() => string)} text */
function stubModel(text, delayMs = 0) {
    const calls = /** @type {{system: string, user: string}[]} */ ([]);
    return {
        calls,
        complete: async (/** @type {string} */ system, /** @type {string} */ user) => {
            calls.push({ system, user });
            if (delayMs) await new Promise(r => setTimeout(r, delayMs));
            return { text: typeof text === 'function' ? text() : text };
        },
    };
}

test('extractJson: plain, fenced, or with a sentence around it; null when there is none', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('Sure!\n```json\n{"goals": []}\n```'), { goals: [] });
    assert.equal(extractJson('no idea'), null);
    assert.equal(extractJson('{broken'), null);
});

test('validateGoal: real items and tools pass cleaned; inventions and silly counts do not', () => {
    assert.deepEqual(validateGoal({ type: 'have_item', item: 'minecraft:iron_ingot', count: 3 }, data), { goal: { type: 'have_item', item: 'iron_ingot', count: 3 } });
    assert.deepEqual(validateGoal({ type: 'have_tool', tool: 'pickaxe', tier: 'iron' }, data), { goal: { type: 'have_tool', tool: 'pickaxe', tier: 'iron' } });
    assert.match(/** @type {any} */ (validateGoal({ type: 'have_item', item: 'house', count: 1 }, data)).reason, /unknown item/);
    assert.match(/** @type {any} */ (validateGoal({ type: 'have_item', item: 'dirt', count: 0 }, data)).reason, /bad count/);
    assert.match(/** @type {any} */ (validateGoal({ type: 'build', what: 'house' }, data)).reason, /unknown goal type/);
    assert.match(/** @type {any} */ (validateGoal({ type: 'have_tool', tool: 'pickaxe', tier: 'netherite' }, data)).reason, /unknown tool/);
});

test('isAddressedTo: commands never, the bot\'s name always, anything when it is just the two of them', () => {
    assert.equal(isAddressedTo('!stats', 'Andy', 1), false);
    assert.equal(isAddressedTo('andy, get me some iron', 'Andy', 5), true);
    assert.equal(isAddressedTo('鉄装備を揃えて', 'Andy', 1), true);
    assert.equal(isAddressedTo('anyone seen my dog?', 'Andy', 3), false);
});

test('a request becomes checked goals ahead of the queue, with a reply; inventions are dropped with a reason', async () => {
    const goals = new GoalQueue();
    goals.add(haveTool('wooden', 'pickaxe'), { priority: 2 });
    const model = stubModel(JSON.stringify({
        reply: '鉄装備を集めます', goals: [
            { type: 'have_tool', tool: 'pickaxe', tier: 'iron' },
            { type: 'have_item', item: 'iron_chestplate', count: 1 },
            { type: 'have_item', item: 'magic_wand', count: 1 },
            { type: 'have_tool', tool: 'pickaxe', tier: 'wooden' }, // already queued: not added twice
        ],
    }));
    /** @type {string[]} */
    const said = [];
    /** @type {any[]} */
    const records = [];
    const strategist = createStrategist({ complete: model.complete, data, say: t => said.push(t), telemetry: r => records.push(r), price: [1, 10] });
    const result = await strategist.consult({ kind: 'chat', from: 'steve', message: '鉄装備を揃えて' }, { snapshot, goals });
    assert.ok(result);
    assert.deepEqual(result.accepted.map(g => g.type), ['have_tool', 'have_item', 'have_tool']);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0].reason, /unknown item "magic_wand"/);
    assert.deepEqual(said, ['鉄装備を集めます']);
    const pending = goals.toJSON().goals.filter(q => q.status === 'pending').sort((a, b) => b.priority - a.priority);
    assert.deepEqual(pending.map(q => JSON.stringify(q.goal)), [
        JSON.stringify({ type: 'have_tool', tool: 'pickaxe', tier: 'iron' }),
        JSON.stringify({ type: 'have_item', item: 'iron_chestplate', count: 1 }),
        JSON.stringify({ type: 'have_tool', tool: 'pickaxe', tier: 'wooden' }),
    ], 'the request goes first, in the order given; the old goal after it, once');
    assert.equal(records[0].kind, 'strategy');
    assert.ok(records[0].usd > 0);
    assert.match(model.calls[0].user, /steve said: 鉄装備を揃えて/);
});

test('a goal with no route from here is not queued', async () => {
    const goals = new GoalQueue();
    // nether stars come from the wither; the planner has no route to one
    const model = stubModel('{"reply": null, "goals": [{"type": "have_item", "item": "nether_star", "count": 1}]}');
    const result = await createStrategist({ complete: model.complete, data }).consult({ kind: 'gave_up' }, { snapshot, goals });
    assert.equal(result?.accepted.length, 0);
    assert.match(result?.rejected[0].reason ?? '', /no route/);
    assert.equal(goals.toJSON().goals.length, 0);
});

test('a proposal of its own goes after what the bot is doing, not ahead of it', async () => {
    const goals = new GoalQueue();
    goals.add(haveTool('stone', 'pickaxe'), { priority: 5 });
    const model = stubModel('{"reply": null, "goals": [{"type": "have_food", "count": 4}]}');
    await createStrategist({ complete: model.complete, data }).consult({ kind: 'gave_up' }, { snapshot, goals });
    const byPriority = goals.toJSON().goals.sort((a, b) => b.priority - a.priority).map(q => q.goal.type);
    assert.deepEqual(byPriority, ['have_tool', 'have_food']);
});

test('never two at once, cooldowns per kind, an hourly cap, and a spent budget all keep the model idle', async () => {
    let clock = 0;
    const model = stubModel('{"goals": []}', 20);
    /** @type {any[]} */
    const events = [];
    const guard = new LoopGuard({ now: () => clock });
    const strategist = createStrategist({ complete: model.complete, data, now: () => clock, guard, maxPerHour: 3, onEvent: e => events.push(e) });
    const ctx = { snapshot, goals: new GoalQueue() };
    const first = strategist.consult({ kind: 'low_confidence' }, ctx);
    assert.ok(first);
    assert.equal(strategist.consult({ kind: 'chat', message: 'hi' }, ctx), null, 'busy');
    await first;
    assert.equal(strategist.consult({ kind: 'low_confidence' }, ctx), null, 'cooling down');
    clock += 121_000;
    await strategist.consult({ kind: 'low_confidence' }, ctx);
    await strategist.consult({ kind: 'chat', message: 'hi' }, ctx);
    assert.equal(strategist.consult({ kind: 'chat', message: 'again' }, ctx), null, 'three an hour');
    assert.equal(model.calls.length, 3);
    assert.deepEqual(events.filter(e => e.type === 'strategy skipped').map(e => e.detail.reason), ['busy', 'cooling down', 'hourly limit']);

    const broke = new LoopGuard({ maxDecisionsPerHour: 1 });
    broke.recordSpend({ decisions: 1 });
    assert.equal(createStrategist({ complete: model.complete, data, guard: broke }).consult({ kind: 'chat', message: 'x' }, ctx), null);
    assert.equal(guard.usage().decisions.day, 3, 'each consultation is charged');
});

test('the caller is never kept waiting, and a failing model is reported, not thrown', async () => {
    const slow = stubModel('{"goals": []}', 200);
    const strategist = createStrategist({ complete: slow.complete, data });
    const started = Date.now();
    const pending = strategist.consult({ kind: 'gave_up' }, { snapshot, goals: new GoalQueue() });
    assert.ok(Date.now() - started < 50, 'consult() returns at once');
    await pending;

    /** @type {string[]} */
    const said = [];
    /** @type {any[]} */
    const events = [];
    const failing = createStrategist({ complete: () => Promise.reject(new Error('quota')), data, say: t => said.push(t), onEvent: e => events.push(e) });
    assert.equal(await failing.consult({ kind: 'chat', from: 'steve', message: 'wood please' }, { snapshot, goals: new GoalQueue() }), null);
    assert.ok(events.some(e => e.type === 'error' && /quota/.test(e.detail)));
    assert.equal(said.length, 1, 'a player who asked hears something back');
});

test('an answer without JSON is recorded as rejected, nothing queued', async () => {
    const goals = new GoalQueue();
    const result = await createStrategist({ complete: stubModel('I would gather wood first.').complete, data }).consult({ kind: 'gave_up' }, { snapshot, goals });
    assert.equal(result?.accepted.length, 0);
    assert.match(result?.rejected[0].reason ?? '', /no JSON/);
});
