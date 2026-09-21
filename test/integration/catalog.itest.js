// @ts-check
// Needs the dev server: MC_EULA=true npm run dev:server. Run with: npm run test:integration
// Checks the catalog against the real game: real registry, real recipe book, and Mindcraft's own command
// parser accepting the strings the catalog builds.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../../scripts/lib/harness.js';
import { rcon } from '../../scripts/lib/rcon.js';
import { ACTIONS, buildCommand, createKnowledge, listActions, listQuantities, listTargets, takeSnapshot } from '../../src/decision/index.js';
import { setSettings } from '../../src/agent/settings.js';

const PROBE = 'catalog_probe';
const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

/** @type {any} a bot created by Mindcraft's own initBot(), so its game data (mcdata) is initialised too */
let probe;
/** @type {(message: string) => unknown} Mindcraft's command parser; returns a string when it rejects */
let parseCommandMessage;
/** @type {Awaited<ReturnType<typeof startHarness>>} */
let harness;

before(async () => {
    // mcdata.js reads the game version from settings when it is first imported, and the parser validates block
    // and item names through it, so: settings first, then import, then a bot whose login initialises the data.
    setSettings({ host: '127.0.0.1', port: 55916, auth: 'offline', minecraft_version: '1.21.6' });
    const { initBot } = await import('../../src/utils/mcdata.js');
    ({ parseCommandMessage } = await import('../../src/agent/commands/index.js'));
    probe = initBot(PROBE);
    await new Promise((resolve, reject) => {
        probe.once('spawn', () => resolve(undefined));
        probe.once('error', reject);
    });
    harness = await startHarness({ name: 'catalog_bot', mindserverPort: 8098 });
    await rcon('time set day');
    for (const name of [PROBE, harness.name]) await rcon(`clear ${name}`);
    // A long-lived dev world is not a safe place to stand: other tests dig holes and a bot that has been
    // logged in before comes back hungry. Patch the ground under this one and top it up before measuring.
    const at = `execute at ${PROBE} run`;
    for (const name of [PROBE, harness.name]) {
        await rcon(`effect give ${name} minecraft:saturation 5 20 true`);
        await rcon(`effect give ${name} minecraft:instant_health 1 20 true`);
    }
    // rcon-cli exits 0 whatever happens, and the failure that actually bites is "That position is not
    // loaded" — everything else ("No blocks were filled" when the pad is already right) is fine.
    const build = async (/** @type {string} */ command) => {
        const reply = await rcon(`${at} ${command}`);
        assert.ok(!/not loaded|Unknown|Expected/i.test(reply), `${command} -> ${reply}`);
        return reply;
    };
    await build('fill ~-3 ~-1 ~-3 ~3 ~-1 ~3 minecraft:smooth_stone');
    await build('fill ~-3 ~ ~-3 ~3 ~3 ~3 minecraft:air');
    await build('setblock ~2 ~ ~0 minecraft:oak_log');
    await build('setblock ~-2 ~ ~0 minecraft:stone');
    await sleep(2000);
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

test('every command the catalog can build here passes Mindcraft\'s own parser', { timeout: 60_000 }, async () => {
    // a rich situation, so that most actions have something to offer
    for (const item of ['iron_pickaxe', 'iron_sword', 'bread 5', 'raw_iron 6', 'coal 4', 'furnace', 'crafting_table', 'torch 8', 'cobblestone 40', 'iron_helmet'])
        await rcon(`give ${PROBE} minecraft:${item}`);
    const at = `execute at ${PROBE} run`;
    await rcon(`${at} setblock ~0 ~ ~2 minecraft:chest`);
    await rcon(`${at} setblock ~0 ~ ~-2 minecraft:furnace`);
    await rcon(`${at} summon minecraft:cow ~2 ~ ~2`);
    await rcon(`effect give ${PROBE} minecraft:hunger 5 200 true`);
    await sleep(4000);

    const snapshot = takeSnapshot(probe, { goal: 'have iron_ingot' });
    const c = { snapshot, knowledge: createKnowledge(probe, snapshot) };
    const offered = listActions(c).map(a => a.id);
    /** @type {string[]} */
    const built = [];
    for (const id of offered) {
        const targets = listTargets(c, id);
        for (const target of targets.length > 0 ? targets.slice(0, 3) : [undefined]) {
            const quantities = listQuantities(c, id, target);
            for (const quantity of quantities.length > 0 ? quantities : [undefined]) built.push(buildCommand(c, { id, target, quantity }));
        }
    }
    assert.ok(offered.length >= 12, `only ${offered} of ${ACTIONS.length} actions were possible`);
    for (const command of built) {
        const parsed = parseCommandMessage(command);
        assert.equal(typeof parsed, 'object', `${command} -> ${parsed}`); // a string is the parser's error message
    }
    await rcon(`${at} kill @e[type=minecraft:cow,distance=..16]`);
    await rcon(`clear ${PROBE}`);
});

test('commands built by the catalog are accepted and executed by Mindcraft', { timeout: 120_000 }, async () => {
    await rcon(`give ${PROBE} minecraft:oak_planks 8`);
    await sleep(1500);
    const command = buildCommand(context(), { id: 'craft', target: 'stick', quantity: 1 });
    assert.equal(command, '!craftRecipe("stick", 1)');
    await rcon(`give ${harness.name} minecraft:oak_planks 8`);
    await sleep(1000);
    const result = await harness.send(command);
    assert.match(result, /crafted stick/i);
    assert.match(await harness.send('!inventory'), /stick: 4/);
});
