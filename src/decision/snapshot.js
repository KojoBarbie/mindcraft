// @ts-check
// Reads a raw observation off a mineflayer bot. No imports on purpose: src/agent/library/world.js drags in
// native dependencies, and everything needed is on the bot object itself. compressState() in state.js turns
// the snapshot into what is actually sent to a decision model.

/**
 * @typedef {object} EntityObservation
 * @property {string} name e.g. "zombie", or the username for players
 * @property {'hostile' | 'passive' | 'player' | 'other'} kind
 * @property {number} dist blocks
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
 * @property {number} timeOfDay 0-23999
 * @property {string} dimension
 * @property {boolean} raining
 * @property {{x: number, y: number, z: number}} pos
 * @property {string | null} heldItem
 * @property {string[]} armor names of worn pieces
 * @property {Record<string, number>} inventory item name -> count
 * @property {EntityObservation[]} entities
 * @property {{name: string, dist: number}[]} blocks nearest block of each type
 * @property {{name: string, elapsedMs: number} | null} action what the bot is doing right now
 * @property {string | null} goal current (sub)goal, in words
 * @property {RecentAction[]} recent newest last
 */

/**
 * What the snapshot cannot read from the bot.
 * @typedef {object} SnapshotExtras
 * @property {{name: string, elapsedMs: number} | null} [action]
 * @property {string | null} [goal]
 * @property {RecentAction[]} [recent]
 * @property {number} [entityRange] blocks
 * @property {number} [blockRange] blocks
 */

/** @param {any} entity */
function entityKind(entity) {
    if (entity.type === 'player') return 'player';
    if (entity.type === 'hostile') return 'hostile';
    if (entity.type === 'animal' || entity.type === 'passive' || entity.type === 'water_creature' || entity.type === 'ambient')
        return 'passive';
    return 'other';
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

    /** @type {Record<string, number>} */
    const inventory = {};
    for (const item of bot.inventory.items()) inventory[item.name] = (inventory[item.name] ?? 0) + item.count;

    /** @type {EntityObservation[]} */
    const entities = [];
    for (const entity of Object.values(bot.entities)) {
        if (entity === bot.entity || !entity.position) continue;
        const kind = entityKind(entity);
        if (kind === 'other') continue; // dropped items, arrows, boats, ...
        const dist = entity.position.distanceTo(me);
        if (dist > entityRange) continue;
        entities.push({ name: (kind === 'player' ? entity.username : entity.name) ?? 'unknown', kind, dist });
    }

    // nearest block of each type; findBlocks returns positions sorted by distance
    /** @type {Map<string, number>} */
    const nearest = new Map();
    const positions = bot.findBlocks({ matching: (/** @type {any} */ block) => block.name !== 'air', maxDistance: blockRange, count: 4096 });
    for (const position of positions) {
        const name = bot.blockAt(position)?.name;
        if (name && !nearest.has(name)) nearest.set(name, position.distanceTo(me));
    }

    const armorSlots = [5, 6, 7, 8]; // helmet, chestplate, leggings, boots
    return {
        hp: bot.health,
        food: bot.food,
        timeOfDay: bot.time.timeOfDay,
        dimension: bot.game.dimension,
        raining: Boolean(bot.isRaining),
        pos: { x: me.x, y: me.y, z: me.z },
        heldItem: bot.heldItem?.name ?? null,
        armor: armorSlots.map(slot => bot.inventory.slots[slot]?.name).filter(Boolean),
        inventory,
        entities,
        blocks: [...nearest].map(([name, dist]) => ({ name, dist })),
        action: extras.action ?? null,
        goal: extras.goal ?? null,
        recent: extras.recent ?? [],
    };
}
