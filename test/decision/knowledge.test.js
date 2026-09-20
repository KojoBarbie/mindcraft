// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledge, isFuel, isSmeltable } from '../../src/decision/knowledge.js';
import { readFileSync } from 'node:fs';

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
            items: Object.fromEntries(Object.values(itemsByName).map(item => [item.id, item])),
            foodsByName: { bread: {} },
            blocksByName: {
                oak_log: { diggable: true },
                stone: { diggable: true, harvestTools: { [itemsByName.wooden_pickaxe.id]: true, [itemsByName.stone_pickaxe.id]: true } },
                iron_ore: { diggable: true, drops: [itemsByName.raw_iron.id], harvestTools: { [itemsByName.stone_pickaxe.id]: true, [itemsByName.iron_pickaxe.id]: true } },
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
    assert.deepEqual(setup({ raw_iron: 3, stick: 9 }, furnace).knowledge.smeltable(), []); // Mindcraft does not burn sticks
});

test('smelting rules match what !smeltItem enforces in src/utils/mcdata.js', () => {
    // mcdata.js cannot be imported here (native dependencies), so compare against its source text instead.
    const source = readFileSync(new URL('../../src/utils/mcdata.js', import.meta.url), 'utf8');
    const list = /misc_smeltables = \[([^\]]+)\]/.exec(source);
    assert.ok(list, 'isSmeltable() in mcdata.js changed shape; update src/decision/knowledge.js');
    const misc = list[1].split(',').map(entry => entry.trim().replace(/'/g, ''));
    for (const name of [...misc, 'raw_iron', 'oak_log']) assert.equal(isSmeltable(name), true, name);
    for (const name of ['iron_ore', 'cactus', 'stick']) assert.equal(isSmeltable(name), false, name);
    assert.match(source, /itemName\.includes\('raw'\) \|\| itemName\.includes\('log'\)/);

    for (const name of ['coal', 'charcoal', 'blaze_rod', 'oak_log', 'birch_planks', 'coal_block', 'lava_bucket'])
        assert.equal(isFuel(name), true, name);
    for (const name of ['stick', 'dried_kelp_block', 'oak_wood', 'bread']) assert.equal(isFuel(name), false, name);
    assert.match(source, /i\.name === 'coal' \|\| i\.name === 'charcoal' \|\| i\.name === 'blaze_rod'/);
    assert.match(source, /i\.name\.includes\('log'\) \|\| i\.name\.includes\('planks'\)/);
    assert.match(source, /i\.name === 'coal_block' \|\| i\.name === 'lava_bucket'/);
});

test('a lone log is not offered as both the thing to smelt and its own fuel', () => {
    const furnace = [{ name: 'furnace', dist: 3, dy: 0 }];
    assert.deepEqual(setup({ oak_log: 1 }, furnace).knowledge.smeltable(), []);
    assert.deepEqual(setup({ oak_log: 2 }, furnace).knowledge.smeltable(), ['oak_log']);
});

test('recipe lookups happen once per snapshot, however often the catalog asks', () => {
    const { knowledge, recipeCalls } = setup({ crafting_table: 1 });
    knowledge.craftable();
    const calls = recipeCalls.length;
    knowledge.craftable();
    knowledge.craftable();
    assert.equal(recipeCalls.length, calls);
});

test('dropsOf and isItem read the registry', () => {
    const { knowledge } = setup({});
    assert.deepEqual(knowledge.dropsOf('iron_ore'), ['raw_iron']);
    assert.deepEqual(knowledge.dropsOf('oak_log'), []);
    assert.equal(knowledge.isItem('bread'), true);
    assert.equal(knowledge.isItem('constructor'), false);
});

test('isFood comes from the registry', () => {
    const { knowledge } = setup({});
    assert.equal(knowledge.isFood('bread'), true);
    assert.equal(knowledge.isFood('cobblestone'), false);
});
