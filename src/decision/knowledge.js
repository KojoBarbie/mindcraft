// @ts-check
// Game knowledge the catalog needs but a snapshot does not carry: what can be harvested with what, what can be
// crafted or smelted right now. Read from the bot's registry (minecraft-data) and recipe lookup at call time.

/**
 * @typedef {object} Knowledge
 * @property {(blockName: string) => boolean} canHarvest with anything the bot is carrying (or bare hands)
 * @property {() => string[]} craftable item names that can be crafted right now
 * @property {() => string[]} smeltable inventory item names a furnace accepts, if a furnace and fuel are at hand
 * @property {(name: string) => boolean} isFood
 */

// Things worth offering to craft. Asking the recipe book about every one of ~1300 items on each decision
// would be slow and would drown the model in options; names mentioned in the goal are added on top.
export const CRAFT_CANDIDATES = [
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
    'stick', 'crafting_table', 'furnace', 'chest', 'torch', 'bread', 'bucket', 'shield', 'bow', 'arrow', 'white_bed', 'oak_boat', 'oak_door', 'ladder',
    ...['wooden', 'stone', 'iron', 'diamond'].flatMap(tier => ['pickaxe', 'axe', 'sword', 'shovel', 'hoe'].map(tool => `${tier}_${tool}`)),
    ...['iron', 'diamond'].flatMap(tier => ['helmet', 'chestplate', 'leggings', 'boots'].map(piece => `${tier}_${piece}`)),
];

const SMELTABLE = /^raw_(iron|gold|copper)$|_ore$|^(beef|porkchop|mutton|chicken|rabbit|cod|salmon|potato|kelp|sand|cobblestone|clay_ball|cactus)$|_log$/;
const FUEL = /^(coal|charcoal|coal_block|lava_bucket|blaze_rod|dried_kelp_block)$|_(planks|log|wood)$|^stick$/;

/**
 * @param {any} bot a spawned mineflayer bot
 * @param {import('./snapshot.js').Snapshot} snapshot taken from the same bot
 * @param {{reach?: number}} [options] how close a workstation must be to count as usable, in blocks
 * @returns {Knowledge}
 */
export function createKnowledge(bot, snapshot, options = {}) {
    const reach = options.reach ?? 16;
    const registry = bot.registry;
    const has = (/** @type {string} */ name) => (snapshot.inventory[name] ?? 0) > 0;
    const near = (/** @type {string} */ name) => snapshot.blocks.some(block => block.name === name && block.dist <= reach);
    const heldIds = new Set(Object.keys(snapshot.inventory).filter(has).map(name => registry.itemsByName[name]?.id));

    return {
        canHarvest(blockName) {
            const block = registry.blocksByName[blockName];
            if (!block || !block.diggable) return false;
            if (!block.harvestTools) return true; // anything works, including a fist
            return Object.keys(block.harvestTools).some(id => heldIds.has(Number(id)));
        },

        craftable() {
            // Mindcraft's craftRecipe places a crafting table from the inventory if needed, so carrying one counts.
            const table = near('crafting_table') || has('crafting_table');
            const goalNames = (snapshot.goal ?? '').toLowerCase().match(/[a-z][a-z0-9_]*/g) ?? [];
            const names = new Set([...CRAFT_CANDIDATES, ...goalNames]);
            return [...names].filter(name => {
                const item = registry.itemsByName[name];
                return item && bot.recipesFor(item.id, null, 1, table ? true : null).length > 0;
            });
        },

        smeltable() {
            if (!(near('furnace') || has('furnace'))) return [];
            if (!Object.keys(snapshot.inventory).some(name => has(name) && FUEL.test(name))) return [];
            return Object.keys(snapshot.inventory).filter(name => has(name) && SMELTABLE.test(name));
        },

        isFood(name) {
            return name in (registry.foodsByName ?? {});
        },
    };
}
