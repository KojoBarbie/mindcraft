// mindcraft fork: guarding a post (the night guard role, src/decision/roles/guard.js). One call to patrol() does
// one thing: fight a hostile mob inside the guarded area, retreat and eat when hurt, light a dark spot, or walk
// on to the next point of the round. Mobs outside the area are left alone: a guard that chases a skeleton
// across the map is not guarding anything.
import Vec3 from 'vec3';
import pf from 'mineflayer-pathfinder';
import * as mc from '../../utils/mcdata.js';
import * as world from './world.js';
import { attackEntity, consume, goToGoal, log, placeBlock, wearGear } from './skills.js';

const WAYPOINTS = 8;
const NEUTRAL = ['enderman', 'zombified_piglin', 'piglin', 'spider_jockey_rider'];
const RAIDERS = ['pillager', 'vindicator', 'evoker', 'ravager', 'illusioner', 'vex', 'witch'];
const FOOD = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'bread', 'baked_potato', 'cooked_cod',
    'cooked_salmon', 'apple', 'carrot', 'beef', 'porkchop', 'mutton', 'rabbit', 'cooked_rabbit'];

function stats(bot) {
    bot.guardStats ??= { kills: {}, torches: 0, round: 0 };
    return bot.guardStats;
}

function inArea(pos, center, radius) {
    return Math.hypot(pos.x - center.x, pos.z - center.z) <= radius;
}

const LIGHTS = ['torch', 'wall_torch', 'lantern', 'soul_torch', 'soul_wall_torch', 'glowstone', 'sea_lantern', 'jack_o_lantern', 'campfire', 'shroomlight'];

/**
 * A spot on the ground inside the area with no light source within six blocks: where mobs spawn at night.
 * (mineflayer does not report block light for 1.21 chunks, so it is judged by the lights around.)
 */
function darkSpot(bot, center, radius) {
    const feet = bot.entity.position.floored();
    const lights = world.getNearestBlocksNamed(bot, LIGHTS, () => true, 16, 64).map(b => b.position);
    let best = null;
    for (let dx = -8; dx <= 8; dx += 2)
        for (let dz = -8; dz <= 8; dz += 2)
            for (let dy = -2; dy <= 2; dy++) {
                const pos = feet.offset(dx, dy, dz);
                if (!inArea(pos, center, radius)) continue;
                const here = bot.blockAt(pos, true);
                const below = bot.blockAt(pos.offset(0, -1, 0));
                if (!here || here.name !== 'air' || !below || below.boundingBox !== 'block' || below.name.includes('leaves')) continue;
                if (lights.some(l => l.distanceTo(pos) <= 6)) continue;
                const d = pos.distanceTo(feet);
                if (!best || d < best.d) best = { pos, d };
            }
    return best?.pos ?? null;
}

/**
 * The height to stand at on the ground at x, z (the first solid block down from above, not a tree), or null when
 * that column is not loaded. Waypoints given by x and z alone led the pathfinder into a cave under the post, where
 * the guard lit tunnels at y=23 and walked into lava.
 * @returns {number | null}
 */
function groundAt(bot, x, z, fromY) {
    for (let y = Math.min(fromY + 24, 319); y > -60; y--) {
        const block = bot.blockAt(new Vec3(x, y, z));
        if (!block) return null;
        if (block.boundingBox === 'block' && !block.name.includes('leaves') && !block.name.endsWith('_log')) return y + 1;
    }
    return null;
}

/** Something to fight close by: a raider within 32 blocks, any other hostile within 12. */
function threatNear(bot) {
    return world.getNearestEntityWhere(bot, e => (RAIDERS.includes(e.name) && e.position.distanceTo(bot.entity.position) < 32)
        || (mc.isHostile(e) && !NEUTRAL.includes(e.name) && e.position.distanceTo(bot.entity.position) < 12), 32);
}

/**
 * Go to (x, z) on the ground, within `range`, giving up the walk as soon as something turns up to fight. A walk
 * across the round took long enough for a pillager to shoot the guard dead without it once turning round.
 */
async function walkTo(bot, x, z, range) {
    const y = groundAt(bot, Math.floor(x), Math.floor(z), Math.floor(bot.entity.position.y));
    const goal = y === null ? new pf.goals.GoalNearXZ(x, z, range) : new pf.goals.GoalNear(x, y, z, range);
    const watch = setInterval(() => { if (threatNear(bot)) bot.pathfinder.stop(); }, 400);
    try {
        await goToGoal(bot, goal).catch(() => {});
    } finally {
        clearInterval(watch);
    }
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
    await wearGear(bot);

    // underground (a cave under the post): the area to guard is the ground above
    const feet = bot.entity.position.floored();
    const ground = groundAt(bot, feet.x, feet.z, feet.y + 40);
    if (ground !== null && feet.y < ground - 4) {
        await walkTo(bot, post.x, post.z, 3);
        return 'back up to the ground';
    }

    // a raid gathers at the edge of the village, 85-95 blocks from where /locate puts it, and comes for the
    // villagers: raiders are met out there and first (a guard lit torches through a raid while they gathered)
    const raider = world.getNearestEntityWhere(bot, e => RAIDERS.includes(e.name) && inArea(e.position, post, radius + 56)
        && Math.abs(e.position.y - bot.entity.position.y) < 16, 100);

    // 0. nothing close: light the area first, or it fills with mobs faster than they can be fought (131 in a
    // night with no torch placed, because there was always some mob in the area to go after)
    const close = world.getNearestEntityWhere(bot, e => mc.isHostile(e) && !NEUTRAL.includes(e.name), 10);
    if (!close && !raider && bot.inventory.items().some(item => item.name === 'torch')) {
        const spot = darkSpot(bot, post, radius);
        if (spot && await placeBlock(bot, 'torch', spot.x, spot.y, spot.z, 'bottom', true).catch(() => false)) {
            s.torches++;
            return `lit ${spot}`;
        }
    }

    // 1. a hostile inside the area: go and deal with it, unless hurt and outnumbered
    // endermen and the like only fight back when provoked: leave them be (both test deaths were endermen)
    // on the ground with it: a mob in a cave under the area is no threat to it, and chasing one leads underground
    const enemy = raider ?? world.getNearestEntityWhere(bot, e => mc.isHostile(e) && !NEUTRAL.includes(e.name) && inArea(e.position, post, radius + 4)
        && Math.abs(e.position.y - bot.entity.position.y) < 8, 32);
    const threats = world.getNearbyEntities(bot, 12).filter(e => mc.isHostile(e) && !NEUTRAL.includes(e.name)).length;
    const hurt = bot.health < 12;
    if (enemy && !(hurt && threats > 1) && !(enemy.name === 'creeper' && bot.health < 10)) {
        // attackEntity counts a mob out of 24 blocks as killed: a creeper across the area was "killed" 83 times
        // while the guard stood still and zombies took it apart. Close in first.
        if (enemy.position.distanceTo(bot.entity.position) > 16) {
            await goToGoal(bot, new pf.goals.GoalNear(enemy.position.x, enemy.position.y, enemy.position.z, 4)).catch(() => {});
            return `closed in on ${enemy.name}`;
        }
        log(bot, `Engaging ${enemy.name} at ${enemy.position.floored()}.`);
        // counted only when the game says it died: attackEntity also returns once the mob is out of sight, and
        // counting that made a night's tally read 401 skeletons
        let died = false;
        const onDead = entity => { if (entity.id === enemy.id) died = true; };
        bot.on('entityDead', onDead);
        try {
            await attackEntity(bot, enemy, true);
        } finally {
            bot.removeListener('entityDead', onDead);
        }
        const killed = died;
        if (killed) {
            s.kills[enemy.name] = (s.kills[enemy.name] ?? 0) + 1;
            log(bot, `Defeated ${enemy.name}.`);
        }
        return killed ? `defeated ${enemy.name}` : `fought ${enemy.name}`;
    }

    // 2. hurt: back to the post and eat
    if (bot.health < 12 || bot.food < 14) {
        if (Math.hypot(bot.entity.position.x - post.x, bot.entity.position.z - post.z) > 4) await walkTo(bot, post.x, post.z, 2); // the post's own height is where the bot stood (a tree top at spawn)
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
    await walkTo(bot, x, z, 2); // an unreachable waypoint: the next one next time
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
