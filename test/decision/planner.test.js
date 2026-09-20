// @ts-check
// The planner is tested against the real game data (minecraft-data is pure JS), not a fake: the interesting
// failures are in how real recipes and drops are shaped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mcdata from 'minecraft-data';
import { createGameData, focusFor, haveFood, haveItem, haveTool, planGoal } from '../../src/decision/index.js';

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
 * @param {import('../../src/decision/planner.js').Plan} plan
 * @param {Record<string, number>} inventory
 */
function simulate(plan, inventory) {
    const stock = { ...inventory };
    const take = (/** @type {string} */ item, /** @type {number} */ n, /** @type {string} */ why) => {
        assert.ok((stock[item] ?? 0) >= n, `${why}: needs ${n} ${item}, has ${stock[item] ?? 0}`);
        stock[item] -= n;
    };
    for (const step of plan.steps) {
        const label = focusFor(step).text;
        if (step.kind === 'collect') {
            const tools = data.harvestTools(/** @type {string} */ (step.block));
            if (tools) assert.ok(tools.some(tool => (stock[tool] ?? 0) > 0), `${label}: no tool among ${tools}`);
        } else if (step.kind === 'craft') {
            const recipe = data.recipes(step.item).find(r => Object.entries(r.ingredients).every(([name, n]) => (stock[name] ?? 0) >= n * step.count / r.makes));
            assert.ok(recipe, `${label}: no recipe is satisfied by ${JSON.stringify(stock)}`);
            if (recipe.needsTable) assert.ok((stock.crafting_table ?? 0) > 0, `${label}: needs a crafting table`);
            for (const [name, n] of Object.entries(recipe.ingredients)) take(name, n * step.count / recipe.makes, label);
        } else if (step.kind === 'smelt') {
            assert.ok((stock.furnace ?? 0) > 0, `${label}: needs a furnace`);
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

test('every rung of multi-step plans is executable in order (simulated), across goals', () => {
    for (const goal of [haveTool('stone', 'sword'), haveItem('furnace'), haveItem('shield'), haveItem('iron_chestplate'),
        haveItem('bucket'), haveTool('diamond', 'pickaxe'), haveItem('chest', 2), haveItem('white_bed')]) {
        const plan = planGoal(goal, snapshot(), data);
        if (plan.unresolved.length === 0) simulate(plan, {});
    }
});

test('things it cannot work out are reported, not silently dropped', () => {
    const plan = planGoal(haveItem('nether_star'), snapshot(), data);
    assert.deepEqual(plan.steps, []);
    assert.deepEqual(plan.unresolved, ['nether_star']);
});

test('food: hunt whatever animal is around', () => {
    const plan = planGoal(haveFood(5), snapshot({ bread: 2 }, [], [{ name: 'pig', kind: 'passive', dist: 8 }]), data);
    assert.deepEqual(texts(plan), ['hunt pig for 3 porkchop']);
    assert.deepEqual(planGoal(haveFood(2), snapshot({ bread: 2 }), data).steps, []);
});

test('focusFor speaks the catalog\'s language: block names for collecting, the input item for smelting', () => {
    assert.deepEqual(focusFor({ kind: 'collect', item: 'raw_iron', count: 3, block: 'iron_ore' }),
        { action: 'collect_blocks', target: 'iron_ore', quantity: 3, text: 'collect 3 iron_ore for raw_iron' });
    assert.deepEqual(focusFor({ kind: 'smelt', item: 'iron_ingot', count: 3, from: 'raw_iron' }),
        { action: 'smelt', target: 'raw_iron', quantity: 3, text: 'smelt 3 raw_iron into iron_ingot' });
    assert.equal(focusFor({ kind: 'hunt', item: 'beef', count: 2, from: 'cow' }).action, 'attack');
});

test('planning is fast enough to redo on every decision', () => {
    const started = performance.now();
    for (let i = 0; i < 50; i++) planGoal(haveTool('diamond', 'pickaxe'), snapshot(), data);
    assert.ok(performance.now() - started < 1000);
});
