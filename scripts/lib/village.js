// @ts-check
// Village scenarios for the night guard (scripts/demo.js --village [--raid]): put the bot in the nearest village
// at night with a full iron kit and no iron golems to do the work for it, then count what is left of the village.
import { rcon } from './rcon.js';

/** What a guard is handed for a village night: a full set of iron, a shield, light and food. */
export const IRON_KIT = [
    'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'iron_sword', 'shield',
    'torch:32', 'bread:16', 'cobblestone:32',
];

/**
 * The nearest village to the world spawn, as the server's /locate finds it.
 * @returns {Promise<{x: number, z: number}>}
 */
export async function findVillage() {
    const reply = await rcon('locate structure #minecraft:village');
    const match = reply.match(/\[(-?\d+), [^,]+, (-?\d+)\]/);
    if (!match) throw new Error(`no village found: ${reply}`);
    return { x: Number(match[1]), z: Number(match[2]) };
}

/**
 * How many entities of a type (or #tag) are within `radius` of the bot.
 * @param {string} bot
 * @param {string} type e.g. 'minecraft:villager', '#minecraft:raiders'
 * @param {number} radius
 */
export async function countNear(bot, type, radius) {
    const reply = await rcon(`execute at ${bot} if entity @e[type=${type},distance=..${radius}]`);
    const match = reply.match(/count: (\d+)/);
    return match ? Number(match[1]) : 0;
}

/**
 * How many entities of a type (or #tag) are in the village: counted around its centre, not the bot (a bot that
 * died and woke at the world spawn made the whole village look dead).
 * @param {{x: number, z: number}} at
 * @param {string} type
 * @param {number} radius horizontal
 */
export async function countInVillage(at, type, radius) {
    // a box from bedrock to the sky, `radius` either side of the centre
    const reply = await rcon(`execute if entity @e[type=${type},x=${at.x - radius},y=-64,z=${at.z - radius},dx=${2 * radius},dy=400,dz=${2 * radius}]`);
    const match = reply.match(/count: (\d+)/);
    return match ? Number(match[1]) : 0;
}

/**
 * Remove the iron golems around the bot: the point is to see what the guard itself can hold.
 * @param {string} bot
 */
export async function removeGolems(bot) {
    await rcon(`execute at ${bot} run kill @e[type=minecraft:iron_golem,distance=..160]`);
}

/**
 * Start a raid on the village the bot stands in. Bad Omen, which the game turns into Raid Omen inside a village
 * (remembering where), and the raid starts about 30 s later. Raid Omen given straight away does nothing: it is
 * the conversion that records the village to raid.
 * @param {string} bot
 */
export async function startRaid(bot) {
    return await rcon(`effect give ${bot} minecraft:bad_omen 600 0`);
}
