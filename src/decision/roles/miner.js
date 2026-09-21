// @ts-check
// The miner role (#46): keep itself equipped, go down to diamond depth and branch mine around a chosen centre,
// reporting what it finds. Getting equipped is ordinary goals, left to the tactical loop and its model; the
// mining itself is a routine (src/agent/library/mining.js) that needs no decisions, so it runs by rule.
import { goodFood, haveFood, haveItem, haveTool } from '../goals.js';

/** Diamonds are commonest just above the deepslate floor. */
export const MINE_Y = -58;
const PICKAXES = ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];

/**
 * @typedef {object} MinerOptions
 * @property {[number, number]} [center] x, z; default: where the role starts
 * @property {number} [radius] default 48
 * @property {number} [mineY] default MINE_Y
 * @property {(text: string) => void} [say]
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

/** @param {MinerOptions} [options] */
export function createMinerRole(options = {}) {
    const radius = options.radius ?? 48;
    const mineY = options.mineY ?? MINE_Y;
    /** @type {{x: number, z: number} | null} */
    let center = options.center ? { x: options.center[0], z: options.center[1] } : null;
    let diamondsSeen = -1;

    return {
        name: 'miner',

        /**
         * What to do next, or null to let the loop pursue its goals (the role queues them when equipment is short).
         * @param {{goals: import('../goals.js').GoalQueue, onEvent: (event: {type: string, detail?: unknown}) => void}} loop
         * @param {import('../snapshot.js').Snapshot} snapshot
         * @param {(item: string) => boolean} isFood
         * @returns {string | null}
         */
        step(loop, snapshot, isFood) {
            const inv = snapshot.inventory;
            center ??= { x: Math.round(snapshot.pos.x), z: Math.round(snapshot.pos.z) };

            const diamonds = inv.diamond ?? 0;
            if (diamondsSeen >= 0 && diamonds > diamondsSeen) {
                const text = `ダイヤを ${diamonds - diamondsSeen} 個見つけた（計 ${diamonds} 個、${Math.round(snapshot.pos.x)}, ${Math.round(snapshot.pos.y)}, ${Math.round(snapshot.pos.z)}）`;
                loop.onEvent({ type: 'found', detail: { item: 'diamond', count: diamonds - diamondsSeen, total: diamonds } });
                options.say?.(text);
            }
            diamondsSeen = diamonds;

            // equipment first: an iron pickaxe (diamond ore needs one), light, and something to eat
            const good = goodFood(snapshot, isFood);
            const food = Object.entries(inv).reduce((sum, [name, n]) => sum + (good(name) ? n : 0), 0);
            // Torches and food are stocked up before going down: underground there are no trees or animals,
            // and a miner that ran out of torches at y=54 went looking for logs in the dark.
            const onSurface = snapshot.pos.y > 50;
            const short = [];
            if (!PICKAXES.some(p => (inv[p] ?? 0) > 0)) short.push(() => ensureGoal(loop.goals, haveTool('iron', 'pickaxe'), 1000));
            if (onSurface && (inv.torch ?? 0) < 16) short.push(() => ensureGoal(loop.goals, haveItem('torch', 24), 990));
            if (onSurface && food < 6) short.push(() => ensureGoal(loop.goals, haveFood(8), 995));
            if (short.length > 0) {
                for (const queue of short) queue();
                return null;
            }

            if (snapshot.pos.y > mineY + 2) return `!descendTo(${mineY})`;
            return `!branchMine(${center.x}, ${center.z}, ${radius})`;
        },
    };
}
