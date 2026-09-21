// @ts-check
// Long unattended run (#13): start one bot on the default curriculum and leave it alone, sampling what it has,
// what it spends and how much memory it takes, then write a report.
//
//   MC_EULA=true npm run dev:server        (once)
//   node scripts/soak.js --minutes 120 --model jev > soak.log 2>&1
//
// Options: --minutes N (120), --model SPEC (jev; also a JSON list such as '["jev","rules"]'), --name BOT (soak_bot),
// --port N (8097), --out DIR (docs/reports), --usd-per-day N (1), --difficulty D (easy), --keep (keep old state), --lab (use the lab server).
// The bot is watched through the MindServer's state feed and its own telemetry, never by sending it commands:
// a command would interrupt whatever it is doing and change what is being measured. It sets the server's
// difficulty for the whole run, so give it a server of its own (--lab or the main one with nothing else on it).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { startHarness } from './lib/harness.js';
import { rcon } from './lib/rcon.js';
import { formatSummary, summarize } from './lib/stats.js';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
if (args.includes('--lab')) { // the second dev server (docker-compose.dev.yml, profile "lab")
    process.env.MC_DEV_SERVICE = 'minecraft-lab';
    process.env.MC_PORT = '55917';
}
const minutes = Number(opt('minutes', '120'));
const modelArg = opt('model', 'jev');
const model = modelArg.startsWith('[') || modelArg.startsWith('{') ? JSON.parse(modelArg) : modelArg;
const name = opt('name', 'soak_bot');
const port = Number(opt('port', '8097'));
const outDir = opt('out', 'docs/reports');
const usdPerDay = Number(opt('usd-per-day', '1'));
const difficulty = opt('difficulty', 'easy');
const botDir = join('bots', name);

/** Technology stages, highest first: the best one the inventory shows. @type {[string, string[]][]} */
const STAGES = [
    ['diamond', ['diamond', 'diamond_pickaxe']],
    ['iron', ['iron_ingot', 'iron_pickaxe', 'iron_sword']],
    ['stone', ['stone_pickaxe', 'stone_axe', 'stone_sword', 'furnace']],
    ['wood', ['wooden_pickaxe', 'crafting_table']],
    ['logs', ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log']],
];
/** @param {Record<string, number>} counts */
const stageOf = counts => STAGES.find(([, items]) => items.some(item => (counts[item] ?? 0) > 0))?.[0] ?? 'nothing';

/** Resident memory in MB of a process and its children (the agent runs as the worker's child). @param {number} pid */
function rssMb(pid) {
    try {
        const kids = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean);
        /** @type {Record<string, number>} */
        const out = {};
        for (const [label, p] of [['worker', String(pid)], ...kids.map(k => ['agent', k])]) {
            const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', p], { encoding: 'utf8' }).trim());
            if (Number.isFinite(kb)) out[label] = (out[label] ?? 0) + kb / 1024;
        }
        return out;
    } catch {
        return {};
    }
}

/** @param {string} path */
const readJsonl = path => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
}) : []);

async function main() {
    if (!args.includes('--keep')) rmSync(botDir, { recursive: true, force: true });
    await rcon(`difficulty ${difficulty}`);
    const startedAt = Date.now();
    console.log(`[soak] ${name}: ${minutes} min, model ${JSON.stringify(model)}, difficulty ${difficulty}, budget $${usdPerDay}/day`);

    const harness = await startHarness({
        name, mindserverPort: port, verbose: true, spawnTimeoutMs: 120_000,
        profile: {
            decision_model: model,
            // the budget is in USD; prices come from telemetry.js's table for the provider actually answering
            guard: { maxUsdPerDay: usdPerDay, inputUsdPerMillion: 0.042, outputUsdPerMillion: 0 },
        },
    });

    // Stopped early (Ctrl+C, kill): take the MindServer and the bot down too, and still write the report.
    let stopping = false;
    const stopEarly = async () => {
        if (stopping) return;
        stopping = true;
        console.log('[soak] stopping early');
        feed.close();
        await harness.stop().catch(() => {});
        await rcon('difficulty easy').catch(() => {});
        writeReport({ startedAt, samples, bestStage, finalState: latest });
        process.exit(130);
    };
    process.once('SIGINT', stopEarly);
    process.once('SIGTERM', stopEarly);

    /** @type {any} */
    let latest = null;
    const feed = io(`http://localhost:${port}`);
    feed.on('connect', () => feed.emit('listen-to-agents'));
    feed.on('state-update', (/** @type {Record<string, any>} */ states) => {
        if (states?.[name] && !states[name].error) latest = states[name];
    });

    /** @type {any[]} */
    const samples = [];
    let bestStage = 'nothing';
    const stageOrder = ['nothing', ...STAGES.map(([s]) => s).reverse()];
    const deadline = startedAt + minutes * 60_000;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30_000));
        const counts = latest?.inventory?.counts ?? {};
        const stage = stageOf(counts);
        if (stageOrder.indexOf(stage) > stageOrder.indexOf(bestStage)) bestStage = stage;
        const sample = {
            min: Math.round((Date.now() - startedAt) / 60_000),
            health: latest?.gameplay?.health ?? null,
            food: latest?.gameplay?.hunger ?? null,
            pos: latest?.gameplay?.position ?? null,
            stage, goal: latest?.tactical?.goal ?? null,
            usdDay: latest?.tactical?.usage?.usd?.day ?? null,
            items: Object.values(counts).reduce((a, b) => a + Number(b), 0),
            rss: rssMb(/** @type {number} */ (harness.pid)),
        };
        samples.push(sample);
        console.log(`[soak] ${JSON.stringify(sample)}`);
    }

    feed.close();
    await harness.stop();
    await rcon('difficulty easy').catch(() => {});
    writeReport({ startedAt, samples, bestStage, finalState: latest });
}

/** @param {{startedAt: number, samples: any[], bestStage: string, finalState: any}} run */
function writeReport({ startedAt, samples, bestStage, finalState }) {
    const records = readJsonl(join(botDir, 'decisions.jsonl')).filter(r => r.t >= startedAt);
    const s = summarize(records);
    const events = records.filter(r => r.kind === 'event');
    const count = (/** @type {(e: any) => boolean} */ f) => events.filter(f).length;
    const exits = /** @type {Record<string, number>} */ ({});
    for (const e of events.filter(e => e.type === 'restored' || e.type === 'restored after crash')) {
        const reason = e.detail?.reason ?? e.detail?.exit ?? 'unknown';
        exits[reason] = (exits[reason] ?? 0) + 1;
    }
    const suspects = /** @type {Record<string, number>} */ ({});
    for (const e of events.filter(e => e.type === 'restored after crash' && e.detail?.bannedSuspect))
        suspects[e.detail.bannedSuspect] = (suspects[e.detail.bannedSuspect] ?? 0) + 1;
    const failures = /** @type {Record<string, number>} */ ({});
    for (const e of events.filter(e => e.type === 'result' && !e.detail?.ok && !e.detail?.inconclusive)) {
        const key = `${String(e.detail.command).replace(/\(.*$/, '')}: ${String(e.detail.output).slice(0, 80)}`;
        failures[key] = (failures[key] ?? 0) + 1;
    }
    const top = (/** @type {Record<string, number>} */ m, n = 8) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n);
    const agentMb = samples.map(x => x.rss.agent).filter(Number.isFinite);
    const workerMb = samples.map(x => x.rss.worker).filter(Number.isFinite);
    const mb = (/** @type {number[]} */ xs) => (xs.length ? `avg ${Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)} MB, max ${Math.round(Math.max(...xs))} MB, last ${Math.round(xs.at(-1) ?? 0)} MB` : '-');
    const monthly = s.usdPerHour === null ? '-' : `$${(s.usdPerHour * 24 * 30).toFixed(2)}`;
    const stamp = new Date(startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-');

    const lines = [
        `# Soak ${stamp}: ${JSON.stringify(model)}, ${minutes} min`,
        '',
        `- Best stage reached: **${bestStage}** (final goal: ${finalState?.tactical?.goal ?? '-'})`,
        `- Deaths ${s.deaths}, restarts ${Object.values(exits).reduce((a, n) => a + n, 0)} (${s.crashes} after a wedged action, by reason below), budget pauses ${count(e => e.type === 'paused')}, goals given up ${s.gaveUp}`,
        `- Cost ${s.usd === null ? '-' : `$${s.usd.toFixed(4)}`} (${s.usdPerHour === null ? '-' : `$${s.usdPerHour.toFixed(4)}/h`}), **${monthly} per bot per month** running 24/7`,
        `- Memory, agent process: ${mb(agentMb)}; MindServer worker: ${mb(workerMb)}`,
        '',
        '## Decisions',
        '```',
        formatSummary(s),
        '```',
        '',
        '## How it ended each time it restarted',
        ...top(exits).map(([r, n]) => `- ${n}× ${r}`),
        '',
        '## Commands blamed for crashes',
        ...top(suspects).map(([c, n]) => `- ${n}× \`${c}\``),
        '',
        '## Most frequent failures',
        ...top(failures, 12).map(([c, n]) => `- ${n}× ${c}`),
        '',
        '## Timeline (every 10 min)',
        '| min | stage | goal | health | food | items | $ today | agent MB |',
        '|---|---|---|---|---|---|---|---|',
        ...samples.filter((x, i) => i % 20 === 19 || i === samples.length - 1).map(x =>
            `| ${x.min} | ${x.stage} | ${x.goal ?? '-'} | ${x.health ?? '-'} | ${x.food ?? '-'} | ${x.items} | ${x.usdDay === null ? '-' : x.usdDay.toFixed(4)} | ${Math.round(x.rss.agent ?? 0)} |`),
        '',
    ];
    mkdirSync(outDir, { recursive: true });
    const path = join(outDir, `soak-${stamp}.md`);
    writeFileSync(path, lines.join('\n'));
    console.log(`[soak] report: ${path}`);
}

main().catch(error => {
    console.error('[soak] failed:', error);
    process.exit(1);
});
