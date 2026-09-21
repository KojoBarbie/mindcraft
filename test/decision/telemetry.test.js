// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mcdata from 'minecraft-data';
import { GoalQueue, LoopGuard, TacticalLoop, createGameData, createRulesProvider, createTelemetry, estimateUsd, resilient } from '../../src/decision/index.js';
import { formatSummary, quantile, summarize } from '../../scripts/lib/stats.js';

const dir = () => mkdtempSync(join(tmpdir(), 'telemetry-'));
const lines = (/** @type {string} */ path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

test('one JSON object per line, stamped', () => {
    const path = join(dir(), 'a', 'decisions.jsonl');
    const write = createTelemetry(path, { now: () => 42 });
    write({ kind: 'event', type: 'decision' });
    write({ kind: 'call', provider: 'jev' });
    assert.deepEqual(lines(path), [{ t: 42, kind: 'event', type: 'decision' }, { t: 42, kind: 'call', provider: 'jev' }]);
});

test('past the size cap the file moves aside and a new one starts', () => {
    const path = join(dir(), 'decisions.jsonl');
    const write = createTelemetry(path, { maxBytes: 200 });
    for (let i = 0; i < 10; i++) write({ kind: 'event', type: 'result', detail: { i, pad: 'x'.repeat(40) } });
    assert.ok(existsSync(`${path}.1`));
    assert.ok(readFileSync(path).length <= 200);
    assert.equal(lines(path).at(-1).detail.i, 9);
});

test('a write that fails is reported once and never thrown', () => {
    const d = dir();
    writeFileSync(join(d, 'file'), '');
    /** @type {unknown[]} */
    const errors = [];
    const write = createTelemetry(join(d, 'file', 'decisions.jsonl'), { onError: e => errors.push(e) });
    assert.doesNotThrow(() => { write({ kind: 'event' }); write({ kind: 'event' }); });
    assert.equal(errors.length, 1);
});

test('cost: the guard\'s price wins, else the provider\'s default, else unknown', () => {
    assert.equal(estimateUsd('jev', { inputTokens: 1_000_000, outputTokens: 50 }), 0.042);
    assert.ok(Math.abs(/** @type {number} */ (estimateUsd('openai', { inputTokens: 1e6, outputTokens: 1e6 })) - 0.45) < 1e-12);
    assert.equal(estimateUsd('openai', { inputTokens: 1e6 }, { inputUsdPerMillion: 1 }), 1);
    assert.equal(estimateUsd('rules', { inputTokens: 0 }), 0);
    assert.equal(estimateUsd('somebody', { inputTokens: 10 }), null);
});

test('the loop records every provider call and its notable events', async () => {
    const path = join(dir(), 'decisions.jsonl');
    const registry = mcdata('1.21.6');
    const { EventEmitter } = await import('node:events');
    const vec = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) => ({ x, y, z, distanceTo: () => 1 });
    const bot = Object.assign(new EventEmitter(), {
        entity: { position: vec(0.5, 64, 0.5), isInWater: false }, entities: {}, players: {}, health: 20, food: 20, oxygenLevel: 20,
        isRaining: false, time: { timeOfDay: 1000 }, game: { dimension: 'overworld' }, heldItem: null, registry,
        inventory: { items: () => [], slots: {} },
        findBlocks: () => [vec(2, 64, 0)], blockAt: () => ({ name: 'oak_log' }), recipesFor: () => [{}],
    });
    const agent = { name: 't', bot, actions: { currentActionLabel: '', executing: false, stop: () => Promise.resolve() }, isIdle: () => true };
    const goals = new GoalQueue();
    goals.add({ type: 'have_tool', tier: 'wooden', tool: 'pickaxe' });
    const loop = new TacticalLoop(agent, resilient([createRulesProvider()]), goals, createGameData(registry), {
        guard: new LoopGuard(), telemetry: createTelemetry(path), execute: () => Promise.resolve('ok'), minGapMs: 0,
    });
    await loop.decide();
    await new Promise(resolve => setImmediate(resolve));
    const records = lines(path);
    const call = records.find(r => r.kind === 'call');
    assert.equal(call.provider, 'rules');
    assert.equal(call.usd, 0);
    assert.equal(call.questions[0].id, 'action');
    assert.ok(call.questions[0].options > 1);
    assert.ok(records.some(r => r.kind === 'event' && r.type === 'decision' && r.detail.provider === 'rules'));
    assert.ok(records.some(r => r.kind === 'event' && r.type === 'result'));
    assert.ok(!records.some(r => r.type === 'wake'), 'noise stays out');
    assert.equal(loop.status().lastDecision?.provider, 'rules');
});

test('stats: quantiles, rates per hour, stale and low-confidence rates', () => {
    assert.equal(quantile([5, 1, 3, 2, 4], 0.5), 3);
    assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 0.95), 100);
    assert.equal(quantile([], 0.5), null);
    const H = 3_600_000;
    const records = [
        { t: 0, kind: 'call', provider: 'jev', latencyMs: 400, inputTokens: 500, outputTokens: 0, usd: 0.000021 },
        { t: H / 2, kind: 'call', provider: 'jev', latencyMs: 600, inputTokens: 500, outputTokens: 0, usd: 0.000021 },
        { t: H / 2, kind: 'call', provider: 'jev', latencyMs: 3000, error: 'timed out' },
        { t: 1, kind: 'event', type: 'decision', detail: { confidence: 0.9 } },
        { t: 2, kind: 'event', type: 'decision', detail: { confidence: 0.3 } },
        { t: 3, kind: 'event', type: 'stale' },
        { t: 4, kind: 'event', type: 'result', detail: { ok: true, progressed: true, inconclusive: false } },
        { t: 5, kind: 'event', type: 'result', detail: { ok: false, inconclusive: false } },
        { t: 6, kind: 'event', type: 'restored after crash' },
        { t: H, kind: 'event', type: 'gave up' },
    ];
    const s = summarize(records);
    assert.equal(s.hours, 1);
    assert.equal(s.calls, 3);
    assert.equal(s.failedCalls, 1);
    assert.deepEqual(s.latencyMs, { p50: 400, p95: 600 }); // failed calls do not count towards latency
    assert.equal(s.decisionsPerHour, 2);
    assert.equal(s.tokensPerHour, 1000);
    assert.ok(Math.abs(/** @type {number} */ (s.usdPerHour) - 0.000042) < 1e-12);
    assert.equal(s.staleRate, 1 / 3);
    assert.equal(s.lowConfidenceRate, 0.5);
    assert.deepEqual(s.results, { ok: 1, failed: 1, inconclusive: 0, progressed: 1 });
    assert.equal(s.crashes, 1);
    assert.equal(s.gaveUp, 1);
    assert.match(formatSummary(s), /p50 400 ms, p95 600 ms/);
});
