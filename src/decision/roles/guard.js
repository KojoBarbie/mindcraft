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
 * @property {(post: {x: number, y: number, z: number}) => void} [onPost] told where the post is (to keep exploring near it)
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
    let ready = false;
    let toldNotReady = false;
    let leashed = false;

    return {
        name: 'guard',
        /** kept across agent restarts (decision_state.json): a restart far away must not move the post */
        state: () => ({ post }),
        /** @param {any} saved */
        restore(saved) {
            if (!options.center && saved?.post && [saved.post.x, saved.post.y, saved.post.z].every(Number.isFinite)) post = saved.post;
            leashed = false;
        },
        /**
         * A guard keeps watch at night instead of digging in, but only when fit to fight: an iron sword and
         * armour or a shield. Unequipped it fought everything and died ten times in one night.
         */
        get keepsWatchAtNight() { return ready; },
        /**
         * Fit to fight: an iron sword or better, and armour or a shield.
         * @param {import('../snapshot.js').Snapshot} snapshot
         */
        observe(snapshot) {
            const gear = snapshot.inventory;
            ready = Object.keys(gear).some(name => /(iron|diamond|netherite)_sword$/.test(name))
                && (Object.keys(gear).some(name => /_chestplate$/.test(name)) || (gear.shield ?? 0) > 0 || (snapshot.armor ?? []).length > 0);
        },

        /**
         * @param {{goals: import('../goals.js').GoalQueue, onEvent: (event: {type: string, detail?: unknown}) => void}} loop
         * @param {import('../snapshot.js').Snapshot} snapshot
         * @param {(item: string) => boolean} isFood
         * @returns {string | null}
         */
        step(loop, snapshot, isFood) {
            post ??= { x: Math.floor(snapshot.pos.x), y: Math.floor(snapshot.pos.y), z: Math.floor(snapshot.pos.z) };
            if (!leashed) {
                options.onPost?.(post);
                leashed = true;
            }
            const night = snapshot.dimension === 'overworld' && isNight(snapshot.timeOfDay);
            const hadReady = ready;
            this.observe(snapshot);
            if (!ready && !toldNotReady && snapshot.timeOfDay >= 11_000 && snapshot.timeOfDay < 12_000) {
                toldNotReady = true;
                options.say?.('装備が揃っていないので、今夜は持ち場の近くで籠もって待機します。');
            }
            if (ready && !hadReady) toldNotReady = false;
            if (wasNight && !night) {
                const tally = options.report?.() ?? { kills: {}, torches: 0 };
                const kills = Object.entries(tally.kills);
                const total = kills.reduce((n, [, k]) => n + k, 0);
                options.say?.(`朝です。昨夜は ${total} 体倒しました${kills.length ? `（${kills.map(([name, n]) => `${name} ${n}`).join('、')}）` : ''}。松明 ${tally.torches} 本。`);
                loop.onEvent({ type: 'role', detail: { role: 'guard', command: 'night report', kills: tally.kills } });
            }
            wasNight = night;

            // evening or night and away from the post (gear-gathering took it far): go back first
            const away = Math.hypot(snapshot.pos.x - post.x, snapshot.pos.z - post.z);
            if (away > radius * 2 && (night || snapshot.timeOfDay >= 11_000)) {
                // deep in a cave (it went down for iron): no path home from there, and the unstuck reflex stopped
                // fifty tries at one. Up to the surface first.
                if (snapshot.pos.y < post.y - 16) return '!goToSurface';
                return `!goToward(${post.x}, ${post.z})`;
            }

            // by day, get what the night needs; by night, make do with what there is
            if (!night) {
                const inv = snapshot.inventory;
                const good = goodFood(snapshot, isFood);
                const food = Object.entries(inv).reduce((sum, [name, n]) => sum + (good(name) ? n : 0), 0);
                const short = [];
                if (!Object.keys(inv).some(name => /(stone|iron|diamond|netherite)_sword$/.test(name))) short.push(() => ensureGoal(loop.goals, haveTool('stone', 'sword'), 1000));
                // a guard in cloth dies over and over (ten times in one test night): iron before the next night
                else if (!Object.keys(inv).some(name => /(iron|diamond|netherite)_sword$/.test(name))) short.push(() => ensureGoal(loop.goals, haveTool('iron', 'sword'), 980));
                const worn = snapshot.armor ?? [];
                if (!(inv.iron_chestplate > 0) && !(inv.diamond_chestplate > 0) && !worn.some(name => /(iron|diamond|netherite)_chestplate$/.test(name)))
                    short.push(() => ensureGoal(loop.goals, haveItem('iron_chestplate', 1), 975));
                if (!(inv.shield > 0) && !worn.includes('shield')) short.push(() => ensureGoal(loop.goals, haveItem('shield', 1), 970));
                if ((inv.torch ?? 0) < 8) short.push(() => ensureGoal(loop.goals, haveItem('torch', 24), 990));
                // a little food is enough to heal between fights; asking for eight sent it far afield for animals,
                // and put first it took the whole day where there were none: the sword and torches come first
                if (food < 2) short.push(() => ensureGoal(loop.goals, haveFood(4), 960));
                if (short.length > 0) {
                    for (const queue of short) queue();
                    return null;
                }
            }
            // unequipped at night: leave it to the loop's night routine (dig in), not a round it cannot fight
            if (night && !ready) return null;
            return `!patrol(${post.x}, ${post.y}, ${post.z}, ${radius})`;
        },
    };
}
