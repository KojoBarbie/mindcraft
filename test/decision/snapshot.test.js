// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entityKind, takeSnapshot } from '../../src/decision/snapshot.js';

/** @param {number} x @param {number} y @param {number} z */
function vec(x, y, z) {
    return {
        x, y, z,
        /** @param {{x: number, y: number, z: number}} o */
        distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z); },
    };
}

/**
 * A stand-in for a mineflayer bot with just the surface takeSnapshot() reads.
 * @param {{world?: Record<string, ReturnType<typeof vec>[]>, entities?: any[], items?: any[], slots?: Record<number, any>, held?: any}} [setup]
 */
function fakeBot(setup = {}) {
    const world = setup.world ?? {};
    const names = [...new Set([...Object.keys(world), 'stone', 'dirt', 'iron_ore', 'lava', 'crafting_table', 'oak_log', 'glass'])];
    const blocksByName = Object.fromEntries(names.map((name, id) => [name, { id, name }]));
    /** @type {any[]} */
    const findCalls = [];
    const me = { position: vec(0.5, 64, 0.5), isInWater: false };
    const bot = {
        entity: me,
        entities: Object.fromEntries([me, ...(setup.entities ?? [])].map((e, i) => [i, e])),
        health: 17.5, food: 12, oxygenLevel: 20, isRaining: false,
        time: { timeOfDay: 6000 }, game: { dimension: 'overworld' },
        heldItem: setup.held ?? null,
        inventory: { items: () => setup.items ?? [], slots: setup.slots ?? {} },
        registry: {
            blocksByName,
            foodsByName: { bread: {}, golden_carrot: {} },
            itemsByName: { iron_pickaxe: { maxDurability: 250 }, bread: {} },
        },
        /** @param {{matching: number | number[], maxDistance: number, count: number}} query */
        findBlocks(query) {
            findCalls.push(query);
            const ids = Array.isArray(query.matching) ? query.matching : [query.matching];
            return Object.entries(world)
                .filter(([name]) => ids.includes(blocksByName[name].id))
                .flatMap(([, positions]) => positions)
                .filter(p => p.distanceTo(me.position) <= query.maxDistance)
                .sort((a, b) => a.distanceTo(me.position) - b.distanceTo(me.position))
                .slice(0, query.count);
        },
        /** @param {ReturnType<typeof vec>} position */
        blockAt(position) {
            const hit = Object.entries(world).find(([, positions]) => positions.includes(position));
            return hit ? { name: hit[0] } : null;
        },
    };
    return { bot, findCalls };
}

test('entityKind: hostile mobs whose type is "mob" are recognised through kind', () => {
    assert.equal(entityKind({ type: 'hostile', kind: 'Hostile mobs', name: 'zombie' }), 'hostile');
    for (const name of ['slime', 'ghast', 'phantom', 'magma_cube', 'shulker'])
        assert.equal(entityKind({ type: 'mob', kind: 'Hostile mobs', name }), 'hostile', name);
    assert.equal(entityKind({ type: 'animal', kind: 'Passive mobs', name: 'cow' }), 'passive');
    assert.equal(entityKind({ type: 'mob', kind: 'Passive mobs', name: 'iron_golem' }), 'passive');
    assert.equal(entityKind({ type: 'player', username: 'tomo' }), 'player');
    assert.equal(entityKind({ type: 'object', kind: 'Drops', name: 'item' }), null);
    assert.equal(entityKind({ type: 'projectile', kind: 'Projectiles', name: 'arrow' }), null);
});

test('entities: creatures in range only, players by username, the bot itself excluded', () => {
    const { bot } = fakeBot({ entities: [
        { type: 'mob', kind: 'Hostile mobs', name: 'phantom', position: vec(0.5, 74, 0.5) },
        { type: 'hostile', kind: 'Hostile mobs', name: 'zombie', position: vec(100, 64, 0) },
        { type: 'player', username: 'tomo', position: vec(3.5, 64, 0.5) },
        { type: 'object', kind: 'Drops', name: 'item', position: vec(1, 64, 1) },
        { type: 'animal', kind: 'Passive mobs', name: 'cow' }, // no position yet
    ] });
    assert.deepEqual(takeSnapshot(bot).entities, [
        { name: 'phantom', kind: 'hostile', dist: 10 },
        { name: 'tomo', kind: 'player', dist: 3 },
    ]);
});

test('inventory includes the off hand; food comes from the registry; durability is a fraction', () => {
    const { bot } = fakeBot({
        items: [{ name: 'bread', count: 3 }, { name: 'bread', count: 2 }, { name: 'golden_carrot', count: 1 }, { name: 'cobblestone', count: 64 }],
        slots: { 5: { name: 'iron_helmet' }, 8: { name: 'iron_boots' }, 45: { name: 'shield', count: 1 } },
        held: { name: 'iron_pickaxe', durabilityUsed: 240 },
    });
    const snapshot = takeSnapshot(bot);
    assert.deepEqual(snapshot.inventory, { bread: 5, golden_carrot: 1, cobblestone: 64, shield: 1 });
    assert.deepEqual(snapshot.foodItems, ['bread', 'golden_carrot']);
    assert.equal(snapshot.offhand, 'shield');
    assert.deepEqual(snapshot.armor, ['iron_helmet', 'iron_boots']);
    assert.ok(Math.abs(/** @type {number} */ (snapshot.heldDurability) - 0.04) < 1e-9);
});

test('blocks: nearest of each interesting type with relative height; scenery is never asked for', () => {
    const { bot, findCalls } = fakeBot({ world: {
        iron_ore: [vec(0, 50, 0), vec(0, 60, 0)],
        lava: [vec(2, 62, 0)],
        stone: [vec(0, 63, 0), vec(1, 63, 0)],
        glass: [vec(1, 64, 0)],
    } });
    const blocks = takeSnapshot(bot).blocks;
    const byName = Object.fromEntries(blocks.map(b => [b.name, b]));
    assert.deepEqual(Object.keys(byName).sort(), ['iron_ore', 'lava', 'stone']);
    assert.equal(byName.iron_ore.dy, -4); // the nearer of the two
    assert.equal(byName.lava.dy, -2);
    // every query is by id (so mineflayer can skip chunk sections), never a predicate over all blocks
    assert.ok(findCalls.length > 1);
    for (const call of findCalls)
        assert.ok(typeof call.matching === 'number' || (Array.isArray(call.matching) && call.matching.every((/** @type {unknown} */ id) => typeof id === 'number')));
    const glassId = bot.registry.blocksByName.glass.id;
    assert.ok(findCalls.every(call => ![call.matching].flat().includes(glassId)));
});

test('common blocks are looked up one by one so they cannot crowd out rare ones', () => {
    const stone = Array.from({ length: 400 }, (_, i) => vec(i % 5, 63, 1));
    const { bot } = fakeBot({ world: { stone, iron_ore: [vec(0, 52, 0)] } });
    const names = takeSnapshot(bot).blocks.map(b => b.name);
    assert.ok(names.includes('iron_ore'));
    assert.ok(names.includes('stone'));
});

test('a block named in the goal is searched for even if it is not otherwise interesting', () => {
    const { bot } = fakeBot({ world: { glass: [vec(4, 64, 0)] } });
    assert.deepEqual(takeSnapshot(bot).blocks, []);
    assert.deepEqual(takeSnapshot(bot, { goal: 'collect glass' }).blocks.map(b => b.name), ['glass']);
});
