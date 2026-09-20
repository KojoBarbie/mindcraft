// @ts-check
// Reads a raw observation off a mineflayer bot. It imports nothing from Mindcraft on purpose:
// src/agent/library/world.js drags in native dependencies, and everything needed is on the bot object itself.
// compressState() in state.js turns the snapshot into what is actually sent to a decision model.
import { COMMON_RESOURCE_BLOCKS, HAZARD_BLOCK, RARE_RESOURCE_BLOCK, STATION, namesIn } from './interest.js';

/**
 * @typedef {object} EntityObservation
 * @property {string} name e.g. "zombie", or the username for players
 * @property {'hostile' | 'passive' | 'player'} kind
 * @property {number} dist blocks
 */

/**
 * @typedef {object} BlockObservation
 * @property {string} name
 * @property {number} dist blocks, to the nearest one of this type
 * @property {number} dy its height relative to the bot's feet (negative = below)
 */

/**
 * @typedef {object} RecentAction
 * @property {string} cmd e.g. '!collectBlocks("oak_log", 3)'
 * @property {boolean} ok
 * @property {string} [note] short reason when it failed
 */

/**
 * @typedef {object} Snapshot
 * @property {number} hp 0-20
 * @property {number} food 0-20
 * @property {number} [oxygen] 0-20; below 20 means under water
 * @property {boolean} [inWater]
 * @property {number} timeOfDay 0-23999
 * @property {string} dimension
 * @property {boolean} raining
 * @property {{x: number, y: number, z: number}} pos
 * @property {string | null} heldItem
 * @property {number | null} [heldDurability] fraction left, 0-1; null for items that do not wear
 * @property {string | null} [offhand]
 * @property {string[]} armor names of worn pieces
 * @property {Record<string, number>} inventory item name -> count, including the off hand
 * @property {string[]} [foodItems] which inventory names are edible, from the game's registry
 * @property {EntityObservation[]} entities
 * @property {BlockObservation[]} blocks nearest block of each interesting type
 * @property {{name: string, elapsedMs: number} | null} action what the bot is doing right now
 * @property {string | null} goal current (sub)goal, in words
 * @property {RecentAction[]} recent newest last
 */

/**
 * What the snapshot cannot read from the bot.
 * @typedef {object} SnapshotExtras
 * @property {{name: string, elapsedMs: number} | null} [action]
 * @property {string | null} [goal] block names mentioned here are looked for in the world too
 * @property {RecentAction[]} [recent]
 * @property {number} [entityRange] blocks
 * @property {number} [blockRange] blocks
 */

const OFFHAND_SLOT = 45;
const ARMOR_SLOTS = [5, 6, 7, 8]; // helmet, chestplate, leggings, boots

/**
 * mineflayer sets `type` to one of player / hostile / animal / mob / ... and `kind` to the wiki category
 * ("Hostile mobs", "Passive mobs", ...). `type` alone is not enough: in 1.21 slime, magma_cube, ghast,
 * phantom and shulker have type "mob", so they are only recognisable as hostile through `kind`.
 * @param {any} entity
 * @returns {'hostile' | 'passive' | 'player' | null} null for things that are not creatures (items, arrows, ...)
 */
export function entityKind(entity) {
    if (entity.type === 'player') return 'player';
    if (entity.kind === 'Hostile mobs' || entity.type === 'hostile') return 'hostile';
    if (entity.kind === 'Passive mobs' || ['animal', 'passive', 'water_creature', 'ambient'].includes(entity.type))
        return 'passive';
    if (entity.type === 'mob') return 'passive'; // golems, allay: creatures that do not attack the bot
    return null;
}

/** @type {WeakMap<object, {rare: number[], byName: Record<string, {id: number, name: string}>}>} */
const blockIdCache = new WeakMap();

/** @param {any} registry */
function interestingBlockIds(registry) {
    let cached = blockIdCache.get(registry);
    if (!cached) {
        const rare = Object.values(registry.blocksByName)
            .filter((/** @type {any} */ b) => RARE_RESOURCE_BLOCK.test(b.name) || HAZARD_BLOCK.test(b.name) || STATION.test(b.name))
            .map((/** @type {any} */ b) => b.id);
        cached = { rare, byName: registry.blocksByName };
        blockIdCache.set(registry, cached);
    }
    return cached;
}

/**
 * Nearest block of each interesting type. `findBlocks` is only cheap when `matching` is a list of ids (it can
 * then skip chunk sections whose palette has none of them), and its `count` caps the total, not per type. So:
 * one scan for the rare types together, and one single-result lookup for each common type, which would
 * otherwise use up the whole cap.
 * @param {any} bot
 * @param {number} range
 * @param {Set<string>} goalNames
 * @returns {BlockObservation[]}
 */
function nearestBlocks(bot, range, goalNames) {
    const me = bot.entity.position;
    const { rare, byName } = interestingBlockIds(bot.registry);
    /** @type {Map<string, BlockObservation>} */
    const nearest = new Map();
    /** @param {any} position */
    const record = position => {
        const name = bot.blockAt(position)?.name;
        if (name && !nearest.has(name))
            nearest.set(name, { name, dist: position.distanceTo(me), dy: position.y - Math.floor(me.y) });
    };

    const goalIds = [...goalNames].filter(name => byName[name] && !COMMON_RESOURCE_BLOCKS.includes(name)).map(name => byName[name].id);
    for (const position of bot.findBlocks({ matching: [...rare, ...goalIds], maxDistance: range, count: 256 })) record(position);
    for (const name of COMMON_RESOURCE_BLOCKS) {
        if (!byName[name]) continue;
        for (const position of bot.findBlocks({ matching: byName[name].id, maxDistance: range, count: 1 })) record(position);
    }
    return [...nearest.values()];
}

/**
 * @param {any} bot a spawned mineflayer bot
 * @param {SnapshotExtras} [extras]
 * @returns {Snapshot}
 */
export function takeSnapshot(bot, extras = {}) {
    const entityRange = extras.entityRange ?? 24;
    const blockRange = extras.blockRange ?? 16;
    const me = bot.entity.position;

    // items() covers the main inventory and hotbar only; the off hand (a shield, usually) is a separate slot
    const offhand = bot.inventory.slots[OFFHAND_SLOT] ?? null;
    /** @type {Record<string, number>} */
    const inventory = {};
    for (const item of [...bot.inventory.items(), ...(offhand ? [offhand] : [])])
        inventory[item.name] = (inventory[item.name] ?? 0) + item.count;
    const foods = bot.registry?.foodsByName ?? {};

    /** @type {EntityObservation[]} */
    const entities = [];
    for (const entity of Object.values(bot.entities)) {
        if (entity === bot.entity || !entity.position) continue;
        const kind = entityKind(entity);
        if (!kind) continue;
        const dist = entity.position.distanceTo(me);
        if (dist > entityRange) continue;
        entities.push({ name: (kind === 'player' ? entity.username : entity.name) ?? 'unknown', kind, dist });
    }

    const held = bot.heldItem ?? null;
    const maxDurability = held ? bot.registry?.itemsByName?.[held.name]?.maxDurability : undefined;

    return {
        hp: bot.health,
        food: bot.food,
        oxygen: bot.oxygenLevel ?? 20,
        inWater: Boolean(bot.entity.isInWater),
        timeOfDay: bot.time.timeOfDay,
        dimension: bot.game.dimension,
        raining: Boolean(bot.isRaining),
        pos: { x: me.x, y: me.y, z: me.z },
        heldItem: held?.name ?? null,
        heldDurability: held && maxDurability ? 1 - (held.durabilityUsed ?? 0) / maxDurability : null,
        offhand: offhand?.name ?? null,
        armor: ARMOR_SLOTS.map(slot => bot.inventory.slots[slot]?.name).filter(Boolean),
        inventory,
        foodItems: Object.keys(inventory).filter(name => name in foods),
        entities,
        blocks: nearestBlocks(bot, blockRange, namesIn(extras.goal)),
        action: extras.action ?? null,
        goal: extras.goal ?? null,
        recent: extras.recent ?? [],
    };
}
