// @ts-check
// An impossible goal must not trap the bot. Give it one it cannot reach (a nether star, in the overworld, with
// empty hands) followed by one it can, and check that it gives the first up and gets on with the second.
// Needs the dev server: MC_EULA=true npm run dev:server. Run with: npm run test:integration
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../../scripts/lib/harness.js';
import { rcon } from '../../scripts/lib/rcon.js';

const BOT = 'guard_bot';
const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let harness;

before(async () => {
    await rcon('difficulty peaceful');
    await rcon('time set day');
    harness = await startHarness({
        name: BOT,
        mindserverPort: 8095,
        verbose: process.env.ITEST_VERBOSE === '1',
        profile: {
            decision_model: 'rules',
            goals: [
                { type: 'have_item', item: 'nether_star', count: 1 },
                { type: 'have_item', item: 'oak_log', count: 2 },
            ],
            // short fuses so the test does not take all afternoon; the defaults are minutes
            tactical: { periodMs: 1000, stuckGoalMs: 4000 },
            guard: { stallAfter: 4, failAfter: 8 },
        },
    });
    await rcon(`clear ${BOT}`);
});

after(async () => {
    await rcon('difficulty easy').catch(() => {});
    await rcon(`clear ${BOT}`).catch(() => {});
    await harness?.stop();
});

test('an unreachable goal is given up, and the bot moves on to the next one', { timeout: 300_000 }, async () => {
    const deadline = Date.now() + 240_000;
    let inventory = '';
    while (Date.now() < deadline) {
        await sleep(8_000);
        inventory = await harness.send('!inventory', { timeoutMs: 30_000 });
        const logs = Number(/oak_log: (\d+)/.exec(inventory)?.[1] ?? 0);
        if (logs >= 2) return;
    }
    assert.fail(`still no oak_log after 4 minutes, so it never let go of the nether star. Inventory: ${inventory}`);
});
