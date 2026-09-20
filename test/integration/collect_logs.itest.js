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
    // Build the scene ourselves so the test does not depend on the terrain around spawn: a flat stone pad
    // with clear air above it, and three separate logs on the ground. Keep them apart: with adjacent logs the
    // pathfinder reproducibly times out on the last one ("Took to long to decide path to goal").
    // rcon-cli exits 0 even when the command fails, so check the server's replies.
    const at = `execute at ${harness.name} run`;
    assert.match(await rcon(`${at} fill ~-4 ~-1 ~-4 ~4 ~-1 ~4 minecraft:stone`), /Successfully filled/);
    await rcon(`${at} fill ~-4 ~ ~-4 ~4 ~3 ~4 minecraft:air`); // replies "No blocks were filled" if already clear
    for (const pos of ['~3 ~ ~-3', '~3 ~ ~0', '~3 ~ ~3']) {
        assert.match(await rcon(`${at} setblock ${pos} minecraft:oak_log`), /Changed the block/);
    }

    const result = await harness.send('!collectBlocks("oak_log", 3)');
    assert.match(result, /Collected 3 oak_log/);

    const inventory = await harness.send('!inventory');
    assert.match(inventory, /oak_log: 3/);
});
