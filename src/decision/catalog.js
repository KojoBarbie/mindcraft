// @ts-check
// The actions a decision model may pick from, as data. Each action knows when it is possible and which
// targets make sense, so impossible moves never appear as options: a model cannot choose to mine iron
// without a pickaxe if "iron_ore" is simply not on the list. Every action maps onto one of Mindcraft's
// existing !commands (src/agent/commands/actions.js), which stays untouched.
import { ARMOR, HAZARD_BLOCK, STATION, TOOL, namesIn } from './interest.js';

/** @typedef {import('./snapshot.js').Snapshot} Snapshot */
/** @typedef {import('./knowledge.js').Knowledge} Knowledge */

/**
 * @typedef {object} CatalogContext
 * @property {Snapshot} snapshot
 * @property {Knowledge} knowledge
 * @property {{blocks?: string[], entities?: string[]}} [wanted] things the goal needs that are not in sight, so
 *   that "go and look for it" can be offered as an action; the planner fills this in
 */

/**
 * @typedef {object} Action
 * @property {string} id short English verb phrase; this is what the model sees
 * @property {string} hint one line telling the model when this is the right move
 * @property {(ctx: CatalogContext) => boolean} [possible] defaults to "has at least one target"
 * @property {(ctx: CatalogContext) => string[]} [targets] omit for actions that take no target
 * @property {(ctx: CatalogContext, target: string) => string} [note] extra fact about a target, shown to the model
 * @property {(ctx: CatalogContext, target: string) => number[]} [quantities] omit for actions with no amount
 * @property {(target: string | undefined, quantity: number | undefined, ctx: CatalogContext) => string} build the !command
 */

/** Blocks the bot should never be offered to break: workstations and storage (STATION), plus these. */
const UNBREAKABLE = /^(bedrock|spawner|end_portal_frame|water)$/;
/** @param {string} name */
const isProtected = name => STATION.test(name) || UNBREAKABLE.test(name);

const q = JSON.stringify; // Mindcraft parses string arguments in double quotes

/** @param {Snapshot} s */
const owned = s => Object.keys(s.inventory).filter(name => s.inventory[name] > 0);
/** @param {Snapshot} s @param {import('./snapshot.js').EntityObservation['kind']} kind */
const entityNames = (s, kind) => [...new Set(s.entities.filter(e => e.kind === kind).sort((a, b) => a.dist - b.dist).map(e => e.name))];
/** @param {Snapshot} s @param {string} name @param {number} within */
const blockWithin = (s, name, within) => s.blocks.some(b => b.name === name && b.dist <= within);

/**
 * Amounts to offer: a few round steps up to `max`, always including `max` itself when it is small.
 * @param {number} max
 * @param {number[]} [steps]
 */
export function amounts(max, steps = [1, 4, 16, 64]) {
    if (max <= 0) return [];
    const offered = steps.filter(n => n <= max);
    if (!offered.includes(max) && max < steps[steps.length - 1]) offered.push(max);
    return offered.sort((a, b) => a - b);
}

/** @type {Action[]} */
export const ACTIONS = [
    {
        id: 'collect_blocks',
        hint: 'mine or gather a block type that is nearby',
        targets: ({ snapshot, knowledge }) => snapshot.blocks
            .filter(b => !isProtected(b.name) && !HAZARD_BLOCK.test(b.name) && knowledge.canHarvest(b.name))
            .sort((a, b) => a.dist - b.dist).map(b => b.name),
        // targets are block names (that is what !collectBlocks takes); goals usually speak of items
        note: ({ knowledge }, target) => {
            const drops = knowledge.dropsOf(target).filter(item => item !== target);
            return drops.length > 0 ? `gives ${drops.join(', ')}` : '';
        },
        quantities: () => [1, 4, 16],
        build: (target, n) => `!collectBlocks(${q(target)}, ${n})`,
    },
    {
        id: 'craft',
        hint: 'craft an item from what is in the inventory',
        targets: ({ knowledge }) => knowledge.craftable(),
        quantities: () => [1, 4, 16], // times the recipe is used, not items made
        build: (target, n) => `!craftRecipe(${q(target)}, ${n})`,
    },
    {
        id: 'smelt',
        hint: 'smelt or cook an item in a furnace',
        targets: ({ knowledge }) => knowledge.smeltable(),
        quantities: ({ snapshot }, target) => amounts(snapshot.inventory[target] ?? 0, [1, 8, 32]),
        build: (target, n) => `!smeltItem(${q(target)}, ${n})`,
    },
    {
        id: 'take_from_furnace',
        hint: 'collect finished items from the nearby furnace',
        possible: ({ snapshot }) => blockWithin(snapshot, 'furnace', 16),
        build: () => '!clearFurnace()',
    },
    {
        id: 'eat',
        hint: 'eat to restore hunger; do this when food is low',
        possible: ({ snapshot }) => snapshot.food < 20,
        targets: ({ snapshot, knowledge }) => owned(snapshot).filter(name => knowledge.isFood(name)),
        build: target => `!consume(${q(target)})`,
    },
    {
        id: 'equip',
        hint: 'hold a tool or weapon, or put on armor',
        targets: ({ snapshot }) => owned(snapshot)
            .filter(name => TOOL.test(name) || ARMOR.test(name))
            .filter(name => name !== snapshot.heldItem && name !== snapshot.offhand && !snapshot.armor.includes(name)),
        build: target => `!equip(${q(target)})`,
    },
    {
        id: 'attack',
        hint: 'fight the nearest creature of a type; hostile mobs to stay safe, animals for food',
        targets: ({ snapshot }) => [...entityNames(snapshot, 'hostile'), ...entityNames(snapshot, 'passive')],
        build: target => `!attack(${q(target)})`,
    },
    {
        id: 'flee',
        hint: 'run away from here; do this when health is low and hostile mobs are close',
        possible: ({ snapshot }) => snapshot.entities.some(e => e.kind === 'hostile') || snapshot.blocks.some(b => HAZARD_BLOCK.test(b.name) && b.dist <= 4),
        build: () => '!moveAway(24)',
    },
    {
        id: 'go_to_player',
        hint: 'walk to a player',
        targets: ({ snapshot }) => entityNames(snapshot, 'player'),
        build: target => `!goToPlayer(${q(target)}, 3)`,
    },
    {
        id: 'follow_player',
        hint: 'keep following a player around',
        targets: ({ snapshot }) => entityNames(snapshot, 'player'),
        build: target => `!followPlayer(${q(target)}, 4)`,
    },
    {
        id: 'give_to_player',
        hint: 'hand an item to the nearest player',
        possible: ({ snapshot }) => entityNames(snapshot, 'player').length > 0,
        targets: ({ snapshot }) => owned(snapshot).sort((a, b) => snapshot.inventory[b] - snapshot.inventory[a]),
        quantities: ({ snapshot }, target) => amounts(snapshot.inventory[target] ?? 0),
        build: (target, n, { snapshot }) => `!givePlayer(${q(entityNames(snapshot, 'player')[0])}, ${q(target)}, ${n})`,
    },
    {
        id: 'place_block',
        hint: 'place a workstation, torch or building block from the inventory right here',
        targets: ({ snapshot }) => owned(snapshot).filter(name => STATION.test(name) || name === 'torch'),
        build: target => `!placeHere(${q(target)})`,
    },
    {
        id: 'store_in_chest',
        hint: 'put items into the nearby chest to free inventory space',
        possible: ({ snapshot }) => blockWithin(snapshot, 'chest', 16) && owned(snapshot).length > 0,
        targets: ({ snapshot }) => owned(snapshot).filter(name => !TOOL.test(name) && !ARMOR.test(name))
            .sort((a, b) => snapshot.inventory[b] - snapshot.inventory[a]).slice(0, 12),
        quantities: ({ snapshot }, target) => amounts(snapshot.inventory[target] ?? 0),
        build: (target, n) => `!putInChest(${q(target)}, ${n})`,
    },
    {
        id: 'take_from_chest',
        hint: 'take an item the goal needs out of the nearby chest',
        possible: ({ snapshot }) => blockWithin(snapshot, 'chest', 16),
        // the chest's contents are unknown until it is opened, so only offer what the goal asks for
        targets: ({ snapshot, knowledge }) => [...namesIn(snapshot.goal)].filter(name => knowledge.isItem(name)),
        quantities: () => [1, 4, 16, 64],
        build: (target, n) => `!takeFromChest(${q(target)}, ${n})`,
    },
    {
        id: 'drop_items',
        hint: 'throw away items that are not needed; only when the inventory is nearly full',
        possible: ({ snapshot }) => owned(snapshot).length >= 30,
        targets: ({ snapshot }) => owned(snapshot).filter(name => !TOOL.test(name) && !ARMOR.test(name) && !STATION.test(name))
            .sort((a, b) => snapshot.inventory[b] - snapshot.inventory[a]).slice(0, 12),
        quantities: ({ snapshot }, target) => amounts(snapshot.inventory[target] ?? 0),
        build: (target, n) => `!discard(${q(target)}, ${n})`,
    },
    {
        id: 'sleep',
        hint: 'sleep in a nearby bed to skip the night',
        possible: ({ snapshot }) => snapshot.timeOfDay >= 12500 && snapshot.timeOfDay < 23500 && snapshot.blocks.some(b => b.name.endsWith('_bed')),
        build: () => '!goToBed()',
    },
    {
        id: 'go_to_surface',
        hint: 'climb up to the surface when underground',
        possible: ({ snapshot }) => snapshot.dimension === 'overworld' && snapshot.pos.y < 55,
        build: () => '!goToSurface()',
    },
    {
        id: 'dig_down',
        hint: 'dig straight down to reach deeper ores; needs a pickaxe',
        possible: ({ snapshot }) => owned(snapshot).some(name => name.endsWith('_pickaxe')) && snapshot.pos.y > -50,
        quantities: () => [4, 8, 16],
        build: (_target, n) => `!digDown(${n})`,
    },
    {
        id: 'search_for_block',
        hint: 'go and look for a block the goal needs but that is not in sight',
        targets: ({ wanted, knowledge }) => (wanted?.blocks ?? []).filter(name => knowledge.canHarvest(name)),
        build: target => `!searchForBlock(${q(target)}, 64)`,
    },
    {
        id: 'search_for_entity',
        hint: 'go and look for a creature the goal needs but that is not in sight',
        targets: ({ wanted }) => wanted?.entities ?? [],
        build: target => `!searchForEntity(${q(target)}, 64)`,
    },
    {
        id: 'explore',
        hint: 'walk somewhere new when nothing useful is nearby',
        quantities: () => [32, 96],
        build: (_target, n) => `!moveAway(${n})`,
    },
    {
        id: 'wait',
        hint: 'stand still for a moment; only when it is safe and nothing is worth doing',
        // !stay pauses the reflex modes (self-defence, fleeing) while it runs, so never with a threat around
        possible: ({ snapshot }) => !snapshot.entities.some(e => e.kind === 'hostile' && e.dist <= 16),
        build: () => '!stay(3)',
    },
];

const byId = new Map(ACTIONS.map(action => [action.id, action]));

/**
 * @param {string} id
 * @returns {Action}
 */
function actionFor(id) {
    const action = byId.get(id);
    if (!action) throw new Error(`Unknown action "${id}".`);
    return action;
}

/**
 * Targets for an action, deduplicated and capped.
 * @param {CatalogContext} ctx
 * @param {string} id
 * @param {number} [max]
 * @returns {string[]}
 */
export function listTargets(ctx, id, max = 20) {
    const action = actionFor(id);
    return action.targets ? [...new Set(action.targets(ctx))].slice(0, max) : [];
}

/**
 * Facts about targets worth showing the model, e.g. {iron_ore: 'gives raw_iron'}. Only targets that have one.
 * @param {CatalogContext} ctx
 * @param {string} id
 * @param {string[]} targets
 * @returns {Record<string, string>}
 */
export function targetNotes(ctx, id, targets) {
    const action = actionFor(id);
    if (!action.note) return {};
    return Object.fromEntries(targets.map(t => [t, /** @type {NonNullable<Action['note']>} */ (action.note)(ctx, t)]).filter(([, note]) => note));
}

/**
 * @param {CatalogContext} ctx
 * @param {string} id
 * @param {string | undefined} target
 * @returns {number[]}
 */
export function listQuantities(ctx, id, target) {
    const action = actionFor(id);
    return action.quantities ? action.quantities(ctx, target ?? '') : [];
}

/**
 * The most that can be asked for in one command; 0 for actions that take no quantity.
 * @param {CatalogContext} ctx
 * @param {string} id
 * @param {string | undefined} target
 */
export function maxQuantity(ctx, id, target) {
    return Math.max(0, ...listQuantities(ctx, id, target));
}

/**
 * The actions that are possible right now. An action that takes a target is possible only if it has one.
 * @param {CatalogContext} ctx
 * @returns {{id: string, hint: string}[]} never more than the catalog holds (20)
 */
export function listActions(ctx) {
    return ACTIONS.filter(action => {
        if (action.possible && !action.possible(ctx)) return false;
        if (action.targets && listTargets(ctx, action.id, 1).length === 0) return false;
        if (action.quantities && !action.targets && action.quantities(ctx, '').length === 0) return false;
        return true;
    }).map(({ id, hint }) => ({ id, hint }));
}

/**
 * Build the command for a complete selection. Throws if the selection is not one the catalog would have offered,
 * so a bad answer can never turn into a command.
 * @param {CatalogContext} ctx
 * @param {{id: string, target?: string, quantity?: number}} selection
 * @returns {string} e.g. '!collectBlocks("oak_log", 4)'
 */
export function buildCommand(ctx, selection) {
    const action = actionFor(selection.id);
    if (!listActions(ctx).some(a => a.id === selection.id)) throw new Error(`Action "${selection.id}" is not possible right now.`);
    if (action.targets && !listTargets(ctx, selection.id).includes(selection.target ?? ''))
        throw new Error(`"${selection.target}" is not a valid target for "${selection.id}".`);
    // Offered quantities are round steps for a model to pick from; a planner may ask for an exact amount in
    // between (11 stone), which is fine as long as it stays within what was on offer.
    const quantity = selection.quantity ?? NaN;
    if (action.quantities && !(Number.isInteger(quantity) && quantity >= 1 && quantity <= maxQuantity(ctx, selection.id, selection.target)))
        throw new Error(`${selection.quantity} is not a valid quantity for "${selection.id}".`);
    return action.build(action.targets ? selection.target : undefined, action.quantities ? selection.quantity : undefined, ctx);
}
