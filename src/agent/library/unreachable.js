// mindcraft fork: places the bot failed to reach, remembered for a while so that the "nearest" block is not the
// same unreachable one every time (a soak run walked to the same log on a cliff 29 times). No native
// dependencies, so it can be tested on its own.

export const UNREACHABLE_MS = 5 * 60_000;

function keyOf(pos) {
    return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

/**
 * @param {{unreachable?: Map<string, number>}} bot
 * @param {{x: number, y: number, z: number} | null | undefined} pos
 * @param {number} [now]
 */
export function markUnreachable(bot, pos, now = Date.now()) {
    if (!pos) return;
    bot.unreachable ??= new Map();
    bot.unreachable.set(keyOf(pos), now + UNREACHABLE_MS);
    if (bot.unreachable.size > 256) pruneUnreachable(bot, now);
}

/**
 * findBlocks hands the predicate placeholder blocks without a position; those are simply not unreachable.
 * @param {{unreachable?: Map<string, number>}} bot
 * @param {{x: number, y: number, z: number} | null | undefined} pos
 * @param {number} [now]
 */
export function isUnreachable(bot, pos, now = Date.now()) {
    if (!pos || !bot.unreachable) return false;
    const until = bot.unreachable.get(keyOf(pos));
    if (until === undefined) return false;
    if (until > now) return true;
    bot.unreachable.delete(keyOf(pos));
    return false;
}

/** @param {{unreachable?: Map<string, number>}} bot @param {number} [now] @returns {number} how many are still remembered */
export function pruneUnreachable(bot, now = Date.now()) {
    if (!bot.unreachable) return 0;
    for (const [key, until] of bot.unreachable) if (until <= now) bot.unreachable.delete(key);
    return bot.unreachable.size;
}
