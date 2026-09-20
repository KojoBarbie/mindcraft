// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, amounts, buildCommand, listActions, listQuantities, listTargets } from '../../src/decision/catalog.js';
import { chooseCommand } from '../../src/decision/choose.js';
import { createMockProvider, resilient } from '../../src/decision/index.js';

/** @typedef {import('../../src/decision/snapshot.js').Snapshot} Snapshot */
/** @typedef {import('../../src/decision/catalog.js').CatalogContext} CatalogContext */

/**
 * @param {Partial<Snapshot>} [snapshot]
 * @param {Partial<import('../../src/decision/knowledge.js').Knowledge>} [knowledge]
 * @returns {CatalogContext}
 */
function ctx(snapshot = {}, knowledge = {}) {
    return {
        snapshot: {
            hp: 20, food: 20, timeOfDay: 1000, dimension: 'overworld', raining: false, pos: { x: 0, y: 70, z: 0 },
            heldItem: null, armor: [], inventory: {}, entities: [], blocks: [], action: null, goal: null, recent: [],
            ...snapshot,
        },
        knowledge: {
            canHarvest: name => !name.endsWith('_ore'),
            craftable: () => [],
            smeltable: () => [],
            isFood: name => ['bread', 'cooked_beef'].includes(name),
            ...knowledge,
        },
    };
}
const ids = (/** @type {CatalogContext} */ c) => listActions(c).map(a => a.id);

test('with nothing around and nothing in hand, only moving and waiting are possible', () => {
    assert.deepEqual(ids(ctx()), ['explore', 'wait']);
});

test('the catalog never offers more than 20 actions, and ids are unique', () => {
    assert.ok(ACTIONS.length <= 20);
    assert.equal(new Set(ACTIONS.map(a => a.id)).size, ACTIONS.length);
});

test('blocks that cannot be harvested with what the bot carries are not offered', () => {
    const blocks = [{ name: 'iron_ore', dist: 3, dy: 0 }, { name: 'oak_log', dist: 5, dy: 0 }, { name: 'lava', dist: 2, dy: -1 }, { name: 'chest', dist: 4, dy: 0 }];
    assert.deepEqual(listTargets(ctx({ blocks }), 'collect_blocks'), ['oak_log']);
    const withPickaxe = ctx({ blocks }, { canHarvest: () => true });
    assert.deepEqual(listTargets(withPickaxe, 'collect_blocks'), ['iron_ore', 'oak_log']); // nearest first; never lava or chests
});

test('crafting and smelting appear only when there is something to make', () => {
    assert.ok(!ids(ctx()).includes('craft'));
    const c = ctx({ inventory: { raw_iron: 5 } }, { craftable: () => ['stick'], smeltable: () => ['raw_iron'] });
    assert.ok(ids(c).includes('craft') && ids(c).includes('smelt'));
    assert.deepEqual(listQuantities(c, 'smelt', 'raw_iron'), [1, 5]);
});

test('eating needs food and an appetite', () => {
    assert.ok(!ids(ctx({ inventory: { bread: 3 }, food: 20 })).includes('eat'));
    assert.ok(!ids(ctx({ inventory: { cobblestone: 3 }, food: 8 })).includes('eat'));
    assert.deepEqual(listTargets(ctx({ inventory: { bread: 3, cobblestone: 9 }, food: 8 }), 'eat'), ['bread']);
});

test('equip skips what is already worn or held', () => {
    const c = ctx({ inventory: { iron_sword: 1, stone_pickaxe: 1, iron_helmet: 1, shield: 1, dirt: 9 }, heldItem: 'iron_sword', armor: ['iron_helmet'], offhand: 'shield' });
    assert.deepEqual(listTargets(c, 'equip'), ['stone_pickaxe']);
});

test('fighting and fleeing depend on who is around', () => {
    const entities = [
        { name: 'zombie', kind: /** @type {const} */ ('hostile'), dist: 9 }, { name: 'zombie', kind: /** @type {const} */ ('hostile'), dist: 4 },
        { name: 'cow', kind: /** @type {const} */ ('passive'), dist: 2 }, { name: 'tomo', kind: /** @type {const} */ ('player'), dist: 6 },
    ];
    const c = ctx({ entities });
    assert.deepEqual(listTargets(c, 'attack'), ['zombie', 'cow']); // players are never attack targets
    assert.ok(ids(c).includes('flee'));
    assert.deepEqual(listTargets(c, 'go_to_player'), ['tomo']);
    assert.ok(!ids(ctx({ entities: [entities[2]] })).includes('flee'));
});

test('situational actions: sleep at night near a bed, surface when deep, dig with a pickaxe, drop when full', () => {
    const bed = [{ name: 'red_bed', dist: 6, dy: 0 }];
    assert.ok(!ids(ctx({ blocks: bed, timeOfDay: 6000 })).includes('sleep'));
    assert.ok(ids(ctx({ blocks: bed, timeOfDay: 14000 })).includes('sleep'));
    assert.ok(ids(ctx({ pos: { x: 0, y: 12, z: 0 } })).includes('go_to_surface'));
    assert.ok(!ids(ctx()).includes('dig_down'));
    assert.ok(ids(ctx({ inventory: { stone_pickaxe: 1 } })).includes('dig_down'));
    const full = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`thing_${i}`, i + 1]));
    assert.ok(ids(ctx({ inventory: full })).includes('drop_items'));
    assert.ok(!ids(ctx({ inventory: { dirt: 64 } })).includes('drop_items'));
});

test('amounts offers round steps up to what is available', () => {
    assert.deepEqual(amounts(0), []);
    assert.deepEqual(amounts(1), [1]);
    assert.deepEqual(amounts(3), [1, 3]);
    assert.deepEqual(amounts(20), [1, 4, 16, 20]);
    assert.deepEqual(amounts(64), [1, 4, 16, 64]);
    assert.deepEqual(amounts(200), [1, 4, 16, 64]);
});

test('commands are built in Mindcraft syntax', () => {
    const c = ctx({
        inventory: { bread: 2, cobblestone: 40, crafting_table: 1 }, food: 10,
        blocks: [{ name: 'oak_log', dist: 3, dy: 0 }, { name: 'chest', dist: 5, dy: 0 }],
        entities: [{ name: 'tomo', kind: 'player', dist: 4 }],
    }, { craftable: () => ['stick'] });
    assert.equal(buildCommand(c, { id: 'collect_blocks', target: 'oak_log', quantity: 4 }), '!collectBlocks("oak_log", 4)');
    assert.equal(buildCommand(c, { id: 'craft', target: 'stick', quantity: 1 }), '!craftRecipe("stick", 1)');
    assert.equal(buildCommand(c, { id: 'eat', target: 'bread' }), '!consume("bread")');
    assert.equal(buildCommand(c, { id: 'go_to_player', target: 'tomo' }), '!goToPlayer("tomo", 3)');
    assert.equal(buildCommand(c, { id: 'give_to_player', target: 'tomo:cobblestone', quantity: 16 }), '!givePlayer("tomo", "cobblestone", 16)');
    assert.equal(buildCommand(c, { id: 'store_in_chest', target: 'cobblestone', quantity: 40 }), '!putInChest("cobblestone", 40)');
    assert.equal(buildCommand(c, { id: 'place_block', target: 'crafting_table' }), '!placeHere("crafting_table")');
    assert.equal(buildCommand(c, { id: 'explore', quantity: 32 }), '!moveAway(32)');
    assert.equal(buildCommand(c, { id: 'wait' }), '!stay(5)');
});

test('a selection the catalog would not have offered can never become a command', () => {
    const c = ctx({ blocks: [{ name: 'iron_ore', dist: 3, dy: 0 }] });
    assert.throws(() => buildCommand(c, { id: 'collect_blocks', target: 'iron_ore', quantity: 1 }), /not possible right now/);
    const logs = ctx({ blocks: [{ name: 'oak_log', dist: 3, dy: 0 }] });
    assert.throws(() => buildCommand(logs, { id: 'collect_blocks', target: 'diamond_ore', quantity: 1 }), /not a valid target/);
    assert.throws(() => buildCommand(logs, { id: 'collect_blocks', target: 'oak_log', quantity: 999 }), /not a valid quantity/);
    assert.throws(() => buildCommand(logs, { id: 'collect_blocks", 1); !newAction("x' }), /Unknown action/);
});

test('whatever a model picks, the result is a well-formed command (fuzz over seeds)', async () => {
    const c = ctx({
        food: 9, timeOfDay: 15000, pos: { x: 0, y: 30, z: 0 },
        inventory: { bread: 2, cobblestone: 40, iron_pickaxe: 1, iron_sword: 1, raw_iron: 7, coal: 3, crafting_table: 1, torch: 5 },
        blocks: [{ name: 'oak_log', dist: 3, dy: 0 }, { name: 'iron_ore', dist: 6, dy: -2 }, { name: 'chest', dist: 5, dy: 0 }, { name: 'furnace', dist: 4, dy: 0 }, { name: 'red_bed', dist: 8, dy: 0 }],
        entities: [{ name: 'zombie', kind: 'hostile', dist: 7 }, { name: 'tomo', kind: 'player', dist: 4 }, { name: 'pig', kind: 'passive', dist: 9 }],
    }, { canHarvest: () => true, craftable: () => ['stick', 'stone_pickaxe'], smeltable: () => ['raw_iron'] });
    assert.ok(listActions(c).length <= 20);
    const seen = new Set();
    for (let seed = 1; seed <= 200; seed++) {
        const chosen = await chooseCommand(resilient([createMockProvider({ seed })]), c, {});
        assert.match(chosen.command, /^![a-zA-Z]+\((("[a-z0-9_]+"|-?\d+)(, ("[a-z0-9_]+"|-?\d+))*)?\)$/, chosen.command);
        assert.ok(chosen.decisions >= 1 && chosen.decisions <= 3);
        seen.add(chosen.action);
    }
    assert.ok(seen.size >= 12, `only saw ${[...seen]}`);
});

test('stages with a single option are not asked; confidence is the weakest stage', async () => {
    /** @type {string[]} */
    const asked = [];
    const provider = resilient([createMockProvider({
        policy: (_state, question) => {
            asked.push(question.id);
            return question.id === 'action' ? 'collect_blocks' : undefined; // random (uniform) for the quantity
        },
    })]);
    const c = ctx({ blocks: [{ name: 'oak_log', dist: 3, dy: 0 }] });
    const chosen = await chooseCommand(provider, c, {});
    assert.deepEqual(asked, ['action', 'quantity']); // one target only, so no target question
    assert.equal(chosen.target, 'oak_log');
    assert.equal(chosen.decisions, 2);
    assert.ok(Math.abs(/** @type {number} */ (chosen.confidence) - 1 / 3) < 1e-9);

    const nothingToDecide = await chooseCommand(provider, ctx(), {}, { only: ['wait'] });
    assert.deepEqual([nothingToDecide.command, nothingToDecide.decisions, nothingToDecide.confidence], ['!stay(5)', 0, 1]);
});

test('the first stage can be restricted, e.g. to safety actions while something else is running', async () => {
    const c = ctx({ entities: [{ name: 'zombie', kind: 'hostile', dist: 3 }], blocks: [{ name: 'oak_log', dist: 3, dy: 0 }] });
    for (let seed = 1; seed <= 30; seed++) {
        const chosen = await chooseCommand(resilient([createMockProvider({ seed })]), c, {}, { only: ['flee', 'attack', 'wait'] });
        assert.ok(['flee', 'attack', 'wait'].includes(chosen.action));
    }
});
