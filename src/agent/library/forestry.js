// mindcraft fork: felling trees whole, replanting them and delivering the wood (the lumberjack role,
// src/decision/roles/lumberjack.js). A "tree" is the logs connected to a log standing on natural ground, so
// log walls and floors of buildings are left alone.
import Vec3 from 'vec3';
import * as world from './world.js';
import { craftRecipe, goToPosition, log, pickupNearbyItems, placeBlock } from './skills.js';
import { isUnreachable, markUnreachable } from './unreachable.js';

const GROUND = ['dirt', 'grass_block', 'podzol', 'coarse_dirt', 'rooted_dirt', 'mud', 'moss_block', 'mycelium'];
const SAPLING_OF = {
    oak_log: 'oak_sapling', birch_log: 'birch_sapling', spruce_log: 'spruce_sapling', jungle_log: 'jungle_sapling',
    acacia_log: 'acacia_sapling', dark_oak_log: 'dark_oak_sapling', cherry_log: 'cherry_sapling', mangrove_log: 'mangrove_propagule',
};
const isLog = block => !!block && block.name.endsWith('_log');

/** The logs of the tree standing on `base`, lowest first (diagonal neighbours included: acacia trunks lean). */
function treeLogs(bot, base, limit = 48) {
    const seen = new Set([base.toString()]);
    const queue = [base];
    const logs = [];
    while (queue.length > 0 && logs.length < limit) {
        const pos = queue.shift();
        logs.push(pos);
        for (let dx = -1; dx <= 1; dx++)
            for (let dy = 0; dy <= 1; dy++)
                for (let dz = -1; dz <= 1; dz++) {
                    const next = pos.offset(dx, dy, dz);
                    if (seen.has(next.toString())) continue;
                    seen.add(next.toString());
                    if (isLog(bot.blockAt(next))) queue.push(next);
                }
    }
    return logs.sort((a, b) => a.y - b.y);
}

function eyeDistance(bot, pos) {
    return bot.entity.position.offset(0, 1.6, 0).distanceTo(pos.offset(0.5, 0.5, 0.5));
}

const SCAFFOLD = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', ...Object.keys(SAPLING_OF).map(name => name.replace('_log', '_planks'))];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Jump and put a block under the feet: one block higher. Leaves over the head are cleared first.
 * @returns {Promise<boolean>} false when there is nothing to stand on or no room overhead
 */
async function climbOne(bot) {
    const scaffold = bot.inventory.items().find(item => SCAFFOLD.includes(item.name));
    if (!scaffold) return false;
    const feet = bot.entity.position.floored();
    for (const dy of [2, 3]) {
        const above = bot.blockAt(feet.offset(0, dy, 0));
        if (!above || above.name === 'air') continue;
        if (!above.name.includes('leaves')) return dy === 3; // a log or the like: dig it from here instead
        await bot.dig(above, true).catch(() => {});
    }
    const ground = bot.blockAt(feet.offset(0, -1, 0));
    if (!ground || ground.boundingBox !== 'block') return false;
    await bot.equip(scaffold, 'hand');
    await bot.look(bot.entity.yaw, -Math.PI / 2, true);
    bot.setControlState('jump', true);
    try {
        for (let waited = 0; bot.entity.position.y < feet.y + 1.05 && waited < 1000; waited += 50) await sleep(50);
        await bot.placeBlock(ground, new Vec3(0, 1, 0));
    } catch {
        return false;
    } finally {
        bot.setControlState('jump', false);
    }
    await sleep(250);
    return bot.entity.position.y >= feet.y + 0.9;
}

/** Back down a pillar, digging the blocks it stands on (they drop and are picked up at the bottom). */
async function climbDown(bot, floorY) {
    for (let i = 0; i < 8 && bot.entity.position.y > floorY + 0.5; i++) {
        const under = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
        if (!under || under.name === 'air') { await sleep(300); continue; }
        await bot.tool.equipForBlock(under).catch(() => {});
        await bot.dig(under, true).catch(() => {});
        await sleep(300);
    }
}

/** Plant saplings on spots remembered from earlier fellings, where the bot has saplings for them. */
async function replant(bot) {
    const spots = bot.replantSpots ?? [];
    const left = [];
    for (const spot of spots) {
        const has = bot.inventory.items().some(item => item.name === spot.sapling);
        const ground = bot.blockAt(new Vec3(spot.x, spot.y - 1, spot.z));
        const here = bot.blockAt(new Vec3(spot.x, spot.y, spot.z));
        if (!has || !ground || !GROUND.includes(ground.name) || here?.name !== 'air') {
            if (!has && here?.name === 'air') left.push(spot);
            continue;
        }
        if (bot.entity.position.distanceTo(new Vec3(spot.x, spot.y, spot.z)) > 4)
            await goToPosition(bot, spot.x, spot.y, spot.z, 2).catch(() => false);
        if (await placeBlock(bot, spot.sapling, spot.x, spot.y, spot.z, 'bottom', true).catch(() => false))
            log(bot, `Planted ${spot.sapling} at ${spot.x}, ${spot.y}, ${spot.z}.`);
        else left.push(spot);
    }
    bot.replantSpots = left.slice(-32);
}

/**
 * Fell the nearest tree within `radius` of `center`: walk to it, take every log that can be reached from the
 * ground and from the stump, pick up what falls, and replant (now, or later once a sapling drops).
 * @param {MinecraftBot} bot
 * @param {{x: number, z: number} | null} center
 * @param {number} radius
 * @returns {Promise<boolean>} true if any log was taken
 */
export async function chopTree(bot, center = null, radius = 32) {
    await replant(bot);
    const origin = center ?? bot.entity.position;
    const logNames = Object.keys(SAPLING_OF);
    const bases = world.getNearestBlocksNamed(bot, logNames, block => {
        if (isUnreachable(bot, block.position)) return false;
        if (Math.hypot(block.position.x - origin.x, block.position.z - origin.z) > radius) return false;
        const below = bot.blockAt(block.position.offset(0, -1, 0));
        return !!below && GROUND.includes(below.name);
    }, radius + 16, 8);
    if (bases.length === 0) {
        log(bot, `No trees left within ${radius} blocks of ${Math.round(origin.x)}, ${Math.round(origin.z)}.`);
        return false;
    }
    const base = bases[0].position;
    const species = bases[0].name;
    if (!await goToPosition(bot, base.x, base.y, base.z, 2)) {
        markUnreachable(bot, base);
        log(bot, `Could not get to the ${species} at ${base}.`);
        return false;
    }
    let taken = 0;
    const logs = treeLogs(bot, base);
    const tryDig = async pos => {
        const block = bot.blockAt(pos);
        if (!isLog(block) || eyeDistance(bot, pos) > 4.4) return false;
        await bot.tool.equipForBlock(block);
        try {
            await bot.dig(block, true);
            taken++;
            return true;
        } catch {
            return false;
        }
    };
    for (const pos of logs) await tryDig(pos); // what can be reached from beside the tree
    // then from the stump: stand where the lowest log was and reach up the trunk
    if (bot.blockAt(base)?.name === 'air' && logs.some(pos => isLog(bot.blockAt(pos)))) {
        await goToPosition(bot, base.x, base.y, base.z, 0).catch(() => false);
        for (const pos of logs) await tryDig(pos);
    }
    // what is still out of reach (acacia branches, tall spruce): climb the stump on a pillar, a block at a time
    if (bot.blockAt(base)?.name === 'air' && logs.some(pos => isLog(bot.blockAt(pos)))) {
        const floorY = bot.entity.position.y;
        // something to stand on: four planks from one log (they come back when the pillar is dug down)
        const planks = species.replace('_log', '_planks');
        if (!bot.inventory.items().some(item => SCAFFOLD.includes(item.name)) && SCAFFOLD.includes(planks))
            await craftRecipe(bot, planks, 1).catch(() => false);
        for (let climbed = 0; climbed < 6 && logs.some(pos => isLog(bot.blockAt(pos))); climbed++) {
            if (!await climbOne(bot)) break;
            for (const pos of logs) await tryDig(pos);
        }
        await climbDown(bot, floorY);
    }
    await new Promise(resolve => setTimeout(resolve, 1500)); // let the logs and the first saplings drop
    await pickupNearbyItems(bot);
    const sapling = SAPLING_OF[species];
    if (sapling) {
        bot.replantSpots = [...(bot.replantSpots ?? []), { x: base.x, y: base.y, z: base.z, sapling }];
        await replant(bot);
    }
    const left = logs.filter(pos => isLog(bot.blockAt(pos))).length;
    log(bot, `Felled a ${species.replace('_log', '')} tree at ${base}: ${taken} logs${left ? `, ${left} out of reach` : ''}.`);
    return taken > 0;
}

const CONTAINERS = ['chest', 'trapped_chest', 'barrel'];

/**
 * The chest at `target`, or one within six blocks of it; failing that, make one and put it down beside the
 * bot. The spot given is not always a place a chest can be (a demo's "where it started" was a tree top), and a
 * lumberjack with no chest to fill stood there all day saying so.
 */
async function findOrPlaceChest(bot, target) {
    const here = bot.blockAt(target);
    if (here && CONTAINERS.includes(here.name)) return here;
    const near = world.getNearestBlocksNamed(bot, CONTAINERS, block => block.position.distanceTo(target) <= 6, 12, 1)[0];
    if (near) return near;
    if (!bot.inventory.items().some(item => item.name === 'chest')) {
        const log_ = bot.inventory.items().find(item => item.name.endsWith('_log') && SAPLING_OF[item.name]);
        if (log_ && !bot.inventory.items().some(item => item.name.endsWith('_planks') && item.count >= 8))
            await craftRecipe(bot, log_.name.replace('_log', '_planks'), 3).catch(() => false);
        await craftRecipe(bot, 'chest', 1).catch(() => false);
    }
    if (!bot.inventory.items().some(item => item.name === 'chest')) {
        log(bot, `There is no chest at ${target}, and I could not make one.`);
        return null;
    }
    const feet = bot.entity.position.floored();
    for (const [dx, dz] of [[2, 0], [0, 2], [-2, 0], [0, -2], [1, 1], [-1, -1]]) {
        const spot = feet.offset(dx, 0, dz);
        const below = bot.blockAt(spot.offset(0, -1, 0));
        if (bot.blockAt(spot)?.name !== 'air' || !below || below.boundingBox !== 'block' || below.name.includes('leaves')) continue;
        if (await placeBlock(bot, 'chest', spot.x, spot.y, spot.z, 'bottom', true).catch(() => false)) {
            log(bot, `There was no chest at ${target}: put one down at ${spot}.`);
            return bot.blockAt(spot);
        }
    }
    log(bot, `There is no chest at ${target}, and nowhere beside me to put one.`);
    return null;
}

/**
 * Put all logs (and spare saplings beyond a few for replanting) into the chest at x, y, z.
 * @returns {Promise<number>} how many logs went in
 */
export async function depositLogs(bot, x, y, z) {
    const target = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    // where the chest for this spot actually is: the spot given can be out of reach (a demo's "where it
    // started" was a tree top 40 blocks over the ground, and every delivery trip ended there empty-handed)
    bot.chestFor ??= {};
    const known = bot.chestFor[target.toString()];
    const dest = known ? new Vec3(known.x, known.y, known.z) : target;
    await goToPosition(bot, dest.x, dest.y, dest.z, 2).catch(() => false);
    let chestBlock = null;
    if (bot.entity.position.distanceTo(dest.offset(0.5, 0, 0.5)) <= 4.5) {
        chestBlock = await findOrPlaceChest(bot, dest);
    } else if (known) {
        log(bot, `Could not get to the chest at ${dest}.`);
        return 0;
    } else {
        log(bot, `Could not get to ${target}: delivering to a chest here instead, and from now on.`);
        chestBlock = await findOrPlaceChest(bot, bot.entity.position.floored());
    }
    if (!chestBlock) return 0;
    const chestPos = chestBlock.position;
    bot.chestFor[target.toString()] = { x: chestPos.x, y: chestPos.y, z: chestPos.z };
    const container = await bot.openContainer(chestBlock);
    let moved = 0;
    try {
        for (const item of bot.inventory.items()) {
            if (!item.name.endsWith('_log')) continue;
            await container.deposit(item.type, null, item.count);
            moved += item.count;
        }
    } catch (err) {
        log(bot, `The chest is full or could not be used: ${err.message}`);
    } finally {
        container.close();
    }
    log(bot, `Put ${moved} logs in the chest at ${chestPos}.`);
    return moved;
}
