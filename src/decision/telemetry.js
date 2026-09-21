// @ts-check
// A record of every decision the loop makes and what came of it, one JSON object per line, for `npm run stats`
// (scripts/stats.js) and for comparing providers (#17). Two kinds of line:
//   {kind: 'call', ...}   one provider call: latency, tokens, estimated cost, the answers or the error
//   {kind: 'event', ...}  what the loop did: decision, stale, result, interrupt, gave up, restored after crash, ...
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * USD per million tokens, input and output, by provider name as the providers report it: "jev",
 * "openai:<model>", "ollama:<model>". Local providers are free. List prices as of 2026-09.
 * @type {Record<string, [number, number]>}
 */
export const DEFAULT_PRICES = {
    'jev': [0.042, 0],
    'openai:gpt-5-nano': [0.05, 0.40],
    'openai:gpt-5-mini': [0.25, 2.00],
    'openai:gpt-5': [1.25, 10.00],
    'anthropic:claude-haiku-4-5': [1.00, 5.00],
    'rules': [0, 0],
    'mock': [0, 0],
};

/**
 * @param {string} provider as reported, e.g. "openai:gpt-5-nano"
 * @returns {[number, number] | null} USD per million tokens in/out
 */
export function priceOf(provider) {
    return DEFAULT_PRICES[provider] ?? (provider.startsWith('ollama:') || provider.startsWith('mock') ? [0, 0] : null);
}

/**
 * @param {string} provider as reported, e.g. "openai:gpt-5-nano"
 * @param {{inputTokens?: number | null, outputTokens?: number | null}} usage
 * @param {{inputUsdPerMillion?: number, outputUsdPerMillion?: number}} [fallback] for a provider not in the
 *   table (the guard's price, when one is set)
 * @returns {number | null} null when the price is unknown
 */
export function estimateUsd(provider, usage, fallback = {}) {
    const known = priceOf(provider);
    const input = known?.[0] ?? fallback.inputUsdPerMillion;
    const output = known?.[1] ?? fallback.outputUsdPerMillion;
    if (input === undefined && output === undefined) return null;
    return ((usage.inputTokens ?? 0) * (input ?? 0) + (usage.outputTokens ?? 0) * (output ?? 0)) / 1e6;
}

/** Loop events worth keeping; the rest (wake, start, ...) are noise at this level. */
export const RECORDED_EVENTS = new Set([
    'start', 'stop', 'decision', 'stale', 'result', 'interrupt', 'banned pick', 'banned', 'shake', 'gave up', 'stuck', 'paused',
    'restored', 'restored after crash', 'retrying failed goals', 'death', 'command timeout', 'error', 'low confidence',
    'dusk', 'night', 'sheltered', 'dawn',
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
    let canRotate = true;
    return record => {
        try {
            if (size < 0) {
                mkdirSync(dirname(path), { recursive: true });
                try { size = statSync(path).size; } catch { size = 0; }
            }
            const line = JSON.stringify({ t: now(), ...record }) + '\n';
            const bytes = Buffer.byteLength(line);
            if (canRotate && size > 0 && size + bytes > maxBytes) {
                try {
                    renameSync(path, `${path}.1`);
                    size = 0;
                } catch (error) {
                    // cannot rotate (on Windows the file may be held open): keep appending rather than lose lines
                    options.onError?.(error);
                    canRotate = false; // do not retry the rename on every line
                }
            }
            appendFileSync(path, line);
            size += bytes;
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
