// @ts-check
// Measure how big the compressed state is on the live dev server, in three staged situations.
//   node scripts/measure_state.js            (needs: MC_EULA=true npm run dev:server)
import mineflayer from 'mineflayer';
import { takeSnapshot } from '../src/decision/snapshot.js';
import { compressState } from '../src/decision/state.js';
import { estimateTokens } from '../src/decision/tokens.js';
import { rcon } from './lib/rcon.js';

const NAME = 'state_probe';
const BUDGET = 500;
const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 55916, username: NAME, auth: 'offline', version: '1.21.6' });
await new Promise((resolve, reject) => {
    bot.once('spawn', () => resolve(undefined));
    bot.once('error', reject);
    bot.once('kicked', reason => reject(new Error(`kicked: ${reason}`)));
});
await sleep(3000); // let chunks and entities arrive

/** @type {{scenario: string, view: string, tokens: number, raw: number}[]} */
const rows = [];
/** @param {string} scenario @param {import('../src/decision/snapshot.js').SnapshotExtras} extras */
function measure(scenario, extras) {
    const snapshot = takeSnapshot(bot, extras);
    const raw = estimateTokens(snapshot);
    for (const view of /** @type {const} */ (['tactical', 'combat', 'crafting'])) {
        const state = compressState(snapshot, { view });
        rows.push({ scenario, view, tokens: estimateTokens(state), raw });
        if (view === 'tactical') console.log(`\n[${scenario}] ${JSON.stringify(state)}`);
    }
}

try {
    await rcon(`gamemode survival ${NAME}`);
    await rcon(`effect give ${NAME} minecraft:resistance 120 4 true`); // stay alive while being measured

    await rcon('time set 1000');
    await rcon(`clear ${NAME}`);
    await sleep(1500);
    measure('early game, day, empty inventory', { goal: 'have wooden_pickaxe' });

    await rcon('time set 18000');
    for (const mob of ['zombie', 'zombie', 'skeleton', 'spider', 'creeper'])
        await rcon(`execute at ${NAME} run summon minecraft:${mob} ~6 ~ ~6`);
    await rcon(`give ${NAME} minecraft:iron_sword 1`);
    await rcon(`give ${NAME} minecraft:cooked_beef 8`);
    await sleep(2500);
    measure('night, under attack', {
        goal: 'survive the night',
        action: { name: 'attack', elapsedMs: 5200 },
        recent: [{ cmd: '!attack("zombie")', ok: true }, { cmd: '!goToPlayer("tomo", 3)', ok: false, note: 'Timeout: took too long to decide path to goal' }],
    });
    await rcon('kill @e[type=!minecraft:player,distance=..64]');

    const items = ['diamond_pickaxe', 'iron_axe', 'iron_shovel', 'shield', 'bow', 'water_bucket', 'bread 32', 'cooked_porkchop 16',
        'cobblestone 64', 'oak_log 64', 'oak_planks 64', 'stick 64', 'coal 40', 'raw_iron 23', 'iron_ingot 12', 'diamond 3',
        'torch 64', 'crafting_table 2', 'furnace 1', 'chest 4', 'dirt 64', 'gravel 30', 'sand 17', 'andesite 50', 'granite 44',
        'wheat_seeds 21', 'rotten_flesh 9', 'bone 14', 'string 11', 'arrow 48', 'gunpowder 5', 'oak_sapling 7', 'flint 6',
        'leather 3', 'feather 12', 'redstone 33'];
    for (const item of items) await rcon(`give ${NAME} minecraft:${item}`);
    await sleep(2500);
    measure('late game, inventory full', {
        goal: 'have diamond_pickaxe and return to base',
        action: { name: 'collectBlocks', elapsedMs: 31000 },
        recent: [{ cmd: '!craftRecipe("iron_pickaxe", 1)', ok: true }, { cmd: '!smeltItem("raw_iron", 8)', ok: true }, { cmd: '!collectBlocks("diamond_ore", 3)', ok: false, note: 'no diamond_ore nearby' }],
    });
} finally {
    await rcon(`clear ${NAME}`).catch(() => {});
    bot.quit();
}

console.log('\n| scenario | view | tokens (est.) | uncompressed snapshot |');
console.log('|---|---|---:|---:|');
for (const row of rows) console.log(`| ${row.scenario} | ${row.view} | ${row.tokens} | ${row.raw} |`);
const worst = Math.max(...rows.map(row => row.tokens));
console.log(`\nworst case: ${worst} tokens (budget ${BUDGET})`);
process.exit(worst <= BUDGET ? 0 : 1);
