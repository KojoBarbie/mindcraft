// @ts-check
// A restarted agent must carry on, not start over. Give it an impossible goal and a possible one, let it give up
// the first, stop the agent, start it again, and check it still counts the first as given up instead of
// spending another few minutes rediscovering that.
// Needs the dev server: MC_EULA=true npm run dev:server. Run with: npm run test:integration
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { startHarness } from '../../scripts/lib/harness.js';
import { rcon } from '../../scripts/lib/rcon.js';
import { loadJSON } from '../../src/decision/persistence.js';

const BOT = 'persist_bot';
const STATE = `./bots/${BOT}/decision_state.json`;
const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));
const start = () => startHarness({
    name: BOT,
    mindserverPort: 8096,
    verbose: process.env.ITEST_VERBOSE === '1',
    profile: {
        decision_model: 'rules',
        goals: [
            { type: 'have_item', item: 'nether_star', count: 1 },
            { type: 'have_item', item: 'dirt', count: 64 }, // reachable, but keeps it busy past the restart
        ],
        tactical: { periodMs: 1000, stuckGoalMs: 4000 },
        guard: { stallAfter: 4, failAfter: 8 },
    },
});
/** @returns {any} */
const netherStar = () => loadJSON(STATE)?.goals?.goals?.find((/** @type {any} */ g) => g.goal.item === 'nether_star');

/** @type {Awaited<ReturnType<typeof startHarness>> | null} */
let harness = null;

before(async () => {
    rmSync(`./bots/${BOT}`, { recursive: true, force: true });
    await rcon('difficulty peaceful');
    await rcon('time set day');
    harness = await start();
    await rcon(`clear ${BOT}`);
    // the same flat arena as guard.itest.js, for the same reason
    const at = `execute at ${BOT} run`;
    await rcon(`${at} forceload add ~-48 ~-48 ~48 ~48`);
    for (const [x0, x1] of [[-40, -1], [0, 40]]) {
        await rcon(`${at} fill ~${x0} ~-1 ~-40 ~${x1} ~-1 ~40 minecraft:grass_block`);
        await rcon(`${at} fill ~${x0} ~ ~-40 ~${x1} ~4 ~40 minecraft:air`);
    }
});

after(async () => {
    await rcon(`execute at ${BOT} run forceload remove ~-48 ~-48 ~48 ~48`).catch(() => {});
    await rcon('difficulty easy').catch(() => {});
    await rcon(`clear ${BOT}`).catch(() => {});
    await harness?.stop();
});

test('a goal given up before a restart stays given up after it', { timeout: 420_000 }, async () => {
    const deadline = Date.now() + 240_000;
    while (netherStar()?.status !== 'failed') {
        if (Date.now() > deadline) assert.fail(`the nether star was never given up: ${JSON.stringify(netherStar())}`);
        await sleep(4_000);
    }
    await harness?.stop();
    harness = null;
    const saved = loadJSON(STATE);
    assert.equal(saved.clean, true, 'a stop is a clean shutdown and is saved as one');

    harness = await start();
    await sleep(10_000); // several decisions: a fresh queue would be chasing the nether star again by now
    const after = loadJSON(STATE);
    assert.ok(after.savedAt > saved.savedAt, 'the restarted agent is saving again');
    assert.equal(netherStar()?.status, 'failed', 'the restarted agent forgot it had given up on the nether star');
    assert.equal(after.loop.restarts, 0, 'a clean stop is not counted as a crash');
});
