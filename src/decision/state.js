// @ts-check
import { estimateTokens } from './tokens.js';
import { ARMOR, FOOD, HAZARD_BLOCK, MATERIAL, RARE_RESOURCE_BLOCK, COMMON_RESOURCE_BLOCKS, STATION, TOOL, namesIn } from './interest.js';
// Turns a Snapshot into the small JSON object a decision model sees. Decision models bill by input size and
// answer faster on less, and the loop asks about once a second, so this is the main cost lever: the target is
// a few hundred tokens, not a few thousand. English keys only; models are strongest there.

/** @typedef {import('./snapshot.js').Snapshot} Snapshot */

/**
 * - tactical: what to do next. Everything, trimmed.
 * - combat:   fight or flee. Threats, health, gear; no resource blocks, no full inventory.
 * - crafting: what to make. Inventory in full, workstations nearby; no mobs beyond a threat count.
 * @typedef {'tactical' | 'combat' | 'crafting'} StateView
 */

/**
 * @typedef {object} CompressOptions
 * @property {StateView} [view]
 * @property {number} [maxInventory] item types listed by name
 * @property {number} [maxBlocks] block types listed
 * @property {number} [maxRecent] recent actions listed
 * @property {number} [maxTokens] hard budget (estimated). If the state is still over it, detail is shed step by
 *   step, least important first, so a crowded moment can never blow up the cost of a decision.
 */

/** @param {number} timeOfDay */
function dayPhase(timeOfDay) {
    if (timeOfDay < 12000) return 'day';
    if (timeOfDay < 13000) return 'dusk';
    if (timeOfDay < 23000) return 'night'; // hostile mobs spawn
    return 'dawn';
}

/**
 * How much a name matters for deciding, higher first. Names that appear in the goal always win.
 * @param {string} name
 * @param {Set<string>} goal
 * @param {Set<string> | null} foods edible names according to the game; null = unknown, fall back to a pattern
 */
function itemPriority(name, goal, foods) {
    if (goal.has(name)) return 6;
    if (TOOL.test(name)) return 5;
    if (foods ? foods.has(name) : FOOD.test(name)) return 4;
    if (ARMOR.test(name)) return 3;
    if (STATION.test(name)) return 2;
    if (MATERIAL.test(name)) return 1;
    return 0;
}

/**
 * @param {Snapshot} snapshot
 * @param {CompressOptions} [options]
 * @returns {Record<string, unknown>} plain JSON within `maxTokens`; keys with nothing to say are left out
 */
export function compressState(snapshot, options = {}) {
    const maxTokens = options.maxTokens ?? 500;
    let state = build(snapshot, options);
    // Shed detail until it fits. Each step keeps what the previous one kept, minus something less important.
    const steps = [
        { maxAnimals: 0 },
        { maxAnimals: 0, noteLength: 0 },
        { maxAnimals: 0, noteLength: 0, maxInventory: 8, maxBlocks: 6 },
        { maxAnimals: 0, noteLength: 0, maxInventory: 8, maxBlocks: 6, maxRecent: 1, maxPlayers: 3, maxMobTypes: 4 },
        { maxAnimals: 0, noteLength: 0, maxInventory: 4, maxBlocks: 3, maxRecent: 0, maxPlayers: 1, maxMobTypes: 2 },
    ];
    for (const limits of steps) {
        if (estimateTokens(state) <= maxTokens) return state;
        state = build(snapshot, { ...options, ...limits });
    }
    // Still over: free text is the only thing left that can be arbitrarily long. Cut it, then drop whole
    // sections, least important first. What remains (hp, food, time, threats) is always tiny.
    if (estimateTokens(state) > maxTokens && typeof state.goal === 'string') state.goal = state.goal.slice(0, 80);
    for (const key of ['last', 'animals', 'blocks', 'inv', 'players', 'armor', 'goal', 'hazards', 'mobs']) {
        if (estimateTokens(state) <= maxTokens) break;
        delete state[key];
    }
    return state;
}

/**
 * @param {Snapshot} snapshot
 * @param {CompressOptions & {maxAnimals?: number, maxPlayers?: number, maxMobTypes?: number, noteLength?: number}} options
 * @returns {Record<string, unknown>}
 */
function build(snapshot, options) {
    const view = options.view ?? 'tactical';
    const maxAnimals = options.maxAnimals ?? 4;
    const maxPlayers = options.maxPlayers ?? 6;
    const maxMobTypes = options.maxMobTypes ?? 8;
    const noteLength = options.noteLength ?? 60;
    const maxInventory = options.maxInventory ?? (view === 'crafting' ? 30 : view === 'combat' ? 6 : 14);
    const maxBlocks = options.maxBlocks ?? (view === 'crafting' ? 6 : 10);
    const maxRecent = options.maxRecent ?? 3;
    const goalText = snapshot.goal ?? '';
    const goal = namesIn(goalText);
    const foods = snapshot.foodItems ? new Set(snapshot.foodItems) : null;

    /** @type {Record<string, unknown>} */
    const state = {
        hp: Math.round(snapshot.hp),
        food: Math.round(snapshot.food),
        time: dayPhase(snapshot.timeOfDay),
    };
    if (snapshot.dimension !== 'overworld') state.dim = snapshot.dimension.replace(/^the_/, '');
    if (snapshot.raining) state.rain = true;
    if (view !== 'crafting') state.pos = [snapshot.pos.x, snapshot.pos.y, snapshot.pos.z].map(Math.round);
    if (snapshot.inWater) state.in_water = true;
    // only under water: mineflayer's oxygenLevel is not reliable on land (observed 9 while standing in the open)
    if (snapshot.inWater && snapshot.oxygen !== undefined && snapshot.oxygen < 20) state.air = Math.round(snapshot.oxygen);
    if (snapshot.heldItem) state.hand = snapshot.heldItem;
    if (typeof snapshot.heldDurability === 'number' && snapshot.heldDurability < 0.1) state.hand_worn = true; // about to break
    if (snapshot.offhand) state.offhand = snapshot.offhand;
    if (snapshot.armor.length > 0) state.armor = snapshot.armor;

    // Inventory: the most decision-relevant types by name, the rest as a count.
    const items = Object.entries(snapshot.inventory)
        .filter(([, count]) => count > 0)
        .filter(([name]) => view !== 'combat' || itemPriority(name, goal, foods) >= 3) // gear and food only
        .sort(([a, countA], [b, countB]) =>
            itemPriority(b, goal, foods) - itemPriority(a, goal, foods) || countB - countA || a.localeCompare(b));
    if (items.length > 0) {
        state.inv = Object.fromEntries(items.slice(0, maxInventory));
        if (items.length > maxInventory && view !== 'combat') state.inv_more = items.length - maxInventory;
    }
    const usedTypes = Object.values(snapshot.inventory).filter(count => count > 0).length;
    if (usedTypes >= 30) state.inv_nearly_full = true; // 36 slots; by type count this is a lower bound

    // Hostile mobs grouped by type: how many and how close is what matters, not each one's coordinates.
    /** @type {Record<string, {n: number, d: number}>} */
    const mobs = {};
    /** @type {Record<string, number>} */
    const players = {};
    /** @type {Record<string, number>} */
    const animals = {};
    for (const entity of snapshot.entities) {
        const d = Math.round(entity.dist);
        if (entity.kind === 'hostile') {
            const group = mobs[entity.name] ??= { n: 0, d };
            group.n++;
            group.d = Math.min(group.d, d);
        } else if (entity.kind === 'player') {
            players[entity.name] = Math.min(players[entity.name] ?? d, d);
        } else if (entity.kind === 'passive') {
            animals[entity.name] = Math.min(animals[entity.name] ?? d, d);
        }
    }
    if (view === 'crafting') {
        const threats = Object.values(mobs).reduce((sum, group) => sum + group.n, 0);
        if (threats > 0) state.threats = threats;
    } else if (Object.keys(mobs).length > 0) {
        const closest = Object.entries(mobs).sort(([, a], [, b]) => a.d - b.d);
        state.mobs = Object.fromEntries(closest.slice(0, maxMobTypes));
        const unlisted = closest.slice(maxMobTypes).reduce((sum, [, group]) => sum + group.n, 0);
        if (unlisted > 0) state.mobs_more = unlisted;
    }
    if (Object.keys(players).length > 0) {
        const closest = Object.entries(players).sort(([, a], [, b]) => a - b);
        state.players = Object.fromEntries(closest.slice(0, maxPlayers));
    }
    // Animals are food on legs; they only matter to a decision when food is short.
    const hasFood = Object.keys(snapshot.inventory).some(name => (foods ? foods.has(name) : FOOD.test(name)));
    if (view === 'tactical' && maxAnimals > 0 && (!hasFood || snapshot.food <= 14) && Object.keys(animals).length > 0) {
        const closest = Object.entries(animals).sort(([, a], [, b]) => a - b).slice(0, maxAnimals);
        state.animals = Object.fromEntries(closest);
    }

    // Hazards always, with relative height: lava 3 blocks away matters very differently below the feet or level.
    const hazards = snapshot.blocks.filter(block => HAZARD_BLOCK.test(block.name)).sort((a, b) => a.dist - b.dist).slice(0, 3);
    if (hazards.length > 0)
        state.hazards = Object.fromEntries(hazards.map(block => [block.name, { d: Math.round(block.dist), dy: Math.round(block.dy) }]));

    // Blocks: nearest distance per useful type. Resources unless fighting; only workstations when crafting.
    const isResource = (/** @type {string} */ name) => RARE_RESOURCE_BLOCK.test(name) || COMMON_RESOURCE_BLOCKS.includes(name);
    const blocks = snapshot.blocks
        .filter(block => !HAZARD_BLOCK.test(block.name))
        .filter(block => STATION.test(block.name) || goal.has(block.name) || (view === 'tactical' && isResource(block.name)))
        .sort((a, b) => Number(goal.has(b.name)) - Number(goal.has(a.name)) || a.dist - b.dist)
        .slice(0, maxBlocks);
    if (blocks.length > 0) state.blocks = Object.fromEntries(blocks.map(block => [block.name, Math.round(block.dist)]));

    if (snapshot.action) state.doing = { a: snapshot.action.name, s: Math.round(snapshot.action.elapsedMs / 1000) };
    if (goalText) state.goal = goalText;
    if (view !== 'combat' && maxRecent > 0 && snapshot.recent.length > 0) {
        state.last = snapshot.recent.slice(-maxRecent).map(action =>
            (action.ok ? `ok ${action.cmd.slice(0, 60)}` : `FAIL ${action.cmd.slice(0, 60)}${action.note && noteLength > 0 ? `: ${action.note.slice(0, noteLength)}` : ''}`));
    }
    return state;
}
