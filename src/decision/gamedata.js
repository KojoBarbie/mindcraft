// @ts-check
// Game knowledge for the planner, behind a small interface so the planner itself stays pure. The real
// implementation reads minecraft-data (pure JS, so it works in unit tests and CI); tests can also fake it.

/**
 * @typedef {object} Recipe
 * @property {number} makes how many items one craft yields
 * @property {Record<string, number>} ingredients item name -> count per craft
 * @property {boolean} needsTable false if it fits the 2x2 inventory grid
 */

/**
 * @typedef {object} GameData
 * @property {(item: string) => Recipe[]} recipes
 * @property {(item: string) => string[]} sources blocks that drop the item when mined
 * @property {(block: string) => string[] | null} harvestTools tools that can harvest the block, cheapest first; null = bare hands
 * @property {(item: string) => string | null} smeltedFrom what to put in a furnace to get the item
 * @property {(item: string) => string | null} huntedFrom the animal that drops the item
 * @property {(item: string) => boolean} isItem
 * @property {(item: string) => boolean} isFood
 */

const TIERS = ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite'];
/** @param {string} tool */
const tierRank = tool => {
    const rank = TIERS.indexOf(tool.split('_')[0]);
    return rank === -1 ? TIERS.length : rank;
};
// Gold tools are weak and gold is rarer than iron: never plan to make one.
/** @param {string} tool */
const worthMaking = tool => !tool.startsWith('golden_') && !tool.startsWith('netherite_');

const SMELTED_FROM = {
    iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper', glass: 'sand', stone: 'cobblestone',
    smooth_stone: 'stone', brick: 'clay_ball', charcoal: 'oak_log',
    cooked_beef: 'beef', cooked_porkchop: 'porkchop', cooked_mutton: 'mutton', cooked_chicken: 'chicken',
    cooked_rabbit: 'rabbit', cooked_cod: 'cod', cooked_salmon: 'salmon', baked_potato: 'potato', dried_kelp: 'kelp',
};
const HUNTED_FROM = {
    beef: 'cow', leather: 'cow', porkchop: 'pig', mutton: 'sheep', chicken: 'chicken', feather: 'chicken',
    rabbit: 'rabbit', string: 'spider', bone: 'skeleton', gunpowder: 'creeper', rotten_flesh: 'zombie',
};
// minecraft-data lists only one drop per block; where that is not the block's usual drop, say so here.
const DROP_OVERRIDES = {
    gravel: ['gravel', 'flint'], wheat: ['wheat', 'wheat_seeds'], carrots: ['carrot'], potatoes: ['potato'],
    beetroots: ['beetroot', 'beetroot_seeds'], short_grass: ['wheat_seeds'],
};

/**
 * @param {any} registry `require('minecraft-data')(version)`, or a mineflayer bot's `bot.registry`
 * @returns {GameData}
 */
export function createGameData(registry) {
    /** @param {number | {id: number} | null} entry */
    const nameOf = entry => (entry == null ? null : registry.items[typeof entry === 'number' ? entry : entry.id]?.name ?? null);

    /** @type {Map<string, string[]>} item -> blocks dropping it */
    const droppedBy = new Map();
    for (const block of Object.values(registry.blocksByName)) {
        const b = /** @type {any} */ (block);
        if (!b.diggable) continue;
        // Only blocks found in nature count as a source. A campfire "drops" charcoal and a bookshelf books, but
        // somebody has to craft and place them first; anything with a crafting recipe is left out.
        const asItem = registry.itemsByName[b.name];
        if (asItem && (registry.recipes[asItem.id] ?? []).length > 0) continue;
        const drops = DROP_OVERRIDES[/** @type {keyof typeof DROP_OVERRIDES} */ (b.name)] ?? (b.drops ?? []).map(nameOf).filter(Boolean);
        for (const item of drops) droppedBy.set(item, [...(droppedBy.get(item) ?? []), b.name]);
    }

    /** @type {Map<string, Recipe[]>} */
    const recipeCache = new Map();

    return {
        recipes(item) {
            let cached = recipeCache.get(item);
            if (!cached) {
                const id = registry.itemsByName[item]?.id;
                cached = (registry.recipes[id] ?? []).map((/** @type {any} */ raw) => {
                    const cells = raw.inShape ? raw.inShape.flat() : raw.ingredients;
                    /** @type {Record<string, number>} */
                    const ingredients = {};
                    for (const cell of cells) {
                        const name = nameOf(cell);
                        if (name) ingredients[name] = (ingredients[name] ?? 0) + 1;
                    }
                    const needsTable = raw.inShape
                        ? raw.inShape.length > 2 || raw.inShape.some((/** @type {unknown[]} */ row) => row.length > 2)
                        : raw.ingredients.length > 4;
                    return { makes: raw.result.count, ingredients, needsTable };
                });
                recipeCache.set(item, /** @type {Recipe[]} */ (cached));
            }
            return /** @type {Recipe[]} */ (cached);
        },

        sources: item => droppedBy.get(item) ?? [],

        harvestTools(block) {
            const tools = registry.blocksByName[block]?.harvestTools;
            if (!tools) return null;
            return Object.keys(tools).map(id => nameOf(Number(id))).filter(name => name !== null)
                .sort((a, b) => tierRank(a) - tierRank(b));
        },

        smeltedFrom: item => SMELTED_FROM[/** @type {keyof typeof SMELTED_FROM} */ (item)] ?? null,
        huntedFrom: item => HUNTED_FROM[/** @type {keyof typeof HUNTED_FROM} */ (item)] ?? null,
        isItem: item => Object.hasOwn(registry.itemsByName, item),
        isFood: item => Object.hasOwn(registry.foodsByName ?? {}, item),
    };
}

export { tierRank, worthMaking };
