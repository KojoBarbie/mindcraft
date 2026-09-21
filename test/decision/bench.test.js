// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mcdata from 'minecraft-data';
import { CONFIGS, formatTable, scenarioMet, summarizeTrial, usageUsd } from '../../scripts/lib/bench.js';
import { createGameData } from '../../src/decision/gamedata.js';

const data = createGameData(mcdata('1.21.6'));
const [a, b] = CONFIGS;
const scenario = { id: 'wooden_pickaxe', goal: { type: 'have_tool', tool: 'pickaxe', tier: 'wooden' } };
const night = { id: 'survive_night', survive: true };

test('success: an item goal by the inventory; a night by the server clock, never by a missing feed', () => {
    assert.equal(scenarioMet(scenario, { inventory: { stone_pickaxe: 1 }, serverTimeOfDay: null }, data.isFood), true);
    assert.equal(scenarioMet(scenario, { inventory: {}, serverTimeOfDay: null }, data.isFood), false);
    assert.equal(scenarioMet(scenario, { inventory: null, serverTimeOfDay: null }, data.isFood), false);
    assert.equal(scenarioMet(night, { inventory: null, serverTimeOfDay: 23_400 }, data.isFood), true);
    assert.equal(scenarioMet(night, { inventory: null, serverTimeOfDay: 0 }, data.isFood), false, 'a missing reading is not dawn');
    assert.equal(scenarioMet(night, { inventory: null, serverTimeOfDay: null }, data.isFood), false);
});

test('chat model cost: cached input at a tenth, unknown models flagged rather than free', () => {
    assert.ok(Math.abs(/** @type {number} */ (usageUsd({ model: 'gpt-5-mini', inputTokens: 1e6, cachedTokens: 0, outputTokens: 0 })) - 0.25) < 1e-12);
    assert.ok(Math.abs(/** @type {number} */ (usageUsd({ model: 'gpt-5-mini', inputTokens: 1e6, cachedTokens: 1e6, outputTokens: 0 })) - 0.025) < 1e-12);
    assert.equal(usageUsd({ model: 'some-new-model', inputTokens: 10 }), null);
});

test('a decision-layer trial: decisions exclude stop-checks and failures, cost adds the chat model calls', () => {
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
        usage: [
            { t: 7000, model: 'gpt-5-mini', inputTokens: 1000, cachedTokens: 0, outputTokens: 1000, latencyMs: 9000 },
            { t: 8000, model: 'mystery', inputTokens: 1000, outputTokens: 1000, latencyMs: 9000 },
        ],
    });
    assert.equal(row.success, true);
    assert.equal(row.seconds, 60);
    assert.equal(row.decisions, 2);
    assert.equal(row.stopChecks, 1);
    assert.deepEqual(row.latencyMs, { p50: 400, p95: 600 });
    assert.ok(Math.abs(row.usd - (0.00005 + (1000 * 0.25 + 1000 * 2) / 1e6)) < 1e-12);
    assert.equal(row.unpriced, 1);
    assert.equal(row.crashes, 1);
});

test('an upstream trial is measured by its chat model calls; a survival scenario fails on any death', () => {
    const row = summarizeTrial({
        scenario: night, config: a, startedAt: 0, endedAt: 600_000, succeededAt: 590_000, deaths: 2,
        telemetry: [],
        usage: [{ t: 10, model: 'gpt-5-mini', inputTokens: 5000, outputTokens: 800, latencyMs: 7000 }, { t: 20, model: 'gpt-5-mini', inputTokens: 5000, outputTokens: 800, latencyMs: 9000 }],
    });
    assert.equal(row.success, false);
    assert.equal(row.seconds, null);
    assert.equal(row.decisions, 2);
    assert.ok(row.usd > 0);
});

test('a trial that could not run is a failure in the table, not a gap', () => {
    const row = summarizeTrial({ scenario, config: b, startedAt: 0, endedAt: 1, succeededAt: null, deaths: 0, telemetry: [], usage: [], error: 'did not join' });
    assert.equal(row.success, false);
    assert.match(formatTable([row]), /0\/1 \(1 did not run\)/);
});

test('the table: median time over successes, latency pooled over every call', () => {
    const base = { stopChecks: 0, chatCalls: 0, crashes: 0, deaths: 0, unpriced: 0, error: null, latencyMs: { p50: null, p95: null } };
    const rows = [
        { ...base, scenario: 's', config: 'b', success: true, seconds: 60, decisions: 10, latencies: [100, 200, 300], usd: 0.001 },
        { ...base, scenario: 's', config: 'b', success: false, seconds: null, decisions: 20, latencies: [1000], usd: 0.003, crashes: 1, deaths: 1 },
    ];
    assert.match(formatTable(rows), /\| s \| b \| 1\/2 \| 60 \| 15 \| 200 \/ 1000 \| 0\.0020 \| 1 \| 1 \|/);
});
