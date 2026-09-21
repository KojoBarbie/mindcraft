// @ts-check
// Compare configurations on fixed scenarios (#17). Runs on the lab server (docker-compose.dev.yml, profile "lab"),
// restoring its world before every trial so no trial inherits another's felled trees or holes.
//
//   MC_EULA=true docker compose -f docker-compose.dev.yml --profile lab up -d minecraft-lab
//   node scripts/bench.js --make-pristine            (once: save a freshly generated world to restore from)
//   node scripts/bench.js [--configs a,b,c,d] [--scenarios wooden_pickaxe,food] [--trials 1] > bench.log 2>&1
//
// Results go to docs/reports/bench-<time>.md and .json. Not for publication: TypeSafe's terms (MCA §2.3(f))
// restrict publishing benchmark results for Jev.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mcdata from 'minecraft-data';
import { io } from 'socket.io-client';
import { startHarness } from './lib/harness.js';
import { rcon } from './lib/rcon.js';
import { CONFIGS, formatTable, summarizeTrial } from './lib/bench.js';
import { createGameData } from '../src/decision/gamedata.js';
import { isDone } from '../src/decision/goals.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SERVICE = 'minecraft-lab';
const DATA = join(ROOT, 'server_data_lab');
const PRISTINE = join(ROOT, 'server_data_lab_pristine');
const WORLDS = ['world', 'world_nether', 'world_the_end'];
process.env.MC_DEV_SERVICE = SERVICE; // rcon() and the harness go to the lab server
process.env.MC_PORT = '55917';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));
const data = createGameData(mcdata('1.21.6'));

/** @param {string[]} extra */
function compose(...extra) {
    execFileSync('docker', ['compose', '-f', join(ROOT, 'docker-compose.dev.yml'), '--profile', 'lab', ...extra], { stdio: 'ignore' });
}

async function waitForServer() {
    const deadline = Date.now() + 180_000;
    for (;;) {
        try {
            if (/players online/.test(await rcon('list'))) return;
        } catch { /* not up yet */ }
        if (Date.now() > deadline) throw new Error('the lab server did not come up within 3 minutes');
        await sleep(3_000);
    }
}

/** Put the lab world back as it was when the pristine copy was made. */
async function restoreWorld() {
    if (!existsSync(PRISTINE)) throw new Error(`no pristine world at ${PRISTINE}: run with --make-pristine first`);
    compose('stop', SERVICE);
    for (const w of WORLDS) {
        rmSync(join(DATA, w), { recursive: true, force: true });
        cpSync(join(PRISTINE, w), join(DATA, w), { recursive: true });
    }
    compose('up', '-d', SERVICE);
    await waitForServer();
}

async function makePristine() {
    compose('stop', SERVICE);
    for (const w of WORLDS) rmSync(join(DATA, w), { recursive: true, force: true });
    compose('up', '-d', SERVICE);
    await waitForServer();
    await rcon('save-all flush');
    compose('stop', SERVICE);
    rmSync(PRISTINE, { recursive: true, force: true });
    for (const w of WORLDS) cpSync(join(DATA, w), join(PRISTINE, w), { recursive: true });
    compose('up', '-d', SERVICE);
    await waitForServer();
    console.log(`[bench] pristine world saved to ${PRISTINE}`);
}

/** @param {string} path */
const readJsonl = path => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
}) : []);

/**
 * @param {any} scenario
 * @param {import('./lib/bench.js').Config} config
 * @param {number} trial
 */
async function runTrial(scenario, config, trial) {
    if (!args.includes('--no-restore')) await restoreWorld();
    const name = `bench_${config.id}`;
    const botDir = join(ROOT, 'bots', name);
    rmSync(botDir, { recursive: true, force: true });
    mkdirSync(botDir, { recursive: true });
    process.env.MINDCRAFT_USAGE_LOG = join(botDir, 'llm_usage.jsonl');

    await rcon('difficulty easy');
    await rcon('weather clear');
    await rcon('gamerule doDaylightCycle true');
    await rcon(`time set ${scenario.time ?? 1000}`);
    await rcon('scoreboard objectives add deaths deathCount').catch(() => '');
    await rcon(`scoreboard players reset ${name} deaths`).catch(() => '');

    const port = 8110 + CONFIGS.indexOf(config);
    const harness = await startHarness({ name, mindserverPort: port, verbose: args.includes('--verbose'), spawnTimeoutMs: 120_000, profile: config.profile(scenario) });
    /** @type {any} */
    let latest = null;
    const feed = io(`http://localhost:${port}`);
    feed.on('connect', () => feed.emit('listen-to-agents'));
    feed.on('state-update', (/** @type {Record<string, any>} */ states) => { if (states?.[name] && !states[name].error) latest = states[name]; });

    const startedAt = Date.now();
    if (config.task === 'self_prompt') await harness.send(`!goal("${scenario.text}")`, { timeoutMs: 30_000 }).catch(() => '');
    if (config.task === 'chat') harness.post(scenario.text);

    /** @type {number | null} */
    let succeededAt = null;
    const deadline = startedAt + scenario.minutes * 60_000;
    while (Date.now() < deadline) {
        await sleep(5_000);
        const inventory = latest?.inventory?.counts ?? {};
        const met = isDone(scenario.goal, /** @type {any} */ ({ inventory, foodItems: Object.keys(inventory).filter(data.isFood) }), data.isFood);
        if (scenario.survive) {
            const tod = Number(latest?.gameplay?.timeOfDay ?? 0);
            if (tod >= 23_300 || (tod < 12_000 && Date.now() - startedAt > 60_000)) { succeededAt = Date.now(); break; }
        } else if (met) {
            succeededAt = Date.now();
            break;
        }
    }
    const endedAt = Date.now();
    const deathsText = await rcon(`scoreboard players get ${name} deaths`).catch(() => '');
    const deaths = Number(/has (\d+)/.exec(deathsText)?.[1] ?? 0);
    feed.close();
    await harness.stop();

    const row = summarizeTrial({
        scenario, config, startedAt, endedAt, succeededAt, deaths,
        telemetry: readJsonl(join(botDir, 'decisions.jsonl')),
        usage: readJsonl(join(botDir, 'llm_usage.jsonl')),
    });
    console.log(`[bench] ${JSON.stringify({ trial, ...row })}`);
    return row;
}

async function main() {
    if (args.includes('--make-pristine')) return makePristine();
    const { scenarios: all } = JSON.parse(readFileSync(join(ROOT, 'bench/scenarios.json'), 'utf8'));
    const pick = opt('scenarios', '');
    const scenarios = pick ? all.filter((/** @type {any} */ s) => pick.split(',').includes(s.id)) : all;
    const configs = CONFIGS.filter(c => opt('configs', 'a,b,c,d').split(',').includes(c.id));
    const trials = Number(opt('trials', '1'));
    const started = new Date();
    /** @type {ReturnType<typeof summarizeTrial>[]} */
    const rows = [];
    for (let trial = 1; trial <= trials; trial++)
        for (const scenario of scenarios)
            for (const config of configs) {
                try {
                    rows.push(await runTrial(scenario, config, trial));
                } catch (error) {
                    console.error(`[bench] ${scenario.id}/${config.id} trial ${trial} failed to run:`, error);
                }
            }

    const stamp = started.toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const out = join(ROOT, 'docs/reports');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `bench-${stamp}.json`), JSON.stringify(rows, null, 2));
    writeFileSync(join(out, `bench-${stamp}.md`), [
        `# Benchmark ${stamp}`,
        '',
        '**Internal only.** TypeSafe\'s terms (MCA §2.3(f)) restrict publishing benchmark results for Jev.',
        '',
        ...configs.map(c => `- **${c.id}**: ${c.label}`),
        '',
        formatTable(rows),
        '',
        'Time is to success (successful trials only). Decisions: model calls that chose an action (for a, every',
        'chat model call). $ includes the decision layer, the strategist and the chat model, at list prices.',
        '',
    ].join('\n'));
    console.log(`[bench] report: docs/reports/bench-${stamp}.md`);
    console.log(formatTable(rows));
}

main().then(() => process.exit(0), error => {
    console.error('[bench] failed:', error);
    process.exit(1);
});
