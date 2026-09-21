// @ts-check
// A record of every decision the loop makes and what came of it, one JSON object per line, for `npm run stats`
// (scripts/stats.js) and for comparing providers (#17). Two kinds of line:
//   {kind: 'call', ...}   one provider call: latency, tokens, estimated cost, the answers or the error
//   {kind: 'event', ...}  what the loop did: decision, stale, result, interrupt, gave up, restored after crash, ...
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * USD per million tokens, input and output, used when the guard has no price configured. Chat providers are
 * named after the provider, not the model, so "openai" is priced as its default model, gpt-5-nano.
 * @type {Record<string, [number, number]>}
 */
export const DEFAULT_PRICES = {
    jev: [0.042, 0],
    openai: [0.05, 0.40],
    ollama: [0, 0],
    rules: [0, 0],
    mock: [0, 0],
};

/**
 * @param {string} provider
 * @param {{inputTokens?: number | null, outputTokens?: number | null}} usage
 * @param {{inputUsdPerMillion?: number, outputUsdPerMillion?: number}} [price] overrides the defaults
 * @returns {number | null} null when the price is unknown
 */
export function estimateUsd(provider, usage, price = {}) {
    const defaults = DEFAULT_PRICES[provider];
    const input = price.inputUsdPerMillion ?? defaults?.[0];
    const output = price.outputUsdPerMillion ?? defaults?.[1];
    if (input === undefined && output === undefined) return null;
    return ((usage.inputTokens ?? 0) * (input ?? 0) + (usage.outputTokens ?? 0) * (output ?? 0)) / 1e6;
}

/** Loop events worth keeping; the rest (wake, start, ...) are noise at this level. */
export const RECORDED_EVENTS = new Set([
    'decision', 'stale', 'result', 'interrupt', 'banned pick', 'banned', 'shake', 'gave up', 'stuck', 'paused',
    'restored', 'restored after crash', 'retrying failed goals', 'death', 'command timeout', 'error', 'low confidence',
]);

/**
 * Append-only JSONL with a size cap: past `maxBytes` the file moves to `<path>.1` (replacing any older one)
 * and a new one starts. A write that fails is dropped: telemetry must never stop the bot.
 * @param {string} path
 * @param {{maxBytes?: number, now?: () => number, onError?: (error: unknown) => void}} [options]
 * @returns {(record: Record<string, unknown>) => void}
 */
export function createTelemetry(path, options = {}) {
    const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
    const now = options.now ?? Date.now;
    let size = -1;
    let failed = false;
    return record => {
        try {
            if (size < 0) {
                mkdirSync(dirname(path), { recursive: true });
                try { size = statSync(path).size; } catch { size = 0; }
            }
            const line = JSON.stringify({ t: now(), ...record }) + '\n';
            if (size > 0 && size + line.length > maxBytes) {
                renameSync(path, `${path}.1`);
                size = 0;
            }
            appendFileSync(path, line);
            size += Buffer.byteLength(line);
            failed = false;
        } catch (error) {
            if (!failed) options.onError?.(error); // once per run of failures, not once per line
            failed = true;
        }
    };
}

/**
 * The part of a call worth recording: question shapes, answers with confidence, no state (it is large and
 * already implied by the events).
 * @param {import('./types.js').Question[]} questions
 * @param {Record<string, import('./types.js').Answer>} [answers]
 */
export function describeCall(questions, answers) {
    return questions.map(q => ({
        id: q.id,
        type: q.type,
        ...(q.type === 'choice' ? { options: q.options.length } : {}),
        ...(answers?.[q.id] ? { value: answers[q.id].value, confidence: answers[q.id].confidence } : {}),
    }));
}
