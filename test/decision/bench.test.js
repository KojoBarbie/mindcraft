// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIGS, formatTable, summarizeTrial } from '../../scripts/lib/bench.js';

const [a, b] = CONFIGS;
const scenario = { id: 'wooden_pickaxe', goal: { type: 'have_tool', tool: 'pickaxe', tier: 'wooden' } };

test('a decision-layer trial: decisions exclude stop-checks and failures, cost adds the strategist\'s chat calls', () => {
    const row = summarizeTrial({
        scenario, config: b, startedAt: 1000, endedAt: 100_000, succeededAt: 61_000, deaths: 0,
        telemetry: [
            { t: 2000, kind: 'call', purpose: 'decide', latencyMs: 400, usd: 0.00002 },
            { t: 3000, kind: 'call', purpose: 'decide', latencyMs: 600, usd: 0.00002 },
            { t: 4000, kind: 'call', purpose: 'interrupt', latencyMs: 300, usd: 0.00001 },
            { t: 5000, kind: 'call', purpose: 'decide', latencyMs: 3000, error: 'timeout' },
            { t: 6000, kind: 'event', type: 'restored after crash' },
            { t: 200_000, kind: 'call', purpose: 'decide', latencyMs: 1, usd: 1 }, // after the trial: not counted
        ],
        usage: [{ t: 7000, model: 'gpt-5-mini', inputTokens: 1000, outputTokens: 1000, latencyMs: 9000 }],
    });
    assert.equal(row.success, true);
    assert.equal(row.seconds, 60);
    assert.equal(row.decisions, 2);
    assert.equal(row.stopChecks, 1);
    assert.deepEqual(row.latencyMs, { p50: 400, p95: 600 });
    assert.ok(Math.abs(row.usd - (0.00005 + (1000 * 0.25 + 1000 * 2) / 1e6)) < 1e-12);
    assert.equal(row.crashes, 1);
});

test('an upstream trial is measured by its chat model calls; a survival scenario fails on any death', () => {
    const row = summarizeTrial({
        scenario: { id: 'survive_night', survive: true }, config: a, startedAt: 0, endedAt: 600_000, succeededAt: 590_000, deaths: 2,
        telemetry: [],
        usage: [{ t: 10, model: 'gpt-5-mini', inputTokens: 5000, outputTokens: 800, latencyMs: 7000 }, { t: 20, model: 'gpt-5-mini', inputTokens: 5000, outputTokens: 800, latencyMs: 9000 }],
    });
    assert.equal(row.success, false);
    assert.equal(row.decisions, 2);
    assert.equal(row.latencyMs.p50, 7000);
    assert.ok(row.usd > 0);
});

test('the table averages trials and counts successes', () => {
    const rows = [
        { scenario: 's', config: 'b', success: true, seconds: 60, decisions: 10, stopChecks: 0, chatCalls: 0, latencyMs: { p50: 400, p95: 800 }, usd: 0.001, crashes: 0, deaths: 0 },
        { scenario: 's', config: 'b', success: false, seconds: null, decisions: 20, stopChecks: 0, chatCalls: 0, latencyMs: { p50: 500, p95: 900 }, usd: 0.003, crashes: 1, deaths: 1 },
    ];
    const table = formatTable(rows);
    assert.match(table, /\| s \| b \| 1\/2 \| 60 \| 15 \| 450 \/ 850 \| 0\.0020 \| 1 \| 1 \|/);
});
