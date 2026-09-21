// @ts-check
// The planner is tested against the real game data (minecraft-data is pure JS), not a fake: the interesting
// failures are in how real recipes and drops are shaped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mcdata from 'minecraft-data';
import { createGameData, focusFor, haveFood, haveItem, haveTool, isDone, planGoal } from '../../src/decision/index.js';

const data = createGameData(mcdata('1.21.6'));

/**
 * @param {Record<string, number>} [inventory]
 * @param {string[]} [nearbyBlocks]
 * @param {import('../../src/decision/snapshot.js').EntityObservation[]} [entities]
 */
function snapshot(inventory = {}, nearbyBlocks = [], entities = []) {
    return /** @type {import('../../src/decision/snapshot.js').Snapshot} */ ({
        inventory, entities, blocks: nearbyBlocks.map(name => ({ name, dist: 5, dy: 0 })),
    });
}
/** @param {import('../../src/decision/planner.js').Plan} plan */
const texts = plan => plan.steps.map(step => focusFor(step).text);

/**
 * Walk the plan with a simulated inventory and fail if any step uses something the bot would not have yet.
 * Checks the steps against the game data independently of the planner's own bookkeeping.
 * @param {import('../../src/decision/planner.js').Plan} plan
 * @param {Record<string, number>} inventory
 * @param {string[]} [nearbyBlocks]
 */
function simulate(plan, inventory, nearbyBlocks = []) {
    const stock = { ...inventory };
    const atHand = (/** @type {string} */ name) => (stock[name] ?? 0) > 0 || nearbyBlocks.includes(name);
    const take = (/** @type {string} */ item, /** @type {number} */ n, /** @type {string} */ why) => {
        assert.ok((stock[item] ?? 0) >= n, `${why}: needs ${n} ${item}, has ${stock[item] ?? 0}`);
        stock[item] -= n;
    };
    for (const step of plan.steps) {
        const label = focusFor(step).text;
        if (step.kind === 'collect') {
            const tools = data.harvestTools(/** @type {string} */ (step.block));
            if (tools) assert.ok(tools.some(tool => (stock[tool] ?? 0) > 0), `${label}: no tool among ${tools}`);
            assert.ok(data.sources(step.item).includes(/** @type {string} */ (step.block)), `${label}: ${step.block} does not drop ${step.item}`);
        } else if (step.kind === 'craft') {
            const crafts = /** @type {number} */ (step.crafts);
            // the step must correspond to a real recipe (several wood variants exist; consumes says which)
            const recipe = data.recipes(step.item).find(r => r.makes * crafts === step.count
                && JSON.stringify(Object.entries(r.ingredients).map(([name, n]) => [name, n * crafts]).sort()) === JSON.stringify(Object.entries(step.consumes).sort()));
            assert.ok(recipe, `${label}: consumes ${JSON.stringify(step.consumes)} matches no recipe`);
            if (recipe.needsTable) assert.ok(atHand('crafting_table'), `${label}: needs a crafting table`);
            for (const [name, n] of Object.entries(recipe.ingredients)) take(name, n * crafts, label);
        } else if (step.kind === 'smelt') {
            assert.ok(atHand('furnace'), `${label}: needs a furnace`);
            assert.equal(data.smeltedFrom(step.item), step.from);
            take(/** @type {string} */ (step.from), step.count, label);
            const fuel = ['coal', 'charcoal'].find(name => (stock[name] ?? 0) > 0);
            assert.ok(fuel, `${label}: no fuel`);
            take(fuel, Math.ceil(step.count / 8), label);
        }
        stock[step.item] = (stock[step.item] ?? 0) + step.count;
    }
    return stock;
}

test('wooden pickaxe from nothing uses the wood that is actually nearby', () => {
    const plan = planGoal(haveTool('wooden', 'pickaxe'), snapshot({}, ['acacia_log']), data);
    assert.deepEqual(texts(plan), ['collect 3 acacia_log', 'craft 12 acacia_planks', 'craft 1 crafting_table', 'craft 4 stick', 'craft 1 wooden_pickaxe']);
    assert.deepEqual(plan.unresolved, []);
    assert.equal(simulate(plan, {}).wooden_pickaxe, 1);
});

test('with nothing in sight it falls back to everyday materials: oak, cobblestone, plain ores', () => {
    const plan = planGoal(haveTool('iron', 'pickaxe'), snapshot(), data);
    assert.deepEqual(texts(plan), [
        'collect 3 oak_log', 'craft 12 oak_planks', 'craft 1 crafting_table', 'craft 8 stick', 'craft 1 wooden_pickaxe',
        'collect 11 stone for cobblestone', 'craft 1 furnace', 'craft 1 stone_pickaxe',
        'collect 3 iron_ore for raw_iron', 'collect 1 coal_ore for coal', 'smelt 3 raw_iron into iron_ingot', 'craft 1 iron_pickaxe',
    ]);
    assert.equal(simulate(plan, {}).iron_pickaxe, 1);
});

test('what the bot already holds is used, and only the rest is planned', () => {
    const inventory = { stone_pickaxe: 1, crafting_table: 1, stick: 5, cobblestone: 20, coal: 3 };
    const plan = planGoal(haveTool('iron', 'pickaxe'), snapshot(inventory), data);
    assert.deepEqual(texts(plan), ['craft 1 furnace', 'collect 3 iron_ore for raw_iron', 'smelt 3 raw_iron into iron_ingot', 'craft 1 iron_pickaxe']);
    simulate(plan, inventory);
});

test('a better tool satisfies a tool requirement; nothing is planned for it', () => {
    const plan = planGoal(haveItem('cobblestone', 8), snapshot({ iron_pickaxe: 1 }), data);
    assert.deepEqual(texts(plan), ['collect 8 stone for cobblestone']);
});

test('the cheaper route wins: coal is mined, not made by burning logs', () => {
    const plan = planGoal(haveItem('torch', 16), snapshot({ wooden_pickaxe: 1 }), data);
    assert.deepEqual(texts(plan), ['collect 4 coal_ore for coal', 'collect 1 oak_log', 'craft 4 oak_planks', 'craft 4 stick', 'craft 16 torch']);
    simulate(plan, { wooden_pickaxe: 1 });
});

test('crafted blocks are not mistaken for natural sources (a campfire "drops" charcoal)', () => {
    assert.deepEqual(data.sources('charcoal'), []);
    assert.ok(data.sources('cobblestone').includes('stone'));
    assert.deepEqual(data.sources('raw_iron'), ['iron_ore', 'deepslate_iron_ore']);
});

test('storage-form recipes are ignored, so ingots come from ore, not from nuggets or blocks', () => {
    const plan = planGoal(haveItem('iron_ingot', 2), snapshot({ stone_pickaxe: 1, furnace: 1, coal: 1 }), data);
    assert.deepEqual(texts(plan), ['collect 2 iron_ore for raw_iron', 'smelt 2 raw_iron into iron_ingot']);
});

test('merging repeated steps does not put a craft before the logs it needs (one log already in hand)', () => {
    const inventory = { oak_log: 1 };
    const plan = planGoal(haveItem('stone_axe'), snapshot(inventory), data);
    assert.equal(texts(plan)[0], 'collect 2 oak_log');
    assert.equal(simulate(plan, inventory).stone_axe, 1);
});

test('every plan can be executed from the top, for many goals and partial inventories', () => {
    const goals = [haveTool('wooden', 'pickaxe'), haveTool('stone', 'sword'), haveItem('stone_axe'), haveItem('furnace'), haveItem('torch', 16),
        haveTool('iron', 'pickaxe'), haveItem('shield'), haveItem('iron_chestplate'), haveItem('bucket'), haveTool('diamond', 'pickaxe'),
        haveItem('chest', 2), haveItem('ladder', 6), haveItem('oak_boat'), haveItem('bread', 3), haveItem('glass', 4), haveItem('cooked_beef', 9)];
    /** @type {Record<string, number>[]} */
    const inventories = [{}, { oak_log: 1 }, { birch_planks: 1 }, { stick: 1, cobblestone: 2 }, { wooden_pickaxe: 1, coal: 1 }, { crafting_table: 1, oak_planks: 5 },
        { stone_pickaxe: 1, raw_iron: 1, furnace: 1 }, { iron_ingot: 2, stick: 1, iron_pickaxe: 1 }, { golden_pickaxe: 1 }, { charcoal: 2, oak_log: 3, furnace: 1 }];
    const surroundings = [[], ['acacia_log'], ['crafting_table', 'furnace'], ['birch_log', 'stone', 'iron_ore']];
    let checked = 0;
    for (const goal of goals) for (const inventory of inventories) for (const nearby of surroundings) {
        const plan = planGoal(goal, snapshot(inventory, nearby), data);
        if (plan.unresolved.length > 0) { assert.deepEqual(plan.steps, []); continue; }
        const after = simulate(plan, inventory, nearby);
        if (goal.type === 'have_item') assert.ok(after[goal.item] >= goal.count, `${goal.item}: ${JSON.stringify(inventory)} ${nearby}`);
        checked++;
    }
    assert.ok(checked > 500, String(checked));
});

test('a crafting table or furnace standing nearby is used instead of making another', () => {
    const plan = planGoal(haveTool('wooden', 'pickaxe'), snapshot({}, ['crafting_table', 'oak_log']), data);
    assert.ok(!texts(plan).includes('craft 1 crafting_table'), String(texts(plan)));
    assert.equal(texts(plan)[0], 'collect 2 oak_log'); // 3 planks + 2 for sticks = 5 planks = 2 logs
    const smelt = planGoal(haveItem('iron_ingot'), snapshot({ stone_pickaxe: 1, coal: 1 }, ['furnace']), data);
    assert.deepEqual(texts(smelt), ['collect 1 iron_ore for raw_iron', 'smelt 1 raw_iron into iron_ingot']);
});

test('holding a single plank of another wood does not send the bot looking for that tree', () => {
    const plan = planGoal(haveTool('wooden', 'pickaxe'), snapshot({ birch_planks: 1 }, ['oak_log']), data);
    assert.ok(texts(plan).includes('craft 12 oak_planks') || texts(plan).some(t => /craft \d+ oak_planks/.test(t)), String(texts(plan)));
    assert.ok(!texts(plan).some(t => t.includes('birch_log')), String(texts(plan)));
});

test('natural blocks that can also be crafted stay sources; crafted furniture does not', () => {
    assert.deepEqual(data.sources('wheat'), ['wheat']);
    assert.ok(data.sources('clay_ball').includes('clay'));
    assert.ok(data.sources('melon_slice').includes('melon'));
    assert.ok(data.sources('snowball').some(name => name.startsWith('snow')));
    assert.ok(data.sources('sandstone').includes('sandstone'));
    assert.deepEqual(data.sources('book'), []);
});

test('a plan with a hole in it has no steps at all: its easy first steps would look like progress', () => {
    const plan = planGoal(haveItem('nether_star'), snapshot(), data);
    assert.deepEqual(plan, { steps: [], unresolved: ['nether_star'] });
    const beacon = planGoal(haveItem('beacon'), snapshot(), data); // glass and obsidian are doable, the star is not
    assert.deepEqual(beacon.steps, []);
    assert.ok(beacon.unresolved.includes('nether_star'));
});

test('food: hunt whatever animal is around; junk food does not count, for the planner or for isDone', () => {
    const plan = planGoal(haveFood(5), snapshot({ bread: 2, rotten_flesh: 9 }, [], [{ name: 'chicken', kind: 'passive', dist: 3 }, { name: 'pig', kind: 'passive', dist: 8 }]), data);
    assert.deepEqual(texts(plan), ['hunt pig for 3 porkchop']);
    assert.deepEqual(planGoal(haveFood(2), snapshot({ bread: 2 }), data).steps, []);
    assert.equal(isDone(haveFood(5), snapshot({ rotten_flesh: 9 }), data.isFood), false);
    assert.equal(isDone(haveFood(5), snapshot({ bread: 2, porkchop: 3 }), data.isFood), true); // what the plan yields
});

test('focusFor speaks the catalog\'s language: block names for collecting, the input item for smelting', () => {
    const base = { consumes: {}, requires: [] };
    assert.deepEqual(focusFor({ ...base, kind: 'collect', item: 'raw_iron', count: 3, block: 'iron_ore' }),
        { action: 'collect_blocks', target: 'iron_ore', quantity: 3, inSight: true, text: 'collect 3 iron_ore for raw_iron' });
    assert.deepEqual(focusFor({ ...base, kind: 'smelt', item: 'iron_ingot', count: 3, from: 'raw_iron' }),
        { action: 'smelt', target: 'raw_iron', quantity: 3, inSight: true, text: 'smelt 3 raw_iron into iron_ingot' });
    assert.equal(focusFor({ ...base, kind: 'hunt', item: 'beef', count: 2, from: 'cow' }).action, 'attack');
    // crafting is counted in uses of the recipe, which is what !craftRecipe takes: 12 planks = 3 crafts
    assert.equal(focusFor({ ...base, kind: 'craft', item: 'oak_planks', count: 12, crafts: 3 }).quantity, 3);
    // and the focus says when the target still has to be found
    const step = { ...base, kind: /** @type {const} */ ('collect'), item: 'raw_iron', count: 3, block: 'iron_ore' };
    assert.equal(focusFor(step, snapshot({}, ['stone'])).inSight, false);
    assert.equal(focusFor(step, snapshot({}, ['iron_ore'])).inSight, true);
});

test('planning is fast enough to redo on every decision', () => {
    const started = performance.now();
    for (let i = 0; i < 50; i++) planGoal(haveTool('diamond', 'pickaxe'), snapshot(), data);
    assert.ok(performance.now() - started < 1000);
});

test('memory: a log type seen a moment ago beats the everyday oak; one searched for in vain is planned around', () => {
    const collected = (/** @type {any} */ plan) => plan.steps.filter((/** @type {any} */ s) => s.kind === 'collect').map((/** @type {any} */ s) => s.block);
    const empty = snapshot();
    assert.ok(collected(planGoal(haveTool('wooden', 'pickaxe'), empty, data)).includes('oak_log'), 'no memory: oak');
    assert.ok(collected(planGoal(haveTool('wooden', 'pickaxe'), empty, data, { seen: ['acacia_log'] })).includes('acacia_log'));
    const withoutOak = collected(planGoal(haveTool('wooden', 'pickaxe'), empty, data, { absent: ['oak_log'] }));
    assert.ok(!withoutOak.includes('oak_log') && withoutOak.some((/** @type {string} */ b) => b.endsWith('_log')), `planned ${withoutOak}`);
    // what is in sight wins over a failed search: it is right there
    assert.ok(collected(planGoal(haveTool('wooden', 'pickaxe'), snapshot({}, ['oak_log']), data, { absent: ['oak_log'] })).includes('oak_log'));
});
