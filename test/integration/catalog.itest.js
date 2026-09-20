// @ts-check
// Needs the dev server: MC_EULA=true npm run dev:server. Run with: npm run test:integration
// Checks the catalog against the real game: real registry, real recipe book, and Mindcraft's own command
// parser accepting the strings the catalog builds.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mineflayer from 'mineflayer';
import { startHarness } from '../../scripts/lib/harness.js';
import { rcon } from '../../scripts/lib/rcon.js';
import { buildCommand, createKnowledge, listActions, listTargets, takeSnapshot } from '../../src/decision/index.js';

const PROBE = 'catalog_probe';
const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

/** @type {import('mineflayer').Bot} */
let probe;
/** @type {Awaited<ReturnType<typeof startHarness>>} */
let harness;

before(async () => {
    probe = mineflayer.createBot({ host: '127.0.0.1', port: 55916, username: PROBE, auth: 'offline', version: '1.21.6' });
    await new Promise((resolve, reject) => {
        probe.once('spawn', () => resolve(undefined));
        probe.once('error', reject);
    });
    harness = await startHarness({ name: 'catalog_bot', mindserverPort: 8098 });
    await rcon('time set day');
    for (const name of [PROBE, harness.name]) await rcon(`clear ${name}`);
    // a stone pad with one log and one stone block on it, so the scene does not depend on the terrain
    const at = `execute at ${PROBE} run`;
    await rcon(`${at} fill ~-3 ~-1 ~-3 ~3 ~-1 ~3 minecraft:smooth_stone`);
    await rcon(`${at} fill ~-3 ~ ~-3 ~3 ~3 ~3 minecraft:air`);
    await rcon(`${at} setblock ~2 ~ ~0 minecraft:oak_log`);
    await rcon(`${at} setblock ~-2 ~ ~0 minecraft:stone`);
    await sleep(1500);
});

after(async () => {
    for (const name of [PROBE, harness?.name]) if (name) await rcon(`clear ${name}`).catch(() => {});
    probe?.quit();
    await harness?.stop();
});

const context = () => {
    const snapshot = takeSnapshot(probe);
    return { snapshot, knowledge: createKnowledge(probe, snapshot) };
};

test('real harvest rules: stone is offered only once the bot holds a pickaxe', { timeout: 60_000 }, async () => {
    let targets = listTargets(context(), 'collect_blocks');
    assert.ok(targets.includes('oak_log'), String(targets));
    assert.ok(!targets.includes('stone'), String(targets));

    await rcon(`give ${PROBE} minecraft:wooden_pickaxe 1`);
    await sleep(1500);
    targets = listTargets(context(), 'collect_blocks');
    assert.ok(targets.includes('stone'), String(targets));
});

test('real recipe book: planks unlock sticks and a crafting table, not a stone pickaxe', { timeout: 60_000 }, async () => {
    assert.ok(!listActions(context()).some(a => a.id === 'craft'));
    await rcon(`give ${PROBE} minecraft:oak_planks 8`);
    await sleep(1500);
    const craftable = listTargets(context(), 'craft');
    assert.ok(craftable.includes('stick') && craftable.includes('crafting_table'), String(craftable));
    assert.ok(!craftable.includes('stone_pickaxe'), String(craftable));
});

test('commands built by the catalog are accepted and executed by Mindcraft', { timeout: 120_000 }, async () => {
    const command = buildCommand(context(), { id: 'craft', target: 'stick', quantity: 1 });
    assert.equal(command, '!craftRecipe("stick", 1)');
    await rcon(`give ${harness.name} minecraft:oak_planks 8`);
    await sleep(1000);
    const result = await harness.send(command);
    assert.match(result, /crafted stick/i);
    assert.match(await harness.send('!inventory'), /stick: 4/);
});
