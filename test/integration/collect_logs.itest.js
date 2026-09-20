// @ts-check
// Needs the dev server: MC_EULA=true npm run dev:server. Run with: npm run test:integration
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../../scripts/lib/harness.js';
import { rcon } from '../../scripts/lib/rcon.js';

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let harness;

before(async () => {
    harness = await startHarness({ name: 'itest_bot' });
    await rcon('time set day');
    await rcon(`clear ${harness.name}`);
});

after(async () => {
    await harness?.stop();
});

test('collects oak logs placed next to it, with no LLM involved', { timeout: 180_000 }, async () => {
    // Put the logs in the world ourselves so the test does not depend on the terrain around spawn.
    await rcon(`execute at ${harness.name} run fill ~2 ~ ~2 ~2 ~2 ~2 minecraft:oak_log`);

    const result = await harness.send('!collectBlocks("oak_log", 3)');
    assert.match(result, /Collected 3 oak_log/);

    const inventory = await harness.send('!inventory');
    assert.match(inventory, /oak_log: 3/);
});
