// @ts-check
// The point of the whole decision layer, on a real server: with no API key and nobody telling it what to do,
// the bot works its way from an empty inventory to a wooden pickaxe.
// Needs the dev server: MC_EULA=true npm run dev:server. Run with: npm run test:integration
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../../scripts/lib/harness.js';
import { rcon } from '../../scripts/lib/rcon.js';

const BOT = 'tactical_bot';
const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let harness;

before(async () => {
    // Peaceful daylight: this test is about the loop making progress, not about surviving the night.
    await rcon('difficulty peaceful');
    await rcon('time set day');
    await rcon('gamerule doDaylightCycle false');
    harness = await startHarness({
        name: BOT,
        mindserverPort: 8097,
        profile: { decision_model: 'rules', tactical: { periodMs: 1000 } },
        verbose: process.env.ITEST_VERBOSE === '1',
    });
    await rcon(`clear ${BOT}`);
});

after(async () => {
    await rcon('gamerule doDaylightCycle true').catch(() => {});
    await rcon('difficulty easy').catch(() => {});
    await rcon(`clear ${BOT}`).catch(() => {});
    await harness?.stop();
});

test('it gets itself a wooden pickaxe, unprompted and with no model', { timeout: 420_000 }, async () => {
    const deadline = Date.now() + 360_000;
    /** @type {string} */
    let inventory = '';
    while (Date.now() < deadline) {
        await sleep(10_000);
        // queries answer even while an action is running, so this never interferes with the loop
        inventory = await harness.send('!inventory', { timeoutMs: 30_000 });
        if (/wooden_pickaxe/.test(inventory)) return;
    }
    assert.fail(`no wooden_pickaxe within 6 minutes; last inventory: ${inventory}`);
});
