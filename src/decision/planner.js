// @ts-check
// Backward-chaining planner: from "have iron_pickaxe" to an ordered list of collect / craft / smelt / hunt
// steps, with no model involved. It accounts for what the bot already holds and for crafting leftovers, picks
// wood variants that are actually at hand, and asks for the cheapest tool that can do the job.
import { worthMaking } from './gamedata.js';

/** @typedef {import('./snapshot.js').Snapshot} Snapshot */
/** @typedef {import('./gamedata.js').GameData} GameData */
/** @typedef {import('./gamedata.js').Recipe} Recipe */
/** @typedef {import('./goals.js').Goal} Goal */

/**
 * @typedef {object} Step
 * @property {'collect' | 'craft' | 'smelt' | 'hunt'} kind
 * @property {string} item what the step yields
 * @property {number} count how many of `item` are needed from this step
 * @property {string} [block] collect: the block to mine
 * @property {string} [from] smelt: the input item; hunt: the animal
 */

/**
 * @typedef {object} Plan
 * @property {Step[]} steps in an order that respects dependencies; the first one can be started now
 * @property {string[]} unresolved items the planner found no way to obtain
 */

// Recipes that only reshuffle storage forms (9 nuggets -> ingot, block -> 9 ingots) lead the search in circles.
const COMPRESSED = /_block$|_nugget$|^(bone_meal|dried_kelp_block|hay_block)$/;
const FUELS = ['coal', 'charcoal'];
const COMMON_MATERIAL = /^oak_|^cobblestone$/;
const EVERYDAY_BLOCK = /_log$|^(stone|dirt|sand|gravel|coal_ore|iron_ore|copper_ore|clay|short_grass)$/;
const MAX_DEPTH = 12;

/**
 * @param {Goal} goal
 * @param {Snapshot} snapshot
 * @param {GameData} data
 * @returns {Plan}
 */
export function planGoal(goal, snapshot, data) {
    /** @type {Record<string, number>} what the bot will hold as the plan unfolds */
    const stock = { ...snapshot.inventory };
    const nearby = new Set(snapshot.blocks.map(block => block.name));
    /** @type {Step[]} */
    const steps = [];
    /** @type {Set<string>} */
    const unresolved = new Set();

    /**
     * Rough effort to get one of an item from the current position: used only to choose between recipe
     * variants (acacia or oak planks? coal or charcoal?), so it needs to rank sensibly, not be accurate.
     * @param {string} item @param {number} depth @returns {number}
     */
    function cost(item, depth = 0) {
        if ((stock[item] ?? 0) > 0) return 0;
        const blocks = data.sources(item);
        if (blocks.some(block => nearby.has(block))) return 1;
        // out of sight: everyday blocks (trees, stone, common ores) are a short walk away, the rest may be far
        let best = blocks.length === 0 ? Infinity : blocks.some(block => EVERYDAY_BLOCK.test(block)) ? 2 : 4;
        if (depth < 3) {
            for (const recipe of usableRecipes(item))
                best = Math.min(best, 1 + Object.keys(recipe.ingredients).reduce((sum, name) => sum + cost(name, depth + 1), 0));
            const smeltInput = data.smeltedFrom(item);
            if (smeltInput) best = Math.min(best, 3 + cost(smeltInput, depth + 1));
        }
        if (data.huntedFrom(item)) best = Math.min(best, 4);
        return Number.isFinite(best) ? best : 50;
    }

    /** @param {string} item */
    function usableRecipes(item) {
        return data.recipes(item).filter(recipe => !Object.keys(recipe.ingredients).some(name => COMPRESSED.test(name) || name === item));
    }

    /** @param {string} item @param {Set<string>} path */
    function bestRecipe(item, path) {
        const candidates = usableRecipes(item).filter(recipe => !Object.keys(recipe.ingredients).some(name => path.has(name)));
        /** @param {Recipe} recipe */
        const effort = recipe => Object.keys(recipe.ingredients).reduce((sum, name) => sum + cost(name), 0);
        // Among equally cheap variants prefer the everyday materials, then minecraft-data's order.
        /** @param {Recipe} recipe */
        const everyday = recipe => Object.keys(recipe.ingredients).some(name => COMMON_MATERIAL.test(name)) ? 0 : 1;
        return candidates.map((recipe, index) => ({ recipe, index, effort: effort(recipe), everyday: everyday(recipe) }))
            .sort((a, b) => a.effort - b.effort || a.everyday - b.everyday || a.index - b.index)[0]?.recipe ?? null;
    }

    /**
     * Make sure a tool or workstation is held. It is not used up, so the stock is left as it is.
     * @param {string[]} acceptable any of these will do, cheapest first
     * @param {Set<string>} path
     * @param {number} depth
     */
    function ensureHeld(acceptable, path, depth) {
        if (acceptable.some(name => (stock[name] ?? 0) > 0)) return;
        const toMake = acceptable.find(worthMaking) ?? acceptable[0];
        obtain(toMake, 1, path, depth);
        stock[toMake] = (stock[toMake] ?? 0) + 1; // obtain() consumed it; put it back, it stays in hand
    }

    /**
     * Arrange for `count` of `item` and take them out of the stock (they are about to be used).
     * @param {string} item @param {number} count @param {Set<string>} path @param {number} depth
     */
    function obtain(item, count, path, depth) {
        const held = stock[item] ?? 0;
        if (held >= count) {
            stock[item] = held - count;
            return;
        }
        const missing = count - held;
        if (depth > MAX_DEPTH || path.has(item)) {
            unresolved.add(item);
            return;
        }
        const next = new Set(path).add(item);

        const recipe = bestRecipe(item, next);
        const smeltInput = data.smeltedFrom(item);
        const blocks = data.sources(item);
        const animal = data.huntedFrom(item);

        if (recipe) {
            const crafts = Math.ceil(missing / recipe.makes);
            if (recipe.needsTable) ensureHeld(['crafting_table'], next, depth + 1);
            for (const [ingredient, perCraft] of Object.entries(recipe.ingredients)) obtain(ingredient, perCraft * crafts, next, depth + 1);
            steps.push({ kind: 'craft', item, count: crafts * recipe.makes });
            stock[item] = held + crafts * recipe.makes - count;
        } else if (smeltInput) {
            ensureHeld(['furnace'], next, depth + 1);
            obtain(smeltInput, missing, next, depth + 1);
            const fuel = FUELS.find(name => (stock[name] ?? 0) > 0) ?? FUELS[0];
            obtain(fuel, Math.ceil(missing / 8), next, depth + 1); // one coal smelts 8 items
            steps.push({ kind: 'smelt', item, count: missing, from: smeltInput });
            stock[item] = 0;
        } else if (blocks.length > 0) {
            // a block that is in sight beats one that is not; otherwise the plain variant (iron_ore, not deepslate_)
            const block = blocks.find(name => nearby.has(name)) ?? blocks.find(name => !name.startsWith('deepslate_')) ?? blocks[0];
            const tools = data.harvestTools(block);
            if (tools) ensureHeld(tools, next, depth + 1);
            steps.push({ kind: 'collect', item, count: missing, block });
            stock[item] = 0;
        } else if (animal) {
            steps.push({ kind: 'hunt', item, count: missing, from: animal });
            stock[item] = 0;
        } else {
            unresolved.add(item);
        }
    }

    switch (goal.type) {
        case 'have_item':
            if ((stock[goal.item] ?? 0) < goal.count) obtain(goal.item, goal.count, new Set(), 0);
            break;
        case 'have_tool':
            obtain(`${goal.tier}_${goal.tool}`, 1, new Set(), 0);
            break;
        case 'have_food': {
            const held = Object.entries(stock).reduce((sum, [name, n]) => sum + (data.isFood(name) ? n : 0), 0);
            const animal = snapshot.entities.find(e => e.kind === 'passive' && ['cow', 'pig', 'sheep', 'chicken'].includes(e.name))?.name ?? 'cow';
            const meat = { cow: 'beef', pig: 'porkchop', sheep: 'mutton', chicken: 'chicken' }[animal] ?? 'beef';
            if (held < goal.count) steps.push({ kind: 'hunt', item: meat, count: goal.count - held, from: animal });
            break;
        }
    }
    return { steps: mergeSteps(steps), unresolved: [...unresolved] };
}

/**
 * Fold repeated steps into their first occurrence ("collect oak_log" three times -> once, for the total).
 * Moving work earlier never breaks an ordering: whatever it depends on was merged earlier still.
 * @param {Step[]} steps
 */
function mergeSteps(steps) {
    /** @type {Map<string, Step>} */
    const merged = new Map();
    for (const step of steps) {
        const key = `${step.kind}:${step.item}:${step.block ?? step.from ?? ''}`;
        const first = merged.get(key);
        if (first) first.count += step.count;
        else merged.set(key, { ...step });
    }
    return [...merged.values()];
}

/**
 * @typedef {object} Focus
 * @property {string} action catalog action id
 * @property {string} [target] catalog target
 * @property {number} [quantity]
 * @property {string} text short English for the model's state
 */

/**
 * What the tactical layer should be doing for a step, in the catalog's vocabulary.
 * @param {Step} step
 * @returns {Focus}
 */
export function focusFor(step) {
    switch (step.kind) {
        case 'collect':
            return { action: 'collect_blocks', target: step.block, quantity: step.count, text: `collect ${step.count} ${step.block}${step.block !== step.item ? ` for ${step.item}` : ''}` };
        case 'craft':
            return { action: 'craft', target: step.item, quantity: step.count, text: `craft ${step.count} ${step.item}` };
        case 'smelt':
            return { action: 'smelt', target: step.from, quantity: step.count, text: `smelt ${step.count} ${step.from} into ${step.item}` };
        case 'hunt':
            return { action: 'attack', target: step.from, text: `hunt ${step.from} for ${step.count} ${step.item}` };
    }
}
