// @ts-check
// A place for an integration test to build on, well away from the world spawn. Tests used to level ground
// around the bot where it spawned; on uneven terrain that left an 81x81 sheet of grass floating over the
// savanna, and every later run (demos, soak) spawned on it seven blocks up and could not get down.
import { rcon } from './rcon.js';

const ORIGIN_X = 4000;
const ORIGIN_Z = 4000;
const FLOOR_Y = 149;

/**
 * Build a flat arena in its own slot far from spawn and put the bot in the middle of it.
 * @param {string} bot
 * @param {number} slot one per test file, so tests do not build on each other's leftovers
 * @param {{radius?: number, depth?: number, surface?: string}} [options] depth: layers of dirt under the surface
 * @returns {Promise<{x: number, y: number, z: number}>} where the bot now stands
 */
export async function moveToArena(bot, slot, options = {}) {
    const r = options.radius ?? 40;
    const depth = options.depth ?? 3;
    const x = ORIGIN_X + slot * 200;
    const z = ORIGIN_Z;
    await rcon(`forceload add ${x - r} ${z - r} ${x + r} ${z + r}`);
    // fill takes at most 32768 blocks at a time: do it in strips
    for (let dx = -r; dx <= r; dx += 8) {
        const x0 = x + dx;
        const x1 = Math.min(x + r, x0 + 7);
        const strip = (/** @type {number} */ y0, /** @type {number} */ y1, /** @type {string} */ block) => rcon(`fill ${x0} ${y0} ${z - r} ${x1} ${y1} ${z + r} ${block}`);
        await strip(FLOOR_Y - depth, FLOOR_Y - 1, 'minecraft:dirt');
        await strip(FLOOR_Y, FLOOR_Y, `minecraft:${options.surface ?? 'grass_block'}`);
        await strip(FLOOR_Y + 1, FLOOR_Y + 6, 'minecraft:air');
    }
    await rcon(`tp ${bot} ${x + 0.5} ${FLOOR_Y + 1} ${z + 0.5}`);
    return { x, y: FLOOR_Y + 1, z };
}

/** @param {number} slot @param {number} [radius] */
export async function releaseArena(slot, radius = 40) {
    const x = ORIGIN_X + slot * 200;
    await rcon(`forceload remove ${x - radius} ${ORIGIN_Z - radius} ${x + radius} ${ORIGIN_Z + radius}`).catch(() => '');
}
