// @ts-check
// Day and night, and what counts as being safe from them. Shared by the tactical loop's night routine, the
// catalog and Mindcraft's shelter skill (src/agent/library/world.js), so they agree on both.

/**
 * Minecraft time of day (0-23,999). Hostile mobs start spawning on the surface at about 13,000 in clear
 * weather; the loop starts preparing a full minute earlier, which leaves time to walk to soft ground and to
 * try again if the first hole fails. The sun is up again from about 23,000 and undead start
 * to burn soon after; the loop leaves its shelter at 23,300.
 */
export const NIGHT_START = 12_000;
export const NIGHT_END = 23_300;

/** @param {number} timeOfDay */
export const isNight = timeOfDay => timeOfDay >= NIGHT_START && timeOfDay < NIGHT_END;

/**
 * The spaces around a standing bot that must be solid for it to be safe from mobs: the four sides at feet and
 * head height, and the block above the head.
 * @type {[number, number, number][]}
 */
export const ENCLOSURE_OFFSETS = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [0, 2, 0]];

/**
 * @param {(position: any) => ({boundingBox?: string} | null | undefined)} blockAt
 * @param {{offset: (x: number, y: number, z: number) => any}} feet the block the bot's feet are in
 */
export function isEnclosedAt(blockAt, feet) {
    return ENCLOSURE_OFFSETS.every(([dx, dy, dz]) => blockAt(feet.offset(dx, dy, dz))?.boundingBox === 'block');
}

/**
 * Is there anything solid above the bot's head, up to `range` blocks? Then it is under a roof, a tree or the
 * ground, not out in the open.
 * @param {(position: any) => ({boundingBox?: string} | null | undefined)} blockAt
 * @param {{offset: (x: number, y: number, z: number) => any}} feet
 */
export function hasCover(blockAt, feet, range = 24) {
    for (let dy = 2; dy <= range; dy++) if (blockAt(feet.offset(0, dy, 0))?.boundingBox === 'block') return true;
    return false;
}
