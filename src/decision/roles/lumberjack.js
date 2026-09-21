// @ts-check
// The lumberjack role (#48): fell trees around a centre, replant them, and deliver logs to a chest until a
// quota is met. An axe is a goal like any other (the loop's model pursues it); the felling is a routine.
import { haveTool } from '../goals.js';

/**
 * @typedef {object} LumberjackOptions
 * @property {[number, number]} [center] x, z; default: where the role starts
 * @property {number} [radius] default 32
 * @property {number} [quota] logs to deliver, default 64
 * @property {[number, number, number] | 'start'} [chest] where to deliver; 'start': two blocks east of where the
 *   role starts; without one the logs are kept
 * @property {(text: string) => void} [say]
 */

/** @param {Record<string, number>} inventory */
const logsIn = inventory => Object.entries(inventory).reduce((sum, [name, n]) => sum + (name.endsWith('_log') ? n : 0), 0);

/** @param {LumberjackOptions} [options] */
export function createLumberjackRole(options = {}) {
    const radius = options.radius ?? 32;
    const quota = options.quota ?? 64;
    /** @type {{x: number, z: number} | null} */
    let center = options.center ? { x: options.center[0], z: options.center[1] } : null;
    let delivered = 0;
    /** @type {number | null} logs held when a delivery was started */
    let depositing = null;
    let reported = false;
    let radiusNow = radius;
    let lastHeld = -1;
    let barren = 0; // felling attempts in a row that brought no logs
    /** @type {[number, number, number] | null} */
    let chest = Array.isArray(options.chest) ? options.chest : null;

    return {
        name: 'lumberjack',
        state: () => ({ center, delivered, chest, radiusNow }),
        /** @param {any} saved */
        restore(saved) {
            if (!options.center && saved?.center && Number.isFinite(saved.center.x) && Number.isFinite(saved.center.z)) center = saved.center;
            if (Number.isFinite(saved?.delivered)) delivered = saved.delivered;
            if (Array.isArray(saved?.chest) && saved.chest.length === 3 && !Array.isArray(options.chest)) chest = saved.chest;
            if (Number.isFinite(saved?.radiusNow)) radiusNow = saved.radiusNow;
        },
        get delivered() { return delivered; },

        /**
         * @param {{goals: import('../goals.js').GoalQueue, onEvent: (event: {type: string, detail?: unknown}) => void}} loop
         * @param {import('../snapshot.js').Snapshot} snapshot
         * @returns {string | null}
         */
        step(loop, snapshot) {
            const inv = snapshot.inventory;
            center ??= { x: Math.round(snapshot.pos.x), z: Math.round(snapshot.pos.z) };
            if (options.chest === 'start' && !chest) chest = [Math.floor(snapshot.pos.x) + 2, Math.floor(snapshot.pos.y), Math.floor(snapshot.pos.z)];
            const held = logsIn(inv);
            if (depositing !== null) {
                const moved = Math.max(0, depositing - held);
                delivered += moved;
                depositing = null;
                if (moved > 0) loop.onEvent({ type: 'found', detail: { item: 'log (delivered)', count: moved, total: delivered } });
            }
            const done = chest ? delivered >= quota : held >= quota;
            if (done) {
                if (!reported) {
                    reported = true;
                    options.say?.(`原木 ${chest ? delivered : held} 本、${chest ? 'チェストに納品しました' : '集めました'}。`);
                    loop.onEvent({ type: 'role', detail: { role: 'lumberjack', command: 'quota met' } });
                }
                return null;
            }
            // an axe makes it four times faster; the first logs pay for it
            if (held >= 3 && !Object.keys(inv).some(name => name.endsWith('_axe'))) {
                const pending = loop.goals.toJSON().goals.some(q => q.status === 'pending' && q.goal.type === 'have_tool' && q.goal.tool === 'axe');
                if (!pending) loop.goals.add(haveTool('wooden', 'axe'), { priority: 1000 });
                return null;
            }
            // no trees within reach: look further afield, a little at a time, and tell the player once
            if (lastHeld >= 0 && held <= lastHeld) barren++;
            else barren = 0;
            lastHeld = held;
            if (barren >= 2) {
                barren = 0;
                if (radiusNow < 128) {
                    radiusNow += 24;
                    options.say?.(`近くに木がありません。範囲を ${radiusNow} ブロックに広げて探します。`);
                }
                return '!explore(32)';
            }
            const batch = Math.min(32, quota - delivered);
            if (chest && held >= batch) {
                depositing = held;
                const [x, y, z] = chest;
                return `!depositLogs(${x}, ${y}, ${z})`;
            }
            return `!chopTree(${center.x}, ${center.z}, ${radiusNow})`;
        },
    };
}
