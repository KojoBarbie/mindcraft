// @ts-check
// Backward-chaining planner: from "have iron_pickaxe" to an ordered list of collect / craft / smelt / hunt
// steps, with no model involved. It accounts for what the bot already holds and for crafting leftovers, picks
// wood variants that are actually at hand, and asks for the cheapest tool that can do the job.
import { COMPRESSED, worthMaking } from './gamedata.js';
import { goodFood } from './goals.js';

/** @typedef {import('./snapshot.js').Snapshot} Snapshot */
/** @typedef {import('./gamedata.js').GameData} GameData */
/** @typedef {import('./gamedata.js').Recipe} Recipe */
/** @typedef {import('./goals.js').Goal} Goal */

/**
 * @typedef {object} Step
 * @property {'collect' | 'craft' | 'smelt' | 'hunt'} kind
 * @property {string} item what the step yields
 * @property {number} count how many of `item` the step yields
 * @property {number} [crafts] craft: how many times the recipe is used (what !craftRecipe takes)
 * @property {string} [block] collect: the block to mine
 * @property {string} [from] smelt: the input item; hunt: the animal
 * @property {Record<string, number>} consumes items used up by the whole step
 * @property {string[][]} requires things that must be at hand but are not used up; each entry is an any-of list
 */

/**
 * @typedef {object} Plan
 * @property {Step[]} steps in an order that respects dependencies; the first one can be started now.
 *   Empty when the goal is already met, and also when `unresolved` is not: a plan with a hole in it is not
 *   worth starting, and its easy first steps would look like progress.
 * @property {string[]} unresolved items the planner found no way to obtain
 */

const FUELS = ['coal', 'charcoal'];
const COMMON_MATERIAL = /^oak_|^cobblestone$/;
const EVERYDAY_BLOCK = /_log$|^(stone|dirt|sand|gravel|coal_ore|iron_ore|copper_ore|clay|short_grass)$/;
const STATIONS = ['crafting_table', 'furnace'];
const MAX_DEPTH = 12;

/**
 * @typedef {object} PlanMemory what the bot has learnt about its surroundings beyond what is in sight now
 * @property {Iterable<string>} [seen] block types seen recently: somewhere near, if not in sight
 * @property {Iterable<string>} [absent] block types searched for and not found: do not plan around them for now
 */

/**
 * @param {Goal} goal
 * @param {Snapshot} snapshot
 * @param {GameData} data
 * @param {PlanMemory} [memory]
 * @returns {Plan}
 */
export function planGoal(goal, snapshot, data, memory = {}) {
    /** @type {Record<string, number>} what the bot will hold as the plan unfolds */
    const stock = { ...snapshot.inventory };
    const nearby = new Set(snapshot.blocks.map(block => block.name));
    const seen = new Set(memory.seen ?? []);
    const absent = new Set([...(memory.absent ?? [])].filter(name => !nearby.has(name)));
    // Where an item can be mined, minus what a search has just failed to find: in a savanna the bot must not
    // keep looking for oak because oak is the "everyday" log when acacia is what grows there.
    /** @param {string} item */
    const sourcesOf = item => data.sources(item).filter(block => !absent.has(block));
    /** @type {Step[]} */
    const steps = [];
    /** @type {Set<string>} */
    const unresolved = new Set();

    /**
     * Rough effort to get `count` of an item from the current position: used only to choose between recipe
     * variants (acacia or oak planks? coal or charcoal?), so it needs to rank sensibly, not be accurate.
     * Holding one birch plank does not make birch free when twelve are needed.
     * @param {string} item @param {number} count @param {number} depth @returns {number}
     */
    function cost(item, count, depth = 0) {
        if ((stock[item] ?? 0) >= count) return 0;
        const blocks = sourcesOf(item);
        if (blocks.some(block => nearby.has(block))) return 1;
        if (blocks.some(block => seen.has(block))) return 1.5;
        // out of sight: everyday blocks (trees, stone, common ores) are a short walk away, the rest may be far
        let best = blocks.length === 0 ? Infinity : blocks.some(block => EVERYDAY_BLOCK.test(block)) ? 2 : 4;
        if (depth < 3) {
            for (const recipe of usableRecipes(item)) {
                const crafts = Math.ceil(count / recipe.makes);
                best = Math.min(best, 1 + Object.entries(recipe.ingredients).reduce((sum, [name, n]) => sum + cost(name, n * crafts, depth + 1), 0));
            }
            const smeltInput = data.smeltedFrom(item);
            if (smeltInput) best = Math.min(best, 3 + cost(smeltInput, count, depth + 1));
        }
        if (data.huntedFrom(item)) best = Math.min(best, 4);
        return Number.isFinite(best) ? best : 50;
    }

    /** @param {string} item */
    function usableRecipes(item) {
        return data.recipes(item).filter(recipe => !Object.keys(recipe.ingredients).some(name => COMPRESSED.test(name) || name === item));
    }

    /** @param {string} item @param {number} missing @param {Set<string>} path */
    function bestRecipe(item, missing, path) {
        const candidates = usableRecipes(item).filter(recipe => !Object.keys(recipe.ingredients).some(name => path.has(name)));
        /** @param {Recipe} recipe */
        const effort = recipe => {
            const crafts = Math.ceil(missing / recipe.makes);
            return Object.entries(recipe.ingredients).reduce((sum, [name, n]) => sum + cost(name, n * crafts), 0);
        };
        // Among equally cheap variants prefer the everyday materials, then minecraft-data's order.
        /** @param {Recipe} recipe */
        const everyday = recipe => (Object.keys(recipe.ingredients).some(name => COMMON_MATERIAL.test(name)) ? 0 : 1);
        return candidates.map((recipe, index) => ({ recipe, index, effort: effort(recipe), everyday: everyday(recipe) }))
            .sort((a, b) => a.effort - b.effort || a.everyday - b.everyday || a.index - b.index)[0]?.recipe ?? null;
    }

    /**
     * Make sure a tool or workstation is at hand. It is not used up, so the stock is left as it is.
     * A crafting table or furnace standing nearby is as good as one in the inventory.
     * @param {string[]} acceptable any of these will do, cheapest first
     * @param {Set<string>} path
     * @param {number} depth
     */
    function ensureHeld(acceptable, path, depth) {
        if (acceptable.some(name => (stock[name] ?? 0) > 0 || (STATIONS.includes(name) && nearby.has(name)))) return;
        const toMake = acceptable.find(worthMaking) ?? acceptable[0];
        const before = unresolved.size;
        obtain(toMake, 1, path, depth);
        if (unresolved.size === before) stock[toMake] = (stock[toMake] ?? 0) + 1; // obtain() used it up; it stays in hand
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

        const recipe = bestRecipe(item, missing, next);
        const smeltInput = data.smeltedFrom(item);
        const blocks = sourcesOf(item);
        const animal = data.huntedFrom(item);

        /** @type {(() => void)[]} ways to get the item, best first; the first one that works is kept */
        const routes = [];
        if (recipe) routes.push(() => {
            const crafts = Math.ceil(missing / recipe.makes);
            if (recipe.needsTable) ensureHeld(['crafting_table'], next, depth + 1);
            /** @type {Record<string, number>} */
            const consumes = {};
            for (const [ingredient, perCraft] of Object.entries(recipe.ingredients)) {
                consumes[ingredient] = perCraft * crafts;
                obtain(ingredient, perCraft * crafts, next, depth + 1);
            }
            steps.push({ kind: 'craft', item, count: crafts * recipe.makes, crafts, consumes, requires: recipe.needsTable ? [['crafting_table']] : [] });
            stock[item] = held + crafts * recipe.makes - count;
        });
        if (smeltInput) routes.push(() => {
            ensureHeld(['furnace'], next, depth + 1);
            obtain(smeltInput, missing, next, depth + 1);
            const fuel = FUELS.find(name => (stock[name] ?? 0) > 0) ?? FUELS[0];
            const fuelCount = Math.ceil(missing / 8); // one coal smelts 8 items
            obtain(fuel, fuelCount, next, depth + 1);
            steps.push({ kind: 'smelt', item, count: missing, from: smeltInput, consumes: { [smeltInput]: missing, [fuel]: fuelCount }, requires: [['furnace']] });
            stock[item] = 0;
        });
        // Mining a manufactured item (a beacon, a crafting table) is only sensible when one is actually there;
        // otherwise the bot would go hunting the world for something nobody has built yet.
        if (blocks.length > 0 && (!recipe || blocks.some(name => nearby.has(name)))) routes.push(() => {
            // a block that is in sight beats one that is not; otherwise the plain variant (iron_ore, not deepslate_)
            const block = blocks.find(name => nearby.has(name)) ?? blocks.find(name => seen.has(name))
                ?? blocks.find(name => !name.startsWith('deepslate_')) ?? blocks[0];
            const tools = data.harvestTools(block);
            if (tools) ensureHeld(tools, next, depth + 1);
            steps.push({ kind: 'collect', item, count: missing, block, consumes: {}, requires: tools ? [tools] : [] });
            stock[item] = 0;
        });
        if (animal) routes.push(() => {
            steps.push({ kind: 'hunt', item, count: missing, from: animal, consumes: {}, requires: [] });
            stock[item] = 0;
        });

        if (routes.length === 0) {
            unresolved.add(item);
            return;
        }
        // Try the routes in order and keep the first that works out. Without this the planner would commit to
        // the cheapest-looking recipe even when its ingredients turn out to be unobtainable (leather can be
        // crafted from rabbit hide, which nothing in the world drops) instead of going hunting.
        for (const [index, route] of routes.entries()) {
            const saved = { stock: { ...stock }, steps: steps.length, unresolved: new Set(unresolved) };
            route();
            if (unresolved.size === saved.unresolved.size) return;
            if (index === routes.length - 1) return; // nothing worked: leave the last attempt's gaps on record
            for (const key of Object.keys(stock)) delete stock[key];
            Object.assign(stock, saved.stock);
            steps.length = saved.steps;
            unresolved.clear();
            for (const name of saved.unresolved) unresolved.add(name);
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
            const good = goodFood(snapshot, data.isFood); // the same definition isDone() uses
            const held = Object.entries(stock).reduce((sum, [name, n]) => sum + (good(name) ? n : 0), 0);
            const MEAT = { cow: 'beef', pig: 'porkchop', sheep: 'mutton' }; // raw chicken is not good food
            const animal = snapshot.entities.find(e => e.kind === 'passive' && e.name in MEAT)?.name ?? 'cow';
            if (held < goal.count)
                steps.push({ kind: 'hunt', item: MEAT[/** @type {keyof typeof MEAT} */ (animal)], count: goal.count - held, from: animal, consumes: {}, requires: [] });
            break;
        }
    }
    if (unresolved.size > 0) return { steps: [], unresolved: [...unresolved] };
    return { steps: schedule(steps, snapshot.inventory, nearby), unresolved: [] };
}

/**
 * Fold repeated steps together ("collect oak_log" three times -> once, for the total) and put them in an order
 * that can be executed from the top. Merging alone is not safe: with one log in hand, the first planks craft
 * needs no collecting but the second does, and folding the crafts together would put them before the logs.
 * So the merged steps are re-ordered by simulation: take the earliest one that can run with what is in hand.
 * @param {Step[]} raw valid in the order given, which is the fallback if the merged steps cannot be ordered
 * @param {Record<string, number>} inventory
 * @param {Set<string>} nearby
 * @returns {Step[]}
 */
function schedule(raw, inventory, nearby) {
    /** @type {Map<string, Step>} */
    const merged = new Map();
    for (const step of raw) {
        // the ingredients are part of the identity: sticks from oak planks and sticks from acacia planks are
        // different recipes, and one !craftRecipe call cannot mix them
        const key = `${step.kind}:${step.item}:${step.block ?? step.from ?? ''}:${Object.keys(step.consumes).sort().join('+')}`;
        const first = merged.get(key);
        if (!first) {
            merged.set(key, { ...step, consumes: { ...step.consumes } });
            continue;
        }
        first.count += step.count;
        if (step.crafts) first.crafts = (first.crafts ?? 0) + step.crafts;
        for (const [name, n] of Object.entries(step.consumes)) first.consumes[name] = (first.consumes[name] ?? 0) + n;
    }

    const stock = { ...inventory };
    const waiting = [...merged.values()];
    /** @type {Step[]} */
    const ordered = [];
    /** @param {Step} step */
    const canRun = step =>
        Object.entries(step.consumes).every(([name, n]) => (stock[name] ?? 0) >= n)
        && step.requires.every(anyOf => anyOf.some(name => (stock[name] ?? 0) > 0 || (STATIONS.includes(name) && nearby.has(name))));
    while (waiting.length > 0) {
        const index = waiting.findIndex(canRun);
        if (index === -1) return raw; // cannot happen for plans built above; never return an order we cannot vouch for
        const [step] = waiting.splice(index, 1);
        for (const [name, n] of Object.entries(step.consumes)) stock[name] -= n;
        stock[step.item] = (stock[step.item] ?? 0) + step.count;
        ordered.push(step);
    }
    return ordered;
}

/**
 * @typedef {object} Focus
 * @property {string} action catalog action id
 * @property {string} [target] catalog target
 * @property {number} [quantity] in the unit the command takes: blocks to collect, times to craft, items to smelt.
 *   May exceed what the catalog offers in one go; the caller clamps it and the plan is recomputed afterwards.
 * @property {boolean} inSight false when the block or animal is not in the snapshot: go and look for it first
 * @property {string} text short English for the model's state
 */

/**
 * What the tactical layer should be doing for a step, in the catalog's vocabulary.
 * @param {Step} step
 * @param {Snapshot} [snapshot] to tell whether the target is in sight; assumed so when omitted
 * @returns {Focus}
 */
export function focusFor(step, snapshot) {
    switch (step.kind) {
        case 'collect': {
            const inSight = !snapshot || snapshot.blocks.some(block => block.name === step.block);
            return { action: 'collect_blocks', target: step.block, quantity: step.count, inSight, text: `collect ${step.count} ${step.block}${step.block !== step.item ? ` for ${step.item}` : ''}` };
        }
        case 'craft':
            return { action: 'craft', target: step.item, quantity: step.crafts ?? 1, inSight: true, text: `craft ${step.count} ${step.item}` };
        case 'smelt':
            return { action: 'smelt', target: step.from, quantity: step.count, inSight: true, text: `smelt ${step.count} ${step.from} into ${step.item}` };
        case 'hunt': {
            const inSight = !snapshot || snapshot.entities.some(entity => entity.name === step.from);
            return { action: 'attack', target: step.from, inSight, text: `hunt ${step.from} for ${step.count} ${step.item}` };
        }
    }
}
