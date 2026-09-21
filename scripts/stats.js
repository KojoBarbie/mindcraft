// @ts-check
// npm run stats [-- files...]   (default: bots/*/decisions.jsonl and the rotated .jsonl.1)
// Latency, cost, stale and low-confidence rates from the decision telemetry (src/decision/telemetry.js).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatSummary, summarize } from './lib/stats.js';

const args = process.argv.slice(2);
/** One group per bot (its rotated file and the current one together), or one per file given. @type {[string, string[]][]} */
const groups = args.length > 0
    ? args.map(file => [file, [file]])
    : (existsSync('bots') ? readdirSync('bots') : [])
        .map(bot => /** @type {[string, string[]]} */ ([join('bots', bot), ['decisions.jsonl.1', 'decisions.jsonl'].map(f => join('bots', bot, f)).filter(f => existsSync(f))]))
        .filter(([, files]) => files.length > 0);
if (groups.length === 0) {
    console.error('No decisions.jsonl found. Run a bot with a decision_model first, or pass files.');
    process.exit(1);
}

/** @param {string} file */
const read = file => readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; } // a line cut short by a crash
});

/** @type {any[]} */
const all = [];
for (const [label, files] of groups) {
    const records = files.flatMap(read);
    all.push(...records);
    console.log(`== ${label}\n${formatSummary(summarize(records))}\n`);
}
if (groups.length > 1) console.log(`== all\n${formatSummary(summarize(all))}`);
