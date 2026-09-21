// @ts-check
// Pure parts of the benchmark (scripts/bench.js): the configurations compared, and how one trial's records
// become a row of the table. Kept apart so they can be tested without a server.
import { quantile } from './stats.js';

/** USD per million tokens in/out for the chat models the configurations use (list prices, 2026-09). */
export const CHAT_PRICES = /** @type {Record<string, [number, number]>} */ ({
    'gpt-5-mini': [0.25, 2.00],
    'gpt-5-nano': [0.05, 0.40],
    'gpt-5': [1.25, 10.00],
});

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
        id: 'a', label: 'upstream: chat model gpt-5-mini, self-prompting', task: 'self_prompt',
        profile: () => ({ model: 'gpt-5-mini' }),
    },
    {
        id: 'b', label: 'tactical loop + Jev', task: 'goal',
        profile: s => ({ decision_model: 'jev', goals: [s.goal] }),
    },
    {
        id: 'c', label: 'tactical loop + Jev + strategist gpt-5-mini', task: 'chat',
        profile: () => ({ decision_model: 'jev', goals: [], strategy_model: 'gpt-5-mini' }),
    },
    {
        id: 'd', label: 'tactical loop + gpt-5-nano', task: 'goal',
        profile: s => ({ decision_model: 'openai', goals: [s.goal] }),
    },
];

/**
 * One trial's numbers.
 * @param {{scenario: any, config: Config, startedAt: number, endedAt: number, succeededAt: number | null,
 *   deaths: number, telemetry: any[], usage: any[]}} run telemetry: decisions.jsonl lines; usage: the chat
 *   model's usage log (MINDCRAFT_USAGE_LOG)
 */
export function summarizeTrial(run) {
    const t = run.telemetry.filter(r => r.t >= run.startedAt && r.t <= run.endedAt);
    const calls = t.filter(r => r.kind === 'call');
    const deciding = calls.filter(c => !c.error && c.purpose !== 'interrupt');
    const usage = run.usage.filter(u => u.t >= run.startedAt && u.t <= run.endedAt);
    // The decision layer prices its own calls. Chat model calls (the upstream agent, the strategist) come from
    // the usage log, which also has the reasoning tokens the strategist's own estimate misses.
    const decisionUsd = calls.reduce((sum, c) => sum + (Number.isFinite(c.usd) ? c.usd : 0), 0);
    const chatUsd = usage.reduce((sum, u) => {
        const price = CHAT_PRICES[u.model] ?? [0, 0];
        return sum + ((u.inputTokens ?? 0) * price[0] + (u.outputTokens ?? 0) * price[1]) / 1e6;
    }, 0);
    const latencies = run.config.task === 'self_prompt'
        ? usage.map(u => u.latencyMs).filter(Number.isFinite)
        : deciding.map(c => c.latencyMs).filter(Number.isFinite);
    const success = run.scenario.survive ? run.deaths === 0 && run.succeededAt !== null : run.succeededAt !== null;
    return {
        scenario: run.scenario.id,
        config: run.config.id,
        success,
        seconds: run.succeededAt !== null ? Math.round((run.succeededAt - run.startedAt) / 1000) : null,
        decisions: run.config.task === 'self_prompt' ? usage.length : deciding.length,
        stopChecks: calls.filter(c => c.purpose === 'interrupt').length,
        chatCalls: usage.length,
        latencyMs: { p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95) },
        usd: decisionUsd + chatUsd,
        crashes: t.filter(r => r.type === 'restored after crash').length,
        deaths: run.deaths,
    };
}

/**
 * The comparison table, one row per scenario and configuration, averaged over trials.
 * @param {ReturnType<typeof summarizeTrial>[]} trials
 */
export function formatTable(trials) {
    const rows = ['| scenario | config | success | time (s) | decisions | p50 / p95 ms | $ / task | crashes | deaths |',
        '|---|---|---|---|---|---|---|---|---|'];
    const keys = [...new Set(trials.map(t => `${t.scenario}|${t.config}`))];
    const avg = (/** @type {number[]} */ xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    for (const key of keys) {
        const [scenario, config] = key.split('|');
        const ts = trials.filter(t => t.scenario === scenario && t.config === config);
        const ok = ts.filter(t => t.success);
        const secs = avg(ok.map(t => Number(t.seconds)).filter(Number.isFinite));
        const p50 = avg(ts.map(t => t.latencyMs.p50).filter(x => x !== null).map(Number));
        const p95 = avg(ts.map(t => t.latencyMs.p95).filter(x => x !== null).map(Number));
        rows.push([
            '', scenario, config, `${ok.length}/${ts.length}`, secs === null ? '-' : Math.round(secs),
            Math.round(avg(ts.map(t => t.decisions)) ?? 0),
            `${p50 === null ? '-' : Math.round(p50)} / ${p95 === null ? '-' : Math.round(p95)}`,
            (avg(ts.map(t => t.usd)) ?? 0).toFixed(4),
            ts.reduce((a, t) => a + t.crashes, 0), ts.reduce((a, t) => a + t.deaths, 0), '',
        ].join(' | ').trim());
    }
    return rows.join('\n');
}
