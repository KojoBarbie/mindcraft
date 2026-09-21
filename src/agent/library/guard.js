// mindcraft fork: guarding a post (the night guard role, src/decision/roles/guard.js). One call to patrol() does
// one thing: fight a hostile mob inside the guarded area, retreat and eat when hurt, light a dark spot, or walk
// on to the next point of the round. Mobs outside the area are left alone: a guard that chases a skeleton
// across the map is not guarding anything.
import Vec3 from 'vec3';
import pf from 'mineflayer-pathfinder';
import * as mc from '../../utils/mcdata.js';
import * as world from './world.js';
import { attackEntity, consume, goToGoal, log, placeBlock } from './skills.js';

const WAYPOINTS = 8;
const FOOD = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'bread', 'baked_potato', 'cooked_cod',
    'cooked_salmon', 'apple', 'carrot', 'beef', 'porkchop', 'mutton', 'rabbit', 'cooked_rabbit'];

function stats(bot) {
    bot.guardStats ??= { kills: {}, torches: 0, round: 0 };
    return bot.guardStats;
}

function inArea(pos, center, radius) {
    return Math.hypot(pos.x - center.x, pos.z - center.z) <= radius;
}

/** A spot on the ground inside the area where a mob could spawn: no block light, solid floor, room above. */
function darkSpot(bot, center, radius) {
    const feet = bot.entity.position.floored();
    let best = null;
    for (let dx = -8; dx <= 8; dx += 2)
        for (let dz = -8; dz <= 8; dz += 2)
            for (let dy = -2; dy <= 2; dy++) {
                const pos = feet.offset(dx, dy, dz);
                if (!inArea(pos, center, radius)) continue;
                const here = bot.blockAt(pos, true);
                const below = bot.blockAt(pos.offset(0, -1, 0));
                if (!here || here.name !== 'air' || !below || below.boundingBox !== 'block' || below.name.includes('leaves')) continue;
                if ((here.light ?? 15) > 0) continue;
                const d = pos.distanceTo(feet);
                if (!best || d < best.d) best = { pos, d };
            }
    return best?.pos ?? null;
}

/**
 * One step of guarding the area of `radius` around `center`.
 * @param {MinecraftBot} bot
 * @param {{x: number, y: number, z: number}} center
 * @param {number} radius
 * @returns {Promise<string>} what it did
 */
export async function patrol(bot, center, radius = 24) {
    const s = stats(bot);
    const post = new Vec3(center.x, center.y, center.z);

    // 1. a hostile inside the area: go and deal with it
    const enemy = world.getNearestEntityWhere(bot, e => mc.isHostile(e) && inArea(e.position, post, radius + 4), 32);
    if (enemy && !(enemy.name === 'creeper' && bot.health < 10)) {
        log(bot, `Engaging ${enemy.name} at ${enemy.position.floored()}.`);
        const killed = await attackEntity(bot, enemy, true);
        if (killed) {
            s.kills[enemy.name] = (s.kills[enemy.name] ?? 0) + 1;
            log(bot, `Defeated ${enemy.name}.`);
        }
        return killed ? `defeated ${enemy.name}` : `fought ${enemy.name}`;
    }

    // 2. hurt: back to the post and eat
    if (bot.health < 12 || bot.food < 14) {
        if (bot.entity.position.distanceTo(post) > 4) await goToGoal(bot, new pf.goals.GoalNear(post.x, post.y, post.z, 2)).catch(() => {});
        const food = FOOD.find(name => bot.inventory.items().some(item => item.name === name));
        if (food && bot.food < 20) {
            await consume(bot, food);
            return `ate ${food}`;
        }
        if (bot.health < 12) return 'resting at the post';
    }

    // 3. a dark spot nearby: light it so nothing spawns there
    if (bot.inventory.items().some(item => item.name === 'torch')) {
        const spot = darkSpot(bot, post, radius);
        if (spot && await placeBlock(bot, 'torch', spot.x, spot.y, spot.z, 'bottom', true).catch(() => false)) {
            s.torches++;
            return `lit ${spot}`;
        }
    }

    // 4. on to the next point of the round
    const angle = (2 * Math.PI * (s.round++ % WAYPOINTS)) / WAYPOINTS;
    const x = Math.round(post.x + Math.cos(angle) * radius * 0.6);
    const z = Math.round(post.z + Math.sin(angle) * radius * 0.6);
    try {
        await goToGoal(bot, new pf.goals.GoalNearXZ(x, z, 2));
    } catch { /* an unreachable waypoint: the next one next time */ }
    return `patrolled to ${x}, ${z}`;
}

/** Tonight's tally for the report, and a fresh one for the next night. */
export function takeGuardReport(bot) {
    const s = stats(bot);
    const report = { kills: { ...s.kills }, torches: s.torches };
    s.kills = {};
    s.torches = 0;
    return report;
}
