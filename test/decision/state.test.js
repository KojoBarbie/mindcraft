// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compressState } from '../../src/decision/state.js';
import { estimateTokens } from '../../src/decision/tokens.js';

/** @typedef {import('../../src/decision/snapshot.js').Snapshot} Snapshot */

/**
 * @param {Partial<Snapshot>} [overrides]
 * @returns {Snapshot}
 */
function snapshot(overrides = {}) {
    return {
        hp: 20, food: 20, timeOfDay: 1000, dimension: 'overworld', raining: false,
        pos: { x: 10.4, y: 64, z: -3.6 }, heldItem: null, armor: [], inventory: {}, entities: [], blocks: [],
        action: null, goal: null, recent: [],
        ...overrides,
    };
}

test('a fresh spawn compresses to almost nothing; defaults are left out', () => {
    assert.deepEqual(compressState(snapshot()), { hp: 20, food: 20, time: 'day', pos: [10, 64, -4] });
});

test('day phases', () => {
    const phase = (/** @type {number} */ t) => compressState(snapshot({ timeOfDay: t })).time;
    assert.deepEqual([0, 11999, 12000, 13000, 22999, 23000].map(phase), ['day', 'day', 'dusk', 'night', 'night', 'dawn']);
});

test('the tactical view of a typical mid-game moment', () => {
    const state = compressState(snapshot({
        hp: 13.5, food: 7.2, timeOfDay: 14000, raining: true, heldItem: 'stone_pickaxe', armor: ['iron_chestplate'],
        inventory: { cobblestone: 64, oak_log: 12, stone_pickaxe: 1, bread: 3, dirt: 40, wheat_seeds: 5 },
        entities: [
            { name: 'zombie', kind: 'hostile', dist: 9.2 }, { name: 'zombie', kind: 'hostile', dist: 15.8 },
            { name: 'skeleton', kind: 'hostile', dist: 20 }, { name: 'tomo', kind: 'player', dist: 4.1 },
            { name: 'cow', kind: 'passive', dist: 6 },
        ],
        blocks: [
            { name: 'grass_block', dist: 1, dy: 0 }, { name: 'dirt', dist: 1.5, dy: 0 }, { name: 'iron_ore', dist: 14.2, dy: 0 },
            { name: 'oak_log', dist: 5, dy: 0 }, { name: 'lava', dist: 11, dy: 0 }, { name: 'crafting_table', dist: 3, dy: 0 },
        ],
        action: { name: 'collectBlocks', elapsedMs: 4200 },
        goal: 'have iron_pickaxe',
        recent: [{ cmd: '!craftRecipe("stick", 4)', ok: true }, { cmd: '!collectBlocks("iron_ore", 3)', ok: false, note: 'no path' }],
    }));
    assert.deepEqual(state, {
        hp: 14, food: 7, time: 'night', rain: true, pos: [10, 64, -4], hand: 'stone_pickaxe', armor: ['iron_chestplate'],
        inv: { stone_pickaxe: 1, bread: 3, cobblestone: 64, oak_log: 12, dirt: 40, wheat_seeds: 5 },
        mobs: { zombie: { n: 2, d: 9 }, skeleton: { n: 1, d: 20 } },
        players: { tomo: 4 },
        animals: { cow: 6 },
        hazards: { lava: { d: 11, dy: 0 } },
        blocks: { crafting_table: 3, oak_log: 5, dirt: 2, iron_ore: 14 },
        doing: { a: 'collectBlocks', s: 4 },
        goal: 'have iron_pickaxe',
        last: ['ok !craftRecipe("stick", 4)', 'FAIL !collectBlocks("iron_ore", 3): no path'],
    });
});

test('names in the goal are listed first, in inventory and in blocks', () => {
    const state = compressState(snapshot({
        inventory: { diamond_pickaxe: 1, raw_iron: 2 },
        blocks: [{ name: 'lava', dist: 3, dy: 0 }, { name: 'furnace', dist: 20, dy: 0 }],
        goal: 'smelt raw_iron in a furnace',
    }));
    assert.deepEqual(Object.keys(/** @type {object} */ (state.inv)), ['raw_iron', 'diamond_pickaxe']);
    assert.deepEqual(Object.keys(/** @type {object} */ (state.blocks)), ['furnace']);
    assert.deepEqual(state.hazards, { lava: { d: 3, dy: 0 } });
});

test('goal names match whole identifiers, not substrings', () => {
    const state = compressState(snapshot({ inventory: { diamond: 3, iron_axe: 1 }, goal: 'have diamond_pickaxe' }));
    assert.deepEqual(Object.keys(/** @type {object} */ (state.inv)), ['iron_axe', 'diamond']);
});

test('a big inventory is capped and the remainder is counted', () => {
    /** @type {Record<string, number>} */
    const inventory = { iron_pickaxe: 1, cooked_beef: 8 };
    for (let i = 0; i < 32; i++) inventory[`junk_${i}`] = i + 1;
    const state = compressState(snapshot({ inventory }));
    const listed = Object.keys(/** @type {object} */ (state.inv));
    assert.equal(listed.length, 14);
    assert.deepEqual(listed.slice(0, 2), ['iron_pickaxe', 'cooked_beef']);
    assert.equal(state.inv_more, 20);
    assert.equal(state.inv_nearly_full, true);
});

test('the combat view keeps threats and gear, drops resources and history', () => {
    const state = compressState(snapshot({
        inventory: { iron_sword: 1, cobblestone: 64, bread: 2, iron_helmet: 1 },
        entities: [{ name: 'creeper', kind: 'hostile', dist: 5 }, { name: 'cow', kind: 'passive', dist: 3 }],
        blocks: [{ name: 'iron_ore', dist: 4, dy: 0 }, { name: 'lava', dist: 6, dy: 0 }],
        recent: [{ cmd: '!attack("creeper")', ok: true }],
    }), { view: 'combat' });
    assert.deepEqual(state, {
        hp: 20, food: 20, time: 'day', pos: [10, 64, -4],
        inv: { iron_sword: 1, bread: 2, iron_helmet: 1 },
        mobs: { creeper: { n: 1, d: 5 } },
        hazards: { lava: { d: 6, dy: 0 } },
    });
});

test('the crafting view lists the inventory in full and only counts threats', () => {
    /** @type {Record<string, number>} */
    const inventory = {};
    for (let i = 0; i < 25; i++) inventory[`item_${i}`] = 1;
    const state = compressState(snapshot({
        inventory,
        entities: [{ name: 'zombie', kind: 'hostile', dist: 12 }, { name: 'zombie', kind: 'hostile', dist: 14 }],
        blocks: [{ name: 'crafting_table', dist: 2, dy: 0 }, { name: 'iron_ore', dist: 3, dy: 0 }],
    }), { view: 'crafting' });
    assert.equal(Object.keys(/** @type {object} */ (state.inv)).length, 25);
    assert.equal(state.threats, 2);
    assert.equal(state.mobs, undefined);
    assert.equal(state.pos, undefined);
    assert.deepEqual(state.blocks, { crafting_table: 2 });
});

test('dimension, water, air, worn tool and off hand show up only when they matter', () => {
    assert.equal(compressState(snapshot({ dimension: 'the_nether' })).dim, 'nether');
    assert.equal(compressState(snapshot({ dimension: 'the_end' })).dim, 'end');
    const state = compressState(snapshot({ inWater: true, oxygen: 7.4, heldItem: 'iron_pickaxe', heldDurability: 0.04, offhand: 'shield' }));
    assert.deepEqual([state.in_water, state.air, state.hand_worn, state.offhand], [true, 7, true, 'shield']);
    const calm = compressState(snapshot({ inWater: false, oxygen: 9, heldItem: 'iron_pickaxe', heldDurability: 0.9 }));
    assert.deepEqual([calm.in_water, calm.air, calm.hand_worn, calm.offhand], [undefined, undefined, undefined, undefined]);
});

test('animals are listed only when food is short', () => {
    const cow = [{ name: 'cow', kind: /** @type {const} */ ('passive'), dist: 6 }];
    assert.deepEqual(compressState(snapshot({ entities: cow, inventory: {} })).animals, { cow: 6 });
    assert.equal(compressState(snapshot({ entities: cow, inventory: { bread: 5 }, food: 20 })).animals, undefined);
    assert.deepEqual(compressState(snapshot({ entities: cow, inventory: { bread: 5 }, food: 9 })).animals, { cow: 6 });
});

test('food is recognised from the snapshot\'s registry list when there is one', () => {
    const inventory = { glow_berries: 4, mystery_meat: 2, cobblestone: 64 };
    const known = compressState(snapshot({ inventory, foodItems: ['mystery_meat'] }), { view: 'combat' });
    assert.deepEqual(known.inv, { mystery_meat: 2 });
    const guessed = compressState(snapshot({ inventory }), { view: 'combat' });
    assert.deepEqual(guessed.inv, { glow_berries: 4 });
});

test('the budget holds even against absurdly long free text', () => {
    const state = compressState(snapshot({
        goal: 'collect '.repeat(400),
        recent: [{ cmd: `!newAction("${'x'.repeat(3000)}")`, ok: true }],
        entities: [{ name: 'zombie', kind: 'hostile', dist: 4 }],
    }), { maxTokens: 150 });
    assert.ok(estimateTokens(state) <= 150, String(estimateTokens(state)));
    assert.equal(state.hp, 20);
    assert.deepEqual(state.mobs, { zombie: { n: 1, d: 4 } });
});

test('long failure notes are cut and only the last few actions are kept', () => {
    const recent = Array.from({ length: 6 }, (_, i) => ({ cmd: `!c${i}`, ok: false, note: 'x'.repeat(200) }));
    const state = compressState(snapshot({ recent }));
    const last = /** @type {string[]} */ (state.last);
    assert.equal(last.length, 3);
    assert.ok(last[2].startsWith('FAIL !c5: '));
    assert.ok(last.every(line => line.length <= 140));
});

test('a worst-case busy moment stays within the 500-token budget', () => {
    /** @type {Record<string, number>} */
    const inventory = {};
    for (const name of ['diamond_pickaxe', 'iron_sword', 'cooked_porkchop', 'oak_planks', 'cobblestone', 'iron_ingot',
        'crafting_table', 'furnace', 'torch', 'coal', 'stick', 'raw_iron', 'dirt', 'gravel', 'sand', 'andesite', 'diorite',
        'granite', 'wheat_seeds', 'rotten_flesh', 'bone', 'string', 'arrow', 'spider_eye', 'gunpowder', 'oak_sapling',
        'birch_log', 'spruce_log', 'water_bucket', 'shield', 'bow', 'flint', 'leather', 'feather', 'egg', 'kelp'])
        inventory[name] = 37;
    const mobNames = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'drowned'];
    const state = compressState(snapshot({
        hp: 6, food: 4, timeOfDay: 18000, raining: true, dimension: 'the_nether', heldItem: 'diamond_pickaxe',
        armor: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'],
        inventory,
        entities: [
            ...mobNames.flatMap(name => [{ name, kind: /** @type {const} */ ('hostile'), dist: 7 }, { name, kind: /** @type {const} */ ('hostile'), dist: 12 }]),
            ...['alice_the_builder', 'bob_minecraft_99', 'carol'].map(name => ({ name, kind: /** @type {const} */ ('player'), dist: 5 })),
            ...['cow', 'sheep', 'pig', 'chicken', 'horse'].map(name => ({ name, kind: /** @type {const} */ ('passive'), dist: 9 })),
        ],
        blocks: ['lava', 'fire', 'iron_ore', 'deepslate_diamond_ore', 'coal_ore', 'oak_log', 'stone', 'gravel', 'sand',
            'crafting_table', 'furnace', 'chest', 'obsidian', 'copper_ore', 'gold_ore', 'red_bed']
            .map((name, i) => ({ name, dist: i + 2, dy: -1 })),
        action: { name: 'collectBlocks', elapsedMs: 31000 },
        goal: 'have diamond_pickaxe and return to the base at the red_bed',
        recent: Array.from({ length: 5 }, (_, i) => ({ cmd: `!collectBlocks("deepslate_diamond_ore", ${i})`, ok: false, note: 'Timeout: took too long to decide path to goal' })),
    }));
    const tokens = estimateTokens(state);
    assert.ok(tokens <= 500, `${tokens} tokens: ${JSON.stringify(state)}`);
    // the essentials survive the trimming
    assert.equal(state.hp, 6);
    assert.ok(/** @type {object} */ (state.mobs));
    assert.equal(state.goal, 'have diamond_pickaxe and return to the base at the red_bed');
    assert.ok('lava' in /** @type {object} */ (state.hazards));
});

test('maxTokens sheds detail step by step, least important first', () => {
    const busy = snapshot({
        inventory: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`thing_number_${i}`, 64])),
        entities: [
            { name: 'zombie', kind: 'hostile', dist: 5 },
            ...['cow', 'sheep', 'pig'].map(name => ({ name, kind: /** @type {const} */ ('passive'), dist: 9 })),
        ],
        recent: [{ cmd: '!collectBlocks("stone", 3)', ok: false, note: 'a long explanation of what went wrong here' }],
    });
    const roomy = compressState(busy, { maxTokens: 10_000 });
    assert.ok(roomy.animals);
    const tight = compressState(busy, { maxTokens: 120 });
    assert.ok(estimateTokens(tight) <= 120, String(estimateTokens(tight)));
    assert.equal(tight.animals, undefined);
    assert.deepEqual(tight.mobs, { zombie: { n: 1, d: 5 } });
    assert.ok(Object.keys(/** @type {object} */ (tight.inv)).length < Object.keys(/** @type {object} */ (roomy.inv)).length);
});
