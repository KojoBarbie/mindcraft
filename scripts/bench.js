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
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mcdata from 'minecraft-data';
import { io } from 'socket.io-client';
import { startHarness } from './lib/harness.js';
import { rcon } from './lib/rcon.js';
import { CONFIGS, formatTable, scenarioMet, summarizeTrial } from './lib/bench.js';
import { createGameData } from '../src/decision/gamedata.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// The lab server's compose file and data may live in another checkout (a git worktree runs the same server).
const LAB_ROOT = process.env.MC_LAB_ROOT || ROOT;
if (!isAbsolute(LAB_ROOT)) throw new Error(`MC_LAB_ROOT must be an absolute path, not "${LAB_ROOT}"`);
const SERVICE = 'minecraft-lab';
const DATA = join(LAB_ROOT, 'server_data_lab');
const PRISTINE = join(LAB_ROOT, 'server_data_lab_pristine');
process.env.COMPOSE_PROJECT_NAME ??= 'mindcraft'; // one compose project whichever checkout this runs from
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
    execFileSync('docker', ['compose', '-f', join(LAB_ROOT, 'docker-compose.dev.yml'), '--profile', 'lab', ...extra],
        { stdio: 'ignore', env: { ...process.env, MC_EULA: 'true' } }); // the lab server was started with the EULA accepted
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
/** The world files are only touched once the server is known to be down: deleting a live world corrupts it. */
function stopServer() {
    compose('stop', SERVICE);
    const running = execFileSync('docker', ['compose', '-f', join(LAB_ROOT, 'docker-compose.dev.yml'), '--profile', 'lab', 'ps', '-q', '--status', 'running', SERVICE],
        { encoding: 'utf8', env: process.env }).trim();
    if (running) throw new Error(`the lab server is still running after stop (compose project ${process.env.COMPOSE_PROJECT_NAME}); not touching its world`);
    if (!existsSync(join(DATA, 'world'))) throw new Error(`no world at ${DATA}: is MC_LAB_ROOT the checkout the lab server runs from?`);
}

async function restoreWorld() {
    if (!existsSync(PRISTINE)) throw new Error(`no pristine world at ${PRISTINE}: run with --make-pristine first`);
    stopServer();
    for (const w of WORLDS) {
        rmSync(join(DATA, w), { recursive: true, force: true });
        cpSync(join(PRISTINE, w), join(DATA, w), { recursive: true });
    }
    compose('up', '-d', SERVICE);
    await waitForServer();
}

async function makePristine() {
    stopServer();
    for (const w of WORLDS) rmSync(join(DATA, w), { recursive: true, force: true });
    compose('up', '-d', SERVICE);
    await waitForServer();
    await rcon('save-all flush');
    stopServer();
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

/** Whatever a trial left running, so an interrupted benchmark does not leave a bot or MindServer behind. */
/** @type {Set<() => Promise<void>>} */
const cleanups = new Set();
process.once('SIGINT', async () => {
    for (const cleanup of cleanups) await cleanup().catch(() => {});
    process.exit(130);
});

let trialCounter = 0;

/** The server's own clock. @returns {Promise<number | null>} */
async function serverTimeOfDay() {
    const reply = await rcon('time query daytime').catch(() => '');
    const t = Number(/(\d+)/.exec(reply)?.[1]);
    return Number.isFinite(t) ? t : null;
}

/**
 * @param {any} scenario
 * @param {import('./lib/bench.js').Config} config
 * @param {number} trial
 */
async function runTrial(scenario, config, trial) {
    if (!args.includes('--no-restore')) await restoreWorld();
    // a new name every trial: a reused one would start with the last trial's inventory when the world is not restored
    const name = `b${config.id}_${++trialCounter}`;
    const botDir = join(ROOT, 'bots', name);
    rmSync(botDir, { recursive: true, force: true });
    mkdirSync(botDir, { recursive: true });
    process.env.MINDCRAFT_USAGE_LOG = join(botDir, 'llm_usage.jsonl');
    const telemetryPath = join(botDir, 'decisions.jsonl');
    const usagePath = join(botDir, 'llm_usage.jsonl');

    await rcon('difficulty easy');
    await rcon('weather clear');
    await rcon('gamerule doDaylightCycle true');
    await rcon(`time set ${scenario.time ?? 1000}`);
    await rcon('scoreboard objectives add deaths deathCount').catch(() => '');

    // The clock starts before the bot joins, the same for every configuration: (b) and (d) start acting as soon
    // as they spawn, (a) and (c) once the sentence arrives a moment later.
    const startedAt = Date.now();
    const port = 8110 + CONFIGS.indexOf(config);
    /** @type {number | null} */
    let succeededAt = null;
    /** @type {string | undefined} */
    let error;
    /** @type {Awaited<ReturnType<typeof startHarness>> | null} */
    let harness = null;
    /** @type {ReturnType<typeof io> | null} */
    let feed = null;
    const cleanup = async () => {
        feed?.close();
        await harness?.stop();
    };
    cleanups.add(cleanup);
    try {
        harness = await startHarness({ name, mindserverPort: port, verbose: args.includes('--verbose'), spawnTimeoutMs: 120_000, profile: config.profile(scenario) });
        await rcon(`clear ${name}`);
        feed = io(`http://localhost:${port}`);
        feed.on('connect', () => feed?.emit('listen-to-agents'));
        // judged on every state update (once a second), not on a slower poll
        feed.on('state-update', (/** @type {Record<string, any>} */ states) => {
            const state = states?.[name];
            if (succeededAt === null && state && !state.error && !scenario.survive
                && scenarioMet(scenario, { inventory: state.inventory?.counts ?? null, serverTimeOfDay: null }, data.isFood))
                succeededAt = Date.now();
        });

        // The sentence is posted, not sent: neither !goal nor the strategist answers the harness. Whether it was
        // taken up shows in the logs: the chat model's first call, or the strategist's consultation.
        if (config.task === 'self_prompt') harness.post(`!goal("${scenario.text}")`);
        if (config.task === 'chat') harness.post(scenario.text);
        if (config.task !== 'goal') {
            const taken = Date.now() + 90_000;
            const takenUp = () => (config.task === 'self_prompt'
                ? readJsonl(usagePath).length > 0
                : readJsonl(telemetryPath).some(r => r.kind === 'strategy'));
            while (!takenUp()) {
                if (Date.now() > taken) throw new Error('the task was not taken up within 90 s');
                await sleep(1_000);
            }
        }

        const deadline = startedAt + scenario.minutes * 60_000;
        while (succeededAt === null && Date.now() < deadline) {
            await sleep(2_000);
            if (scenario.survive && scenarioMet(scenario, { inventory: null, serverTimeOfDay: await serverTimeOfDay() }, data.isFood))
                succeededAt = Date.now();
        }
    } catch (e) {
        error = e instanceof Error ? e.message : String(e);
    } finally {
        await cleanup().catch(() => {});
        cleanups.delete(cleanup);
    }
    const endedAt = Date.now();
    const deathsText = await rcon(`scoreboard players get ${name} deaths`).catch(() => '');
    const deaths = Number(/has (\d+)/.exec(deathsText)?.[1] ?? 0);

    const row = summarizeTrial({
        scenario, config, startedAt, endedAt, succeededAt, deaths, error,
        telemetry: readJsonl(telemetryPath),
        usage: readJsonl(usagePath),
    });
    console.log(`[bench] ${JSON.stringify({ trial, ...row, latencies: undefined })}`);
    return row;
}

/**
 * One benchmark at a time on the lab server: two would restore the world under each other's bots (it happened,
 * and every trial of both runs was worthless). The lock holds the owner's pid; a lock whose owner is gone is
 * taken over.
 */
function takeLock() {
    const lock = join(LAB_ROOT, 'server_data_lab.bench.lock');
    if (existsSync(lock)) {
        const pid = Number(readFileSync(lock, 'utf8'));
        let alive = false;
        try { process.kill(pid, 0); alive = true; } catch { /* gone */ }
        if (alive && pid !== process.pid) throw new Error(`another benchmark (pid ${pid}) is using the lab server; stop it first`);
    }
    writeFileSync(lock, String(process.pid));
    process.once('exit', () => { try { if (Number(readFileSync(lock, 'utf8')) === process.pid) rmSync(lock); } catch { /* already gone */ } });
}

async function main() {
    takeLock();
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
                // runTrial reports its own failures as failed trials; only a broken world restore throws here
                rows.push(await runTrial(scenario, config, trial));
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
        'Time: median seconds to success over successful trials, from before the bot joins. Decisions: model calls',
        'that chose an action; for (a) every chat model call, code generation and memory included. Latency',
        'percentiles over all calls. $: decision layer, strategist and chat model at list prices (cached input at 10%).',
        '(b) and (d) are given a typed goal, (a) and (c) the same sentence: compare (a) with (c).',
        '',
    ].join('\n'));
    console.log(`[bench] report: docs/reports/bench-${stamp}.md`);
    console.log(formatTable(rows));
}

main().then(() => process.exit(0), error => {
    console.error('[bench] failed:', error);
    process.exit(1);
});
