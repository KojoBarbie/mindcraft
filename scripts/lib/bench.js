// @ts-check
// Pure parts of the benchmark (scripts/bench.js): the configurations compared, when a trial has succeeded, and
// how one trial's records become a row of the table. Kept apart so they can be tested without a server.
import { quantile } from './stats.js';
import { priceOf } from '../../src/decision/telemetry.js';
import { isDone } from '../../src/decision/goals.js';
import { NIGHT_END } from '../../src/decision/daylight.js';

/** Cached input is billed at a tenth of the input price for the gpt-5 family (list prices, 2026-09). */
const CACHED_INPUT_SHARE = 0.1;

/**
 * @typedef {object} Config
 * @property {string} id
 * @property {string} label
 * @property {(scenario: any) => Record<string, unknown>} profile
 * @property {'goal' | 'self_prompt' | 'chat'} task how the task is given: profile goals, !goal(...) to the chat
 *   model, or a player's chat line to the strategist
 */

/** @type {Config[]} */
export const CONFIGS = [
    {
        id: 'a', label: 'upstream: chat model gpt-5-mini, self-prompting on a sentence', task: 'self_prompt',
        profile: () => ({ model: 'gpt-5-mini' }),
    },
    {
        id: 'b', label: 'tactical loop + Jev, given a typed goal', task: 'goal',
        profile: s => ({ decision_model: 'jev', goals: [s.goal] }),
    },
    {
        id: 'c', label: 'tactical loop + Jev + strategist gpt-5-mini, given the same sentence as (a)', task: 'chat',
        profile: () => ({ decision_model: 'jev', goals: [], strategy_model: 'gpt-5-mini' }),
    },
    {
        id: 'd', label: 'tactical loop + gpt-5-nano, given a typed goal', task: 'goal',
        profile: s => ({ decision_model: 'openai', goals: [s.goal] }),
    },
];

/**
 * Has the scenario been met? Survival scenarios end at dawn, read from the server's own clock (not the bot's
 * state feed, which may never have arrived); the rest when the inventory satisfies the goal.
 * @param {any} scenario
 * @param {{inventory: Record<string, number> | null, serverTimeOfDay: number | null}} now
 * @param {(item: string) => boolean} isFood
 */
export function scenarioMet(scenario, now, isFood) {
    if (scenario.survive) return now.serverTimeOfDay !== null && now.serverTimeOfDay >= NIGHT_END;
    if (!now.inventory) return false;
    return isDone(scenario.goal, /** @type {any} */ ({ inventory: now.inventory }), isFood);
}

/**
 * USD for one line of the chat model usage log (MINDCRAFT_USAGE_LOG), or null when the model has no known price.
 * @param {{model: string, inputTokens?: number | null, cachedTokens?: number | null, outputTokens?: number | null}} u
 */
export function usageUsd(u) {
    const price = priceOf(`openai:${u.model}`);
    if (!price) return null;
    const cached = Math.min(u.cachedTokens ?? 0, u.inputTokens ?? 0);
    const fresh = (u.inputTokens ?? 0) - cached;
    return (fresh * price[0] + cached * price[0] * CACHED_INPUT_SHARE + (u.outputTokens ?? 0) * price[1]) / 1e6;
}

/**
 * One trial's numbers.
 * @param {{scenario: any, config: Config, startedAt: number, endedAt: number, succeededAt: number | null,
 *   deaths: number, telemetry: any[], usage: any[], error?: string}} run telemetry: decisions.jsonl lines; usage:
 *   the chat model's usage log; error: the trial could not be run (counted as a failure, not left out)
 */
export function summarizeTrial(run) {
    const t = run.telemetry.filter(r => r.t >= run.startedAt && r.t <= run.endedAt);
    const calls = t.filter(r => r.kind === 'call');
    const deciding = calls.filter(c => !c.error && c.purpose !== 'interrupt');
    const usage = run.usage.filter(u => u.t >= run.startedAt && u.t <= run.endedAt);
    // The decision layer prices its own calls. Chat model calls (the upstream agent, the strategist) come from
    // the usage log, which has the real token counts (reasoning and cached input included).
    const decisionUsd = calls.reduce((sum, c) => sum + (Number.isFinite(c.usd) ? c.usd : 0), 0);
    const chatPrices = usage.map(usageUsd);
    const chatUsd = chatPrices.reduce((/** @type {number} */ sum, usd) => sum + (usd ?? 0), 0);
    // For (a) every chat model call counts: Mindcraft also calls it for code generation and memory, which is
    // part of what it costs to get the task done, but makes its latency a mix of different kinds of call.
    const latencies = run.config.task === 'self_prompt'
        ? usage.map(u => u.latencyMs).filter(Number.isFinite)
        : deciding.map(c => c.latencyMs).filter(Number.isFinite);
    const success = !run.error && run.succeededAt !== null && (!run.scenario.survive || run.deaths === 0);
    return {
        scenario: run.scenario.id,
        config: run.config.id,
        success,
        seconds: success && run.succeededAt !== null ? Math.round((run.succeededAt - run.startedAt) / 1000) : null,
        decisions: run.config.task === 'self_prompt' ? usage.length : deciding.length,
        stopChecks: calls.filter(c => c.purpose === 'interrupt').length,
        chatCalls: usage.length,
        latencies,
        latencyMs: { p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95) },
        usd: decisionUsd + chatUsd,
        unpriced: chatPrices.filter(p => p === null).length,
        crashes: t.filter(r => r.type === 'restored after crash').length,
        deaths: run.deaths,
        error: run.error ?? null,
    };
}

/**
 * The comparison table, one row per scenario and configuration, over all trials. Time is the median over
 * successful trials and is shown next to the success count, so a fast but rare success does not read as fast;
 * latency percentiles are over every call of every trial, not an average of per-trial medians.
 * @param {ReturnType<typeof summarizeTrial>[]} trials
 */
export function formatTable(trials) {
    const rows = ['| scenario | config | success | median time (s) | decisions | p50 / p95 ms | $ / task | crashes | deaths |',
        '|---|---|---|---|---|---|---|---|---|'];
    const keys = [...new Set(trials.map(t => `${t.scenario}|${t.config}`))];
    const avg = (/** @type {number[]} */ xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    for (const key of keys) {
        const [scenario, config] = key.split('|');
        const ts = trials.filter(t => t.scenario === scenario && t.config === config);
        const ok = ts.filter(t => t.success);
        const secs = quantile(ok.map(t => Number(t.seconds)).filter(Number.isFinite), 0.5);
        const pooled = ts.flatMap(t => t.latencies ?? []);
        const p50 = quantile(pooled, 0.5);
        const p95 = quantile(pooled, 0.95);
        const unpriced = ts.reduce((a, t) => a + (t.unpriced ?? 0), 0);
        const failedToRun = ts.filter(t => t.error).length;
        rows.push([
            '', scenario, config, `${ok.length}/${ts.length}${failedToRun ? ` (${failedToRun} did not run)` : ''}`,
            secs === null ? '-' : Math.round(secs),
            Math.round(avg(ts.map(t => t.decisions)) ?? 0),
            `${p50 === null ? '-' : Math.round(p50)} / ${p95 === null ? '-' : Math.round(p95)}`,
            `${(avg(ts.map(t => t.usd)) ?? 0).toFixed(4)}${unpriced ? ` (+${unpriced} unpriced calls)` : ''}`,
            ts.reduce((a, t) => a + t.crashes, 0), ts.reduce((a, t) => a + t.deaths, 0), '',
        ].join(' | ').trim());
    }
    return rows.join('\n');
}
