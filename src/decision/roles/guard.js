// @ts-check
// The night guard role (#47): guard the area around a post. By day it gets a sword, torches and food (ordinary
// goals, left to the loop's model) and lights the area; by night it patrols and fights. At dawn it reports the
// night's tally in chat.
import { goodFood, haveFood, haveItem, haveTool } from '../goals.js';
import { isNight } from '../daylight.js';

/**
 * @typedef {object} GuardOptions
 * @property {[number, number, number]} [center] the post; default: where the role starts
 * @property {number} [radius] default 24
 * @property {(text: string) => void} [say]
 * @property {() => {kills: Record<string, number>, torches: number}} [report] the night's tally, reset on read
 */

/**
 * @param {import('../goals.js').GoalQueue} queue
 * @param {import('../goals.js').Goal} goal
 * @param {number} priority
 */
function ensureGoal(queue, goal, priority) {
    const same = queue.toJSON().goals.find(q => q.status === 'pending' && JSON.stringify(q.goal) === JSON.stringify(goal));
    if (!same) queue.add(goal, { priority });
}

/** @param {GuardOptions} [options] */
export function createGuardRole(options = {}) {
    const radius = options.radius ?? 24;
    /** @type {{x: number, y: number, z: number} | null} */
    let post = options.center ? { x: options.center[0], y: options.center[1], z: options.center[2] } : null;
    let wasNight = false;

    return {
        name: 'guard',
        /** the night routine (dig in and wait) is not for a guard */
        keepsWatchAtNight: true,

        /**
         * @param {{goals: import('../goals.js').GoalQueue, onEvent: (event: {type: string, detail?: unknown}) => void}} loop
         * @param {import('../snapshot.js').Snapshot} snapshot
         * @param {(item: string) => boolean} isFood
         * @returns {string | null}
         */
        step(loop, snapshot, isFood) {
            post ??= { x: Math.floor(snapshot.pos.x), y: Math.floor(snapshot.pos.y), z: Math.floor(snapshot.pos.z) };
            const night = snapshot.dimension === 'overworld' && isNight(snapshot.timeOfDay);
            if (wasNight && !night) {
                const tally = options.report?.() ?? { kills: {}, torches: 0 };
                const kills = Object.entries(tally.kills);
                const total = kills.reduce((n, [, k]) => n + k, 0);
                options.say?.(`朝です。昨夜は ${total} 体倒しました${kills.length ? `（${kills.map(([name, n]) => `${name} ${n}`).join('、')}）` : ''}。松明 ${tally.torches} 本。`);
                loop.onEvent({ type: 'role', detail: { role: 'guard', command: 'night report', kills: tally.kills } });
            }
            wasNight = night;

            // by day, get what the night needs; by night, make do with what there is
            if (!night) {
                const inv = snapshot.inventory;
                const good = goodFood(snapshot, isFood);
                const food = Object.entries(inv).reduce((sum, [name, n]) => sum + (good(name) ? n : 0), 0);
                const short = [];
                if (!Object.keys(inv).some(name => /(stone|iron|diamond|netherite)_sword$/.test(name))) short.push(() => ensureGoal(loop.goals, haveTool('stone', 'sword'), 1000));
                if ((inv.torch ?? 0) < 8) short.push(() => ensureGoal(loop.goals, haveItem('torch', 24), 990));
                if (food < 4) short.push(() => ensureGoal(loop.goals, haveFood(8), 995));
                if (short.length > 0) {
                    for (const queue of short) queue();
                    return null;
                }
            }
            return `!patrol(${post.x}, ${post.y}, ${post.z}, ${radius})`;
        },
    };
}
