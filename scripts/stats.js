// @ts-check
// npm run stats [-- files...]   (default: bots/*/decisions.jsonl)
// Latency, cost, stale and low-confidence rates from the decision telemetry (src/decision/telemetry.js).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatSummary, summarize } from './lib/stats.js';

const args = process.argv.slice(2);
const files = args.length > 0 ? args : (existsSync('bots') ? readdirSync('bots') : [])
    .map(bot => join('bots', bot, 'decisions.jsonl'))
    .filter(path => existsSync(path));
if (files.length === 0) {
    console.error('No decisions.jsonl found. Run a bot with a decision_model first, or pass files.');
    process.exit(1);
}

/** @type {any[]} */
const all = [];
for (const file of files) {
    const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; } // a line cut short by a crash
    });
    all.push(...records);
    console.log(`== ${file}\n${formatSummary(summarize(records))}\n`);
}
if (files.length > 1) console.log(`== all\n${formatSummary(summarize(all))}`);
