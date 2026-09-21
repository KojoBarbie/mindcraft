// mindcraft fork: felling trees whole, replanting them and delivering the wood (the lumberjack role,
// src/decision/roles/lumberjack.js). A "tree" is the logs connected to a log standing on natural ground, so
// log walls and floors of buildings are left alone.
import Vec3 from 'vec3';
import * as world from './world.js';
import { goToPosition, log, pickupNearbyItems, placeBlock } from './skills.js';
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

/**
 * Put all logs (and spare saplings beyond a few for replanting) into the chest at x, y, z.
 * @returns {Promise<number>} how many logs went in
 */
export async function depositLogs(bot, x, y, z) {
    const chestPos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    if (!await goToPosition(bot, chestPos.x, chestPos.y, chestPos.z, 2)) {
        log(bot, `Could not get to the chest at ${chestPos}.`);
        return 0;
    }
    const chestBlock = bot.blockAt(chestPos);
    if (!chestBlock || !['chest', 'trapped_chest', 'barrel'].includes(chestBlock.name)) {
        log(bot, `There is no chest at ${chestPos} (found ${chestBlock?.name}).`);
        return 0;
    }
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
