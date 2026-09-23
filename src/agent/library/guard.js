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
// how far past the round raiders are met. Far out it leaves the village open behind it; this is the distance
// at which it still goes out to meet one, when there are no villagers to stand with.
const INTERCEPT = Number(process.env.GUARD_INTERCEPT ?? 32);
const RANGED = ['pillager', 'skeleton', 'stray', 'bogged', 'witch', 'illusioner', 'drowned'];
const FOOD = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'bread', 'baked_potato', 'cooked_cod',
    'cooked_salmon', 'apple', 'carrot', 'beef', 'porkchop', 'mutton', 'rabbit', 'cooked_rabbit'];

function stats(bot) {
    if (!bot.guardStats) {
        bot.guardStats = { kills: {}, torches: 0, round: 0, regroupUntil: 0 };
        // straight back into the fight it just lost is another death: a raid cost eighteen that way. Regroup.
        bot.on('death', () => { bot.guardStats.regroupUntil = Date.now() + 20_000; });
        // Every hostile that dies beside the guard counts for the night's tally, whoever struck the blow: most
        // of the fighting is done by the self-defence reflex, and a night of seventeen kills was reported as none.
        bot.on('entityDead', entity => {
            if (!mc.isHostile(entity) || NEUTRAL.includes(entity.name)) return;
            if (entity.position.distanceTo(bot.entity.position) > 10) return; // something else's kill, elsewhere
            bot.guardStats.kills[entity.name] = (bot.guardStats.kills[entity.name] ?? 0) + 1;
        });
    }
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
        // standing in water drowns a guard that stops to fight there: that column is not ground to walk to
        if (block.name === 'water' || block.name === 'lava' || block.name === 'kelp' || block.name === 'seagrass') return null;
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
    if (y === null) return; // water, lava, or a column not loaded: not a place to stand. The next point will do
    await goWatched(bot, new pf.goals.GoalNear(x, y, z, range), true);
}

/**
 * Walk to a goal, giving it up when the loop asks the action to stop, and (with `forThreats`) when something
 * turns up to fight. Without the first, a patrol across a village kept the agent walking through the ten
 * seconds Mindcraft allows an action to stop in, and it was killed and restarted six times in one night.
 */
async function goWatched(bot, goal, forThreats = false) {
    const watch = setInterval(() => {
        if (bot.interrupt_code || (forThreats && threatNear(bot))) {
            bot.pathfinder.setGoal(null);
            bot.pathfinder.stop();
        }
    }, 250);
    try {
        await goToGoal(bot, goal).catch(() => {});
    } finally {
        clearInterval(watch);
    }
}

/**
 * Put a torch on a dark spot: walk there first, interruptibly. placeBlock walks the last stretch itself with a
 * pathfinder call that ignores the stop the loop asks for, and a patrol that stopped to light a far corner was
 * killed and restarted eight times in one night.
 * @returns {Promise<boolean>}
 */
async function lightSpot(bot, spot) {
    const middle = spot.offset(0.5, 0, 0.5);
    if (bot.entity.position.distanceTo(middle) > 3) await walkTo(bot, spot.x, spot.z, 2);
    const away = bot.entity.position.distanceTo(middle);
    // not where it stands: placeBlock then steps aside with a pathfinder call of its own that ignores the stop
    if (away < 1.6 || away > 4.5 || bot.interrupt_code) return false;
    return withTimeout(bot, placeBlock(bot, 'torch', spot.x, spot.y, spot.z, 'bottom', true).catch(() => false), 6000);
}

/**
 * Give up on a skill that has not finished in time, and stop whatever walking it started. Mindcraft's own
 * skills run pathfinder calls that do not watch bot.interrupt_code, and an action that will not stop inside ten
 * seconds has its whole process killed (modes.js cleanKill).
 * @template T
 * @param {MinecraftBot} bot
 * @param {Promise<T>} work
 * @param {number} ms
 * @returns {Promise<T | false>}
 */
async function withTimeout(bot, work, ms) {
    let timer = null;
    const out = await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
    if (timer) clearTimeout(timer);
    if (out === false) {
        try { bot.pathfinder.setGoal(null); bot.pathfinder.stop(); } catch { /* not walking */ }
    }
    return /** @type {T | false} */ (out);
}

/**
 * One step of guarding the area of `radius` around `center`.
 * @param {MinecraftBot} bot
 * @param {{x: number, y: number, z: number}} center
 * @param {number} radius
 * @returns {Promise<string>} what it did
 */
export async function patrol(bot, center, radius = 24) {
    // One step of guarding, and never longer than eight seconds: Mindcraft kills the whole agent process when an
    // action will not stop within ten (modes.js cleanKill), and a walk across the village took longer than that,
    // which cost the guard six restarts in a night (and with them its night tally and its post).
    const step = patrolStep(bot, center, radius);
    const out = await withTimeout(bot, step, 8000);
    return out === false ? 'still going; will pick it up next step' : out;
}

async function patrolStep(bot, center, radius) {
    if (bot.interrupt_code) return 'stopped';
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
    const raiders = Object.values(bot.entities).filter(e => RAIDERS.includes(e.name) && inArea(e.position, post, radius + INTERCEPT)
        && Math.abs(e.position.y - bot.entity.position.y) < 16 && e.position.distanceTo(bot.entity.position) < 100);
    // the one nearest a villager first: the raid is only dangerous where the villagers are, and a guard that
    // took them in the order it met them lost four of five while it worked through the ones by the wall
    const villagers = Object.values(bot.entities).filter(e => e.name === 'villager');
    const toVillager = (/** @type {any} */ e) => Math.min(Infinity, ...villagers.map(v => v.position.distanceTo(e.position)));
    const raider = raiders.sort((a, b) => (toVillager(a) - toVillager(b)) || (a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)))[0] ?? null;

    // 0. just killed: stay at the post, eat, and let the mobs come to it rather than running back into them
    if (Date.now() < (s.regroupUntil ?? 0)) {
        if (bot.entity.position.distanceTo(post) > 8) await walkTo(bot, post.x, post.z, 3);
        const meal = FOOD.find(name => bot.inventory.items().some(item => item.name === name));
        if (meal && bot.food < 20) await withTimeout(bot, consume(bot, meal), 6000);
        else await new Promise(resolve => setTimeout(resolve, 500));
        return 'regrouping';
    }

    // 1. a ravager in the area: keep away from it. It cannot be fought with an iron sword (a hundred health,
    // and it charges), and standing near one killed this guard forty-two times in a single raid.
    const ravager = world.getNearestEntityWhere(bot, e => e.name === 'ravager', 12);
    if (ravager) {
        const away = bot.entity.position.minus(ravager.position).normalize().scaled(16);
        await walkTo(bot, bot.entity.position.x + away.x, bot.entity.position.z + away.z, 2);
        return 'keeping clear of the ravager';
    }

    // 2. hurt: out of the fight, away from whatever is hitting it, and eat. Twelve is three hits from a
    // vindicator; holding on to eight cost the guard seven deaths in one raid.
    if (bot.health < 12) {
        const food = FOOD.find(name => bot.inventory.items().some(item => item.name === name));
        const near = threatNear(bot);
        if (near && near.position.distanceTo(bot.entity.position) < 8) {
            // put ground between them first: eating in reach of a vindicator just feeds it the kill
            const away = bot.entity.position.minus(near.position).normalize().scaled(12);
            await walkTo(bot, bot.entity.position.x + away.x, bot.entity.position.z + away.z, 2);
        } else if (bot.entity.position.distanceTo(post) > 6) await walkTo(bot, post.x, post.z, 3);
        if (food && bot.food < 20) {
            await withTimeout(bot, consume(bot, food), 6000);
            return `hurt: ate ${food}`;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        return 'hurt: holding back';
    }

    // 0. nothing close: light the area first, or it fills with mobs faster than they can be fought (131 in a
    // night with no torch placed, because there was always some mob in the area to go after)
    const close = world.getNearestEntityWhere(bot, e => mc.isHostile(e) && !NEUTRAL.includes(e.name), 10);
    if (!close && !raider && bot.inventory.items().some(item => item.name === 'torch')) {
        const spot = darkSpot(bot, post, radius);
        if (spot && await lightSpot(bot, spot)) {
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
    // a witch heals itself and throws harming potions: at less than full-ish health that trade is lost (two of
    // the guard's deaths were "killed by Witch using magic"). Leave it be until patched up.
    // a ravager has a hundred health and hits for most of a guard's: it killed this one fourteen times in a raid.
    // Left alone it wrecks the village slowly; fought, it ends the guard at once. Leave it.
    const tooRisky = (enemy?.name === 'creeper' && bot.health < 10) || (enemy?.name === 'witch' && bot.health < 16)
        || enemy?.name === 'ravager';
    if (enemy && !(hurt && threats > 1) && !tooRisky) {
        // attackEntity counts a mob out of 24 blocks as killed: a creeper across the area was "killed" 83 times
        // while the guard stood still and zombies took it apart. Close in first.
        if (enemy.position.distanceTo(bot.entity.position) > 16) {
            // shield up while closing on something that shoots: pillagers and skeletons did most of the killing
            const shielded = RANGED.includes(enemy.name) && bot.inventory.slots[45]?.name === 'shield';
            if (shielded) { bot.lookAt(enemy.position.offset(0, 1.4, 0), true).catch(() => {}); bot.activateItem(true); }
            try {
                await goWatched(bot, new pf.goals.GoalNear(enemy.position.x, enemy.position.y, enemy.position.z, 4));
            } finally {
                if (shielded) bot.deactivateItem();
            }
            return `closed in on ${enemy.name}`;
        }
        log(bot, `Engaging ${enemy.name} at ${enemy.position.floored()}.`);
        // whether it died is what the game says, not what attackEntity returns: that also comes back when the
        // mob is merely out of sight, and counting those made a night's tally read 401 skeletons
        let died = false;
        const onDead = entity => { if (entity.id === enemy.id) died = true; };
        bot.on('entityDead', onDead);
        try {
            await attackEntity(bot, enemy, true);
        } finally {
            bot.removeListener('entityDead', onDead);
        }
        if (died) log(bot, `Defeated ${enemy.name}.`);
        return died ? `defeated ${enemy.name}` : `fought ${enemy.name}`;
    }

    // 2. hurt: back to the post and eat
    if (bot.health < 12 || bot.food < 14) {
        if (Math.hypot(bot.entity.position.x - post.x, bot.entity.position.z - post.z) > 4) await walkTo(bot, post.x, post.z, 2); // the post's own height is where the bot stood (a tree top at spawn)
        const food = FOOD.find(name => bot.inventory.items().some(item => item.name === name));
        if (food && bot.food < 20) {
            await withTimeout(bot, consume(bot, food), 6000);
            return `ate ${food}`;
        }
        if (bot.health < 12) return 'resting at the post';
    }

    // 3. a dark spot nearby: light it so nothing spawns there
    if (bot.inventory.items().some(item => item.name === 'torch')) {
        const spot = darkSpot(bot, post, radius);
        if (spot && await lightSpot(bot, spot)) {
            s.torches++;
            return `lit ${spot}`;
        }
    }

    // 4. villagers to guard: stand with them rather than walk the round, and never leave them while a raid is
    // on. Going out to finish off the last raiders once things went quiet was tried and lost all five villagers
    // while the guard was away (it killed nine and came back to an empty village). What a raid costs is villagers, and
    // three tactics measured over one raid each say so plainly: meeting the raiders out at the edge left one
    // villager of five (19 kills), meeting them at the edge of the round left one of five (7 kills), standing
    // with them left all five alive with the guard unhurt (10 kills).
    if (villagers.length > 0) {
        const mid = villagers.reduce((v, e) => v.plus(e.position), new Vec3(0, 0, 0)).scaled(1 / villagers.length);
        if (bot.entity.position.distanceTo(mid) > 6) {
            await walkTo(bot, mid.x, mid.z, 3);
            return `with the villagers at ${mid.floored()}`;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        return 'standing with the villagers';
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
