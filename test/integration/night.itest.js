// @ts-check
// Getting through a night (#34). Make it night on flat ground, let the loop dig in by itself, set zombies on it,
// and check that it is still alive at dawn and climbs back out. Sets the time, so run it on the lab server when
// a soak test is using the main one: MC_DEV_SERVICE=minecraft-lab MC_PORT=55917 node --test test/integration/night.itest.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { startHarness } from '../../scripts/lib/harness.js';
import { rcon } from '../../scripts/lib/rcon.js';
import { loadJSON } from '../../src/decision/persistence.js';

const BOT = 'night_bot';
const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));
/** @returns {any[]} */
const events = () => {
    try {
        return readFileSync(`./bots/${BOT}/decisions.jsonl`, 'utf8').split('\n').filter(Boolean).map((/** @type {string} */ l) => JSON.parse(l));
    } catch {
        return [];
    }
};

/** @type {Awaited<ReturnType<typeof startHarness>> | null} */
let harness = null;

before(async () => {
    rmSync(`./bots/${BOT}`, { recursive: true, force: true });
    await rcon('difficulty peaceful');
    await rcon('time set day');
    await rcon('gamerule doDaylightCycle false');
    harness = await startHarness({
        name: BOT, mindserverPort: 8098, verbose: process.env.ITEST_VERBOSE === '1',
        profile: { decision_model: 'rules', goals: [], tactical: { periodMs: 1000 } }, // nothing to wander off after
    });
    await rcon(`clear ${BOT}`);
    await rcon(`effect clear ${BOT}`);
    // flat grass over plenty of dirt, nothing to hide behind
    const at = `execute at ${BOT} run`;
    await rcon(`${at} forceload add ~-24 ~-24 ~24 ~24`);
    await rcon(`${at} fill ~-16 ~-4 ~-16 ~16 ~-1 ~16 minecraft:dirt`);
    await rcon(`${at} fill ~-16 ~-1 ~-16 ~16 ~-1 ~16 minecraft:grass_block`);
    await rcon(`${at} fill ~-16 ~ ~-16 ~16 ~6 ~16 minecraft:air`);
});

after(async () => {
    await rcon('gamerule doDaylightCycle true').catch(() => {});
    await rcon('kill @e[type=zombie]').catch(() => {});
    await rcon(`execute at ${BOT} run forceload remove ~-24 ~-24 ~24 ~24`).catch(() => {});
    await rcon('difficulty easy').catch(() => {});
    await rcon('time set day').catch(() => {});
    await harness?.stop();
});

test('at night it digs in, survives zombies, and climbs out at dawn', { timeout: 300_000 }, async () => {
    await rcon('time set 13000');
    const dugIn = Date.now() + 90_000;
    while (!events().some(e => e.type === 'sheltered')) {
        if (Date.now() > dugIn) assert.fail(`never sheltered; events: ${JSON.stringify(events().filter(e => e.kind === 'event').map(e => [e.type, e.detail]).slice(-12))}`);
        await sleep(2_000);
    }

    const shelteredAt = events().find(e => e.type === 'sheltered').t;
    await rcon('difficulty easy');
    for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3]]) await rcon(`execute at ${BOT} run summon zombie ~${dx} ~2 ~${dz}`);
    await sleep(45_000);
    assert.equal(events().filter(e => e.type === 'death').length, 0, 'died in its shelter');
    assert.equal(events().filter(e => e.kind === 'call' && e.t > shelteredAt).length, 0, 'no provider was asked anything once sheltered');

    await rcon('difficulty peaceful'); // the zombies go; the climb out is not a fight
    await rcon('time set 23400');
    const out = Date.now() + 60_000;
    while (!events().some(e => e.type === 'result' && String(e.detail?.command).startsWith('!goToSurface'))) {
        if (Date.now() > out) assert.fail('never left the shelter at dawn');
        await sleep(2_000);
    }
    assert.equal(loadJSON(`./bots/${BOT}/decision_state.json`)?.loop?.sheltered, false);
});
