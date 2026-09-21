// @ts-check
// The point of the whole decision layer, on a real server: with no API key and nobody telling it what to do,
// the bot works its way from an empty inventory to a wooden pickaxe.
// Needs the dev server: MC_EULA=true npm run dev:server. Run with: npm run test:integration
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../../scripts/lib/harness.js';
import { rcon } from '../../scripts/lib/rcon.js';
import { countOf, inventoryOf } from '../../scripts/lib/poll.js';

const BOT = 'tactical_bot';

function decisionModel() {
    const spec = process.env.ITEST_DECISION_MODEL;
    if (!spec) return 'rules';
    return spec.startsWith('{') || spec.startsWith('[') ? JSON.parse(spec) : spec;
}
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
        // ITEST_DECISION_MODEL=openai (or a JSON spec) runs the same test with a real model deciding
        profile: { decision_model: decisionModel(), tactical: { periodMs: 1000 }, guard: { maxUsdPerDay: 0.05, inputUsdPerMillion: 0.05 } },
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

test(`it gets itself a wooden pickaxe, unprompted (decision model: ${JSON.stringify(decisionModel())})`, { timeout: 420_000 }, async () => {
    const deadline = Date.now() + 360_000;
    /** @type {string | null} */
    let inventory = null;
    let unanswered = 0;
    while (Date.now() < deadline) {
        await sleep(10_000);
        // queries answer even while an action is running, so this never interferes with the loop
        const now = await inventoryOf(harness);
        if (now === null) { unanswered++; continue; } // the agent was restarting
        inventory = now;
        if (countOf(inventory, 'wooden_pickaxe') > 0 || /stone_pickaxe/.test(inventory)) {
            if (unanswered > 0) console.log(`# note: ${unanswered} poll(s) went unanswered (agent restarts)`);
            return;
        }
    }
    assert.fail(`no wooden_pickaxe within 6 minutes; last inventory: ${inventory}`);
});
