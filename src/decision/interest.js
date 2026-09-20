// @ts-check
// Which item and block names matter for deciding. Shared by snapshot.js (what to look for in the world) and
// state.js (what to list first).

export const TOOL = /_(pickaxe|axe|shovel|hoe|sword)$|^(bow|crossbow|shield|shears|trident|mace|flint_and_steel|bucket|water_bucket|lava_bucket|fishing_rod|spyglass|brush)$/;
export const ARMOR = /_(helmet|chestplate|leggings|boots)$|^(elytra|turtle_helmet)$/;
// Fallback only: a snapshot taken from a live bot lists the food items it holds from the game's own registry.
export const FOOD = /^(bread|apple|golden_apple|enchanted_golden_apple|carrot|golden_carrot|potato|baked_potato|beetroot|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|dried_kelp|honey_bottle|mushroom_stew|rabbit_stew|beetroot_soup|suspicious_stew)$|^cooked_|^(beef|porkchop|mutton|chicken|rabbit|cod|salmon|tropical_fish)$/;
export const STATION = /^(crafting_table|furnace|blast_furnace|smoker|chest|barrel|anvil|smithing_table|enchanting_table|brewing_stand|stonecutter|grindstone)$|_bed$/;
export const MATERIAL = /_(log|planks|ingot)$|^(stick|cobblestone|coal|charcoal|diamond|raw_iron|raw_gold|raw_copper|redstone|lapis_lazuli|emerald|flint|string|leather|torch)$/;

/** Blocks that hurt. Always reported, with their height relative to the bot. */
export const HAZARD_BLOCK = /^(lava|fire|soul_fire|magma_block|powder_snow|sweet_berry_bush|cactus|campfire|soul_campfire|wither_rose|pointed_dripstone)$/;
/** Resources rare enough that one scan with a shared result cap finds the nearest of each. */
export const RARE_RESOURCE_BLOCK = /_ore$|_log$|^(clay|obsidian|ancient_debris|sugar_cane|bamboo|pumpkin|melon|wheat|carrots|potatoes|beetroots|water)$/;
/** Resources so common they would fill any shared cap; each is looked up on its own. */
export const COMMON_RESOURCE_BLOCKS = ['stone', 'deepslate', 'cobblestone', 'sand', 'gravel', 'dirt'];

/**
 * The item and block names a goal talks about. Whole identifiers only: "have diamond_pickaxe" is about
 * diamond_pickaxe, not about diamond.
 * @param {string | null | undefined} goal
 * @returns {Set<string>}
 */
export function namesIn(goal) {
    return new Set((goal ?? '').toLowerCase().match(/[a-z][a-z0-9_]*/g) ?? []);
}
