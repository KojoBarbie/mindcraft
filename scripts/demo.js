// @ts-check
// Record a demo: ask the bot for something in chat, film it from behind while it works, and write a page that
// plays the footage next to what it decided and why, in step.
//
//   node scripts/demo.js --request "石のツルハシを作って" [--minutes 8] [--time 1000] [--lab]
//
// The bot runs the full stack: tactical loop on Jev, strategist gpt-5-mini turning the request into goals.
// Output: demos/<time>-<name>/ with index.html, the frames packed into sheets, and the raw records. Open
// index.html in a browser, or publish the folder as a private page.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { startHarness } from './lib/harness.js';
import { rcon } from './lib/rcon.js';
import { createCameraRig } from './lib/camera_rig.js';
import { buildTimeline, packSheets, renderPage } from './lib/demo_page.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
if (args.includes('--lab')) {
    process.env.MC_DEV_SERVICE = 'minecraft-lab';
    process.env.MC_PORT = '55917';
}
process.env.COMPOSE_PROJECT_NAME ??= 'mindcraft';

const request = opt('request', '');
if (!request) {
    console.error('usage: node scripts/demo.js --request "石のツルハシを作って" [--minutes 8] [--time 1000] [--lab]');
    process.exit(1);
}
const minutes = Number(opt('minutes', '8'));
const fps = Number(opt('fps', '2'));
const name = opt('name', 'demo_bot');
// --role miner: run a role (src/decision/roles/) centred where the bot starts; --until diamond:1 ends the run
// as soon as the inventory holds that many
const role = opt('role', '');
const [untilItem, untilCount] = opt('until', '').split(':');
// --role-options '{"quota": 16, "chest": "start"}'; --chest puts a chest two blocks east of the bot at the start
const roleOptions = JSON.parse(opt('role-options', '{}'));
const port = Number(opt('port', '8120')); // the MindServer's; give each demo running at once its own
const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));
/** @param {string} path */
const readJsonl = path => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
}) : []);

async function main() {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const out = join(ROOT, 'demos', `${stamp}-${name}`);
    const framesDir = join(out, 'frames');
    mkdirSync(framesDir, { recursive: true });
    const botDir = join(ROOT, 'bots', name);
    rmSync(botDir, { recursive: true, force: true });
    mkdirSync(botDir, { recursive: true });
    process.env.MINDCRAFT_USAGE_LOG = join(botDir, 'llm_usage.jsonl');

    // --fresh-world (lab only): put the lab world back as it was generated, so earlier runs' holes and spilt
    // lava do not decide this one (the same restore the benchmark uses)
    if (args.includes('--fresh-world')) {
        if (!args.includes('--lab')) throw new Error('--fresh-world needs --lab: the main dev world is not restored');
        const { restoreLabWorld } = await import('./lib/lab_world.js');
        await restoreLabWorld();
    }
    await rcon('difficulty easy');
    await rcon('weather clear');
    await rcon(`time set ${opt('time', '1000')}`);

    const harness = await startHarness({
        name, mindserverPort: port, verbose: args.includes('--verbose'), spawnTimeoutMs: 120_000,
        profile: {
            decision_model: 'jev', goals: [], strategy_model: 'gpt-5-mini',
            ...(role ? { role: { type: role, ...roleOptions } } : {}),
            tactical: { startDelayMs: 8000 }, // time to move it to the surface and set the scene first
        },
    });
    await rcon(`clear ${name}`);
    // a run starts well: health and hunger are kept in the world from the last run (one began at 5 health)
    await rcon(`effect give ${name} minecraft:instant_health 1 10`);
    await rcon(`effect give ${name} minecraft:saturation 1 20`);
    // Start on the surface near the world spawn, not wherever this bot name was left last time (a food run
    // began inside the previous night's shelter).
    if (!args.includes('--keep-position')) await rcon(`spreadplayers 0 0 0 8 false ${name}`);
    if (args.includes('--chest')) await rcon(`execute at ${name} run setblock ~2 ~ ~ minecraft:chest`);
    // --give iron_pickaxe:1,torch:32 : a starting kit, to try one part of a role without waiting for the rest
    for (const entry of opt('give', '').split(',').filter(Boolean)) {
        const [item, count] = entry.split(':');
        await rcon(`give ${name} minecraft:${item} ${Number(count || 1)}`);
    }
    /** @type {any} */
    let latest = null;
    const feed = io(`http://localhost:${port}`);
    feed.on('connect', () => feed.emit('listen-to-agents'));
    feed.on('state-update', (/** @type {Record<string, any>} */ states) => { if (states?.[name] && !states[name].error) latest = states[name]; });

    const rig = await createCameraRig({ target: name, name: `${name.slice(0, 11)}_cam` });
    /** @type {{i: number, t: number, health: number | null, food: number | null, goal: string | null, inventory: Record<string, number>, timeOfDay: number | null}[]} */
    const frames = [];
    const startedAt = Date.now();
    let requestedAt = 0;
    /** @type {number | null} */
    let doneAt = null;
    const deadline = startedAt + minutes * 60_000;
    try {
        while (Date.now() < deadline) {
            const tick = Date.now();
            if (!requestedAt && tick - startedAt > 3_000) {
                if (request !== '-') harness.post(request); // a player's request, as the strategist hears it
                requestedAt = Date.now();
            }
            await rig.follow();
            const jpg = await rig.frame().catch(() => null);
            if (jpg) {
                const i = frames.length;
                writeFileSync(join(framesDir, `${String(i).padStart(5, '0')}.jpg`), jpg);
                frames.push({
                    i, t: tick,
                    health: latest?.gameplay?.health ?? null, food: latest?.gameplay?.hunger ?? null,
                    goal: latest?.tactical?.goal ?? null, inventory: latest?.inventory?.counts ?? {},
                    timeOfDay: latest?.gameplay?.timeOfDay ?? null,
                });
            }
            // Done when every goal the request produced is met; film a few seconds more, then stop.
            const goals = latest?.tactical?.goals ?? [];
            if (doneAt === null && requestedAt && !untilItem && !role && goals.length > 0 && goals.every((/** @type {any} */ g) => g.status === 'done')) doneAt = Date.now();
            if (doneAt === null && untilItem && (latest?.inventory?.counts?.[untilItem] ?? 0) >= Number(untilCount || 1)) doneAt = Date.now();
            if (doneAt !== null && Date.now() - doneAt > 8_000) break;
            await sleep(Math.max(0, 1000 / fps - (Date.now() - tick)));
        }
    } finally {
        rig.close();
        feed.close();
        await harness.stop();
    }

    const telemetry = readJsonl(join(botDir, 'decisions.jsonl'));
    const usage = readJsonl(join(botDir, 'llm_usage.jsonl'));
    writeFileSync(join(out, 'records.json'), JSON.stringify({ request, startedAt, requestedAt, doneAt, frames, telemetry, usage }));
    const sheets = await packSheets(framesDir, frames.length, out);
    const timeline = buildTimeline({ request, startedAt, requestedAt, telemetry });
    writeFileSync(join(out, 'index.html'), renderPage({
        request, startedAt, requestedAt, doneAt, fps, frames, sheets, timeline, usage, telemetry,
    }));
    rmSync(framesDir, { recursive: true, force: true }); // packed into the sheets
    console.log(`[demo] ${frames.length} frames, ${timeline.length} events, ${doneAt ? `done in ${Math.round((doneAt - requestedAt) / 1000)} s` : 'not finished'}`);
    console.log(`[demo] ${join(out, 'index.html')}`);
}

main().then(() => process.exit(0), error => {
    console.error('[demo] failed:', error);
    process.exit(1);
});
