// mindcraft fork: mining by hand, underground: a staircase down to a chosen depth and branch mining from there.
// Written for the miner role (src/decision/roles/miner.js). The pathfinder is used only to walk a few blocks
// inside tunnels this code dug itself; the digging is explicit so that nothing next to lava or water is opened.
import Vec3 from 'vec3';
import { goToPosition, log, pickupNearbyItems, placeBlock } from './skills.js';

const LIQUIDS = ['lava', 'water'];
const FALLING = ['gravel', 'sand', 'red_sand', 'suspicious_sand', 'suspicious_gravel'];
/** Ores worth taking when a tunnel wall shows them; coal feeds torches and the furnace. */
export const WANTED_ORES = [
    'diamond_ore', 'deepslate_diamond_ore', 'iron_ore', 'deepslate_iron_ore', 'gold_ore', 'deepslate_gold_ore',
    'emerald_ore', 'deepslate_emerald_ore', 'coal_ore', 'deepslate_coal_ore', 'redstone_ore', 'deepslate_redstone_ore',
    'lapis_ore', 'deepslate_lapis_ore',
];
const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
/** yaw-free headings: +x, +z, -x, -z */
const HEADINGS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

function isLiquid(block) {
    return !!block && LIQUIDS.includes(block.name);
}

/** Would opening this block let lava or water in? Checks the block and its six neighbours. */
export function nearLiquid(bot, pos) {
    if (isLiquid(bot.blockAt(pos))) return true;
    return SIDES.some(([dx, dy, dz]) => isLiquid(bot.blockAt(pos.offset(dx, dy, dz))));
}

function solid(block) {
    return !!block && block.boundingBox === 'block';
}

/**
 * Clear one block if it is in the way. Falling blocks (gravel) keep coming down, so they are dug until air.
 * @returns {Promise<'ok' | 'danger' | 'cannot'>}
 */
async function clear(bot, pos) {
    for (let i = 0; i < 8; i++) {
        const block = bot.blockAt(pos);
        if (!block || block.boundingBox === 'empty') return isLiquid(block) ? 'danger' : 'ok';
        if (nearLiquid(bot, pos)) return 'danger';
        if (block.name === 'bedrock') return 'cannot';
        await bot.tool.equipForBlock(block);
        if (!block.canHarvest(bot.heldItem ? bot.heldItem.type : null) && block.hardness > 1) return 'cannot';
        try {
            await bot.dig(block, true);
        } catch {
            return 'cannot';
        }
        if (!FALLING.includes(block.name)) return 'ok';
        await new Promise(resolve => setTimeout(resolve, 400)); // let the next one fall
    }
    return 'ok';
}

/** Take the wanted ores showing in the walls, floor and ceiling around the bot. */
async function mineExposedOres(bot, found) {
    const feet = bot.entity.position.floored();
    for (let dy = -1; dy <= 2; dy++)
        for (let dx = -1; dx <= 1; dx++)
            for (let dz = -1; dz <= 1; dz++) {
                const pos = feet.offset(dx, dy, dz);
                const block = bot.blockAt(pos);
                if (!block || !WANTED_ORES.includes(block.name) || nearLiquid(bot, pos)) continue;
                await bot.tool.equipForBlock(block);
                if (!block.canHarvest(bot.heldItem ? bot.heldItem.type : null)) continue;
                try {
                    await bot.dig(block, true);
                    found[block.name] = (found[block.name] ?? 0) + 1;
                    if (block.name.includes('diamond')) log(bot, `Found diamond ore at ${pos}!`);
                } catch { /* someone else's problem: move on */ }
            }
    if (Object.keys(found).length > 0) await pickupNearbyItems(bot);
}

/**
 * Walk into the next cell of a tunnel or staircase this code has just dug: face its centre and walk until the
 * bot's feet are in it (dropping down a stair on the way). The pathfinder is no use here: asked for an exact
 * block it reports "Unable to reach, you are 1 blocks away" from the middle of it.
 * @returns {Promise<boolean>}
 */
async function stepInto(bot, cell) {
    const target = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5);
    const deadline = Date.now() + 4000;
    try {
        while (Date.now() < deadline && !bot.interrupt_code) {
            const p = bot.entity.position;
            const inCell = Math.floor(p.x) === cell.x && Math.floor(p.z) === cell.z;
            if (inCell && Math.abs(p.x - target.x) < 0.35 && Math.abs(p.z - target.z) < 0.35 && bot.entity.onGround && Math.floor(p.y) <= cell.y) return true;
            await bot.lookAt(new Vec3(target.x, p.y + 1.6, target.z), true);
            bot.setControlState('forward', !(inCell && Math.hypot(p.x - target.x, p.z - target.z) < 0.25));
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    } finally {
        bot.clearControlStates();
    }
    const p = bot.entity.position;
    return Math.floor(p.x) === cell.x && Math.floor(p.z) === cell.z && Math.abs(Math.floor(p.y) - cell.y) <= 1;
}

/**
 * A block can only be placed against a neighbour, and under a stair over a cave there may be none. Then the
 * bot may still drop in if the landing is close (three blocks: no damage) and dry.
 */
function safeDrop(bot, step) {
    for (let depth = 1; depth <= 3; depth++) {
        const below = bot.blockAt(step.offset(0, -depth, 0));
        if (!below) return false;
        if (isLiquid(below)) return false;
        if (solid(below)) return !nearLiquid(bot, step.offset(0, -depth + 1, 0));
    }
    return false;
}

/** Put a block where a floor is missing, from what mining has piled up in the inventory. */
async function fillFloor(bot, pos) {
    const filler = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'tuff', 'andesite', 'diorite', 'granite']
        .find(name => bot.inventory.items().some(item => item.name === name));
    if (!filler) return false;
    return await placeBlock(bot, filler, pos.x, pos.y, pos.z, 'bottom', true).catch(() => false) && solid(bot.blockAt(pos));
}

async function placeTorchBehind(bot, feet, heading) {
    if (!bot.inventory.items().some(item => item.name === 'torch')) return;
    const spot = feet.offset(-heading[0], 0, -heading[1]);
    if (bot.blockAt(spot)?.name !== 'air' || !solid(bot.blockAt(spot.offset(0, -1, 0)))) return;
    await placeBlock(bot, 'torch', spot.x, spot.y, spot.z, 'bottom', true).catch(() => false);
}

/**
 * Dig a 1x2 tunnel `length` blocks along `heading` from where the bot stands, walking into it.
 * @returns {Promise<{dug: number, stopped: string | null}>} stopped: why it ended early
 */
async function tunnel(bot, heading, length, found, within) {
    let dug = 0;
    for (let i = 0; i < length; i++) {
        if (bot.interrupt_code) return { dug, stopped: 'interrupted' };
        const feet = bot.entity.position.floored();
        const next = feet.offset(heading[0], 0, heading[1]);
        if (!within(next)) return { dug, stopped: 'edge of the area' };
        for (const pos of [next.offset(0, 1, 0), next]) {
            const result = await clear(bot, pos);
            if (result !== 'ok') return { dug, stopped: result === 'danger' ? 'lava or water ahead' : `cannot dig ${bot.blockAt(pos)?.name}` };
        }
        const floor = bot.blockAt(next.offset(0, -1, 0));
        if (!solid(floor)) {
            if (isLiquid(floor) || nearLiquid(bot, next.offset(0, -1, 0))) return { dug, stopped: 'lava or water below' };
            // a hole in the floor: fill it with what was dug, so the tunnel stays walkable
            if (!await fillFloor(bot, next.offset(0, -1, 0))) return { dug, stopped: 'a drop in the floor' };
        }
        if (!await stepInto(bot, next)) return { dug, stopped: 'could not step forward' };
        dug++;
        await mineExposedOres(bot, found);
        if (dug % 10 === 0) await placeTorchBehind(bot, next, heading);
    }
    return { dug, stopped: null };
}

/**
 * Walk and dig down a staircase until the bot's feet are at `targetY` or below.
 * @param {MinecraftBot} bot
 * @param {number} targetY
 * @returns {Promise<boolean>} true if it got there
 */
export async function descendTo(bot, targetY) {
    bot.mineHeading ??= Math.floor(Math.random() * 4);
    const found = {};
    let turns = 0;
    while (bot.entity.position.y > targetY + 0.5) {
        if (bot.interrupt_code) return false;
        const heading = HEADINGS[bot.mineHeading % 4];
        const feet = bot.entity.position.floored();
        const step = feet.offset(heading[0], -1, heading[1]);
        let blocked = null;
        // headroom over the step, the step itself, then its floor must hold
        for (const pos of [feet.offset(heading[0], 1, heading[1]), feet.offset(heading[0], 0, heading[1]), step]) {
            const name = bot.blockAt(pos)?.name;
            const result = await clear(bot, pos);
            if (result !== 'ok') { blocked = `${result} (${name} at ${pos})`; break; }
        }
        const floor = bot.blockAt(step.offset(0, -1, 0));
        if (!blocked && !solid(floor)) {
            // a cave under the next stair: put a floor in it, as a player would, unless lava or water is there
            if (isLiquid(floor) || nearLiquid(bot, step.offset(0, -1, 0))) blocked = 'danger';
            else if (!await fillFloor(bot, step.offset(0, -1, 0)) && !safeDrop(bot, step)) blocked = 'drop';
        }
        if (blocked) {
            log(bot, `Heading ${bot.mineHeading % 4} blocked: ${blocked}.`);
            if (++turns > 4) {
                log(bot, `Cannot go further down from ${feet}: ${blocked} in every direction.`);
                return false;
            }
            bot.mineHeading++;
            continue;
        }
        turns = 0;
        if (!await stepInto(bot, step)) {
            log(bot, `Could not step down to ${step}.`);
            return false;
        }
        await mineExposedOres(bot, found);
        if (Math.abs(bot.entity.position.y - targetY) % 12 < 1) await placeTorchBehind(bot, step, heading);
    }
    log(bot, `Reached y=${Math.floor(bot.entity.position.y)}.${summarise(found)}`);
    return true;
}

function summarise(found) {
    const entries = Object.entries(found);
    return entries.length ? ` Mined ${entries.map(([name, n]) => `${n} ${name}`).join(', ')}.` : '';
}

/**
 * One round of branch mining: three blocks along the main tunnel, then a branch to each side and back. The
 * main tunnel turns when it would leave the area around `center`. State (heading, rounds) is kept on the bot
 * between calls.
 * @param {MinecraftBot} bot
 * @param {{x: number, z: number} | null} center
 * @param {number} radius
 * @param {number} branchLength
 * @returns {Promise<boolean>} true if anything was dug
 */
export async function branchMine(bot, center = null, radius = 48, branchLength = 12) {
    bot.mineHeading ??= Math.floor(Math.random() * 4);
    const origin = center ?? bot.entity.position;
    const within = pos => Math.hypot(pos.x - origin.x, pos.z - origin.z) <= radius;
    const found = {};
    let dug = 0;
    let main = HEADINGS[bot.mineHeading % 4];
    let result = await tunnel(bot, main, 3, found, within);
    dug += result.dug;
    if (result.stopped && result.stopped !== 'interrupted') {
        log(bot, `Main tunnel stopped: ${result.stopped}. Turning.`);
        bot.mineHeading++;
        main = HEADINGS[bot.mineHeading % 4];
        result = await tunnel(bot, main, 3, found, within);
        dug += result.dug;
    }
    if (result.stopped === 'interrupted') return dug > 0;
    const junction = bot.entity.position.floored();
    for (const side of [1, 3]) {
        const heading = HEADINGS[(bot.mineHeading + side) % 4];
        const branch = await tunnel(bot, heading, branchLength, found, within);
        dug += branch.dug;
        if (branch.stopped === 'interrupted') break;
        await goToPosition(bot, junction.x, junction.y, junction.z, 1); // back to the main tunnel
        await stepInto(bot, junction);
    }
    const diamonds = bot.inventory.items().filter(item => item.name === 'diamond').reduce((n, item) => n + item.count, 0);
    log(bot, `Branch mined ${dug} blocks around ${junction}.${summarise(found)} Holding ${diamonds} diamond.`);
    return dug > 0;
}
