// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledge } from '../../src/decision/knowledge.js';

/**
 * @param {Record<string, number>} inventory
 * @param {{name: string, dist: number, dy: number}[]} [blocks]
 * @param {string | null} [goal]
 */
function setup(inventory, blocks = [], goal = null) {
    /** @type {{id: number, table: unknown}[]} */
    const recipeCalls = [];
    const itemsByName = Object.fromEntries(['stick', 'oak_planks', 'crafting_table', 'stone_pickaxe', 'wooden_pickaxe', 'iron_pickaxe', 'bread', 'coal', 'raw_iron', 'cobblestone', 'lantern']
        .map((name, id) => [name, { id, name }]));
    const bot = {
        registry: {
            itemsByName,
            foodsByName: { bread: {} },
            blocksByName: {
                oak_log: { diggable: true },
                stone: { diggable: true, harvestTools: { [itemsByName.wooden_pickaxe.id]: true, [itemsByName.stone_pickaxe.id]: true } },
                iron_ore: { diggable: true, harvestTools: { [itemsByName.stone_pickaxe.id]: true, [itemsByName.iron_pickaxe.id]: true } },
                bedrock: { diggable: false },
            },
        },
        /** @param {number} id @param {null} _meta @param {number} _count @param {unknown} table */
        recipesFor(id, _meta, _count, table) {
            recipeCalls.push({ id, table });
            if (id === itemsByName.stick.id) return [{}];                         // 2x2, always
            if (id === itemsByName.stone_pickaxe.id) return table ? [{}] : [];    // needs a table
            if (id === itemsByName.lantern.id) return table ? [{}] : [];
            return [];
        },
    };
    const snapshot = /** @type {import('../../src/decision/snapshot.js').Snapshot} */ ({ inventory, blocks, goal });
    return { knowledge: createKnowledge(bot, snapshot), recipeCalls, itemsByName };
}

test('canHarvest: bare hands, the right tool, the wrong tool, the undiggable', () => {
    const bare = setup({}).knowledge;
    assert.equal(bare.canHarvest('oak_log'), true);
    assert.equal(bare.canHarvest('stone'), false);
    assert.equal(bare.canHarvest('bedrock'), false);
    assert.equal(bare.canHarvest('no_such_block'), false);
    const wooden = setup({ wooden_pickaxe: 1 }).knowledge;
    assert.equal(wooden.canHarvest('stone'), true);
    assert.equal(wooden.canHarvest('iron_ore'), false);
    assert.equal(setup({ stone_pickaxe: 1, wooden_pickaxe: 0 }).knowledge.canHarvest('iron_ore'), true);
});

test('craftable: a crafting table nearby or in the inventory unlocks 3x3 recipes', () => {
    assert.deepEqual(setup({}).knowledge.craftable(), ['stick']);
    assert.deepEqual(setup({ crafting_table: 1 }).knowledge.craftable(), ['stick', 'stone_pickaxe']);
    assert.deepEqual(setup({}, [{ name: 'crafting_table', dist: 5, dy: 0 }]).knowledge.craftable(), ['stick', 'stone_pickaxe']);
    assert.deepEqual(setup({}, [{ name: 'crafting_table', dist: 40, dy: 0 }]).knowledge.craftable(), ['stick']);
});

test('craftable: items named in the goal are considered on top of the curated list', () => {
    assert.ok(!setup({ crafting_table: 1 }).knowledge.craftable().includes('lantern'));
    assert.ok(setup({ crafting_table: 1 }, [], 'have lantern').knowledge.craftable().includes('lantern'));
});

test('smeltable: needs a furnace at hand and fuel', () => {
    const furnace = [{ name: 'furnace', dist: 3, dy: 0 }];
    assert.deepEqual(setup({ raw_iron: 3, coal: 1 }).knowledge.smeltable(), []);
    assert.deepEqual(setup({ raw_iron: 3 }, furnace).knowledge.smeltable(), []);
    assert.deepEqual(setup({ raw_iron: 3, coal: 1, bread: 2 }, furnace).knowledge.smeltable(), ['raw_iron']);
    assert.deepEqual(setup({ raw_iron: 3, oak_planks: 4, furnace: 1 }).knowledge.smeltable(), ['raw_iron']);
});

test('isFood comes from the registry', () => {
    const { knowledge } = setup({});
    assert.equal(knowledge.isFood('bread'), true);
    assert.equal(knowledge.isFood('cobblestone'), false);
});
