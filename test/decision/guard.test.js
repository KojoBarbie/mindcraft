// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard } from '../../src/decision/index.js';

const HOUR = 3600_000;

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
    let now = start;
    return { now: () => now, advance: (/** @type {number} */ ms) => { now += ms; } };
}

/** @param {Partial<import('../../src/decision/guard.js').ProgressFacts>} [over] */
const facts = over => ({ inventory: { oak_log: 3 }, pos: { x: 0, y: 64, z: 0 }, hp: 20, food: 20, goal: 'have wooden_pickaxe', ...over });

test('nothing changing: go, then shake, then give up; any progress resets the count', () => {
    const t = clock();
    const guard = new LoopGuard({ stallAfter: 3, failAfter: 5, now: t.now });
    const steps = [];
    for (let i = 0; i < 6; i++) {
        steps.push(guard.check(facts()).action);
        guard.recordDecision(`!explore(${i})`);
    }
    assert.deepEqual(steps, ['go', 'go', 'go', 'shake', 'shake', 'shake']);
    assert.equal(guard.shouldGiveUp(), true);

    // one more log is progress: back to square one
    assert.equal(guard.check(facts({ inventory: { oak_log: 4 } })).action, 'go');
    assert.equal(guard.shouldGiveUp(), false);
});

test('jitter is not progress, real travel is', () => {
    const guard = new LoopGuard({ stallAfter: 2 });
    guard.check(facts());
    guard.recordDecision('!a');
    guard.check(facts({ pos: { x: 2.4, y: 64.6, z: -1.8 } })); // shoved about by a mob
    guard.recordDecision('!b');
    assert.equal(guard.check(facts({ pos: { x: 1, y: 64, z: 1 } })).action, 'shake');
    assert.equal(guard.check(facts({ pos: { x: 40, y: 64, z: 0 } })).action, 'go'); // walked somewhere
});

test('a new goal is progress by definition', () => {
    const guard = new LoopGuard({ stallAfter: 1 });
    guard.check(facts());
    guard.recordDecision('!a');
    assert.equal(guard.check(facts()).action, 'shake');
    assert.equal(guard.check(facts({ goal: 'have furnace' })).action, 'go');
});

test('the same command three times within the window is banned, then released', () => {
    const t = clock();
    const guard = new LoopGuard({ repeatLimit: 3, repeatWindowMs: 60_000, banForMs: 120_000, now: t.now });
    assert.deepEqual(guard.recordDecision('!collectBlocks("oak_log", 3)'), { repeats: 1 });
    guard.recordDecision('!collectBlocks("oak_log", 3)');
    assert.deepEqual(guard.recordDecision('!collectBlocks("oak_log", 3)'), { banned: '!collectBlocks("oak_log", 3)', repeats: 3 });
    assert.deepEqual(guard.check(facts()).banned, ['!collectBlocks("oak_log", 3)']);
    // a different command is not affected
    assert.deepEqual(guard.recordDecision('!craftRecipe("stick", 1)'), { repeats: 1 });

    t.advance(119_000);
    assert.deepEqual(guard.check(facts()).banned, ['!collectBlocks("oak_log", 3)']);
    t.advance(2_000);
    assert.deepEqual(guard.check(facts()).banned, []);
});

test('repeats spread out beyond the window do not add up', () => {
    const t = clock();
    const guard = new LoopGuard({ repeatLimit: 3, repeatWindowMs: 60_000, now: t.now });
    for (let i = 0; i < 5; i++) {
        const result = guard.recordDecision('!craftRecipe("torch", 1)');
        assert.equal(result.banned, undefined, `attempt ${i}`);
        t.advance(31_000);
    }
});

test('budgets: pause when an hourly cap is reached, with how long to wait, and resume when it frees up', () => {
    const t = clock();
    const guard = new LoopGuard({ maxDecisionsPerHour: 3, now: t.now });
    for (let i = 0; i < 3; i++) {
        assert.equal(guard.overBudget(), null);
        guard.recordSpend({ decisions: 1 });
        t.advance(10 * 60_000);
    }
    const paused = guard.overBudget();
    assert.equal(paused?.action, 'pause');
    assert.match(String(paused?.reason), /decisions budget for the hour/);
    assert.equal(paused?.retryAfterMs, 30 * 60_000); // the first decision leaves the window in 30 min
    assert.equal(guard.check(facts()).action, 'pause');

    t.advance(30 * 60_000 + 1);
    assert.equal(guard.overBudget(), null);
});

test('budgets: tokens and an estimated price, by hour and by day', () => {
    const t = clock();
    // Jev: $0.042 per million input tokens; a day's cap of a tenth of a cent is ~24k tokens
    const guard = new LoopGuard({ inputUsdPerMillion: 0.042, maxUsdPerDay: 0.001, maxTokensPerHour: 50_000, now: t.now });
    guard.recordSpend({ inputTokens: 20_000 });
    assert.equal(guard.overBudget(), null);
    guard.recordSpend({ inputTokens: 5_000 });
    assert.match(String(guard.overBudget()?.reason), /usd budget for the day/);
    assert.ok(Math.abs(guard.usage().usd.day - 0.00105) < 1e-9);

    t.advance(25 * HOUR);
    assert.equal(guard.overBudget(), null);
    guard.recordSpend({ inputTokens: 60_000, usd: 0 }); // an explicit usd wins over the estimate
    assert.match(String(guard.overBudget()?.reason), /tokens budget for the hour/);
});

test('no caps means no limit', () => {
    const guard = new LoopGuard();
    for (let i = 0; i < 10_000; i++) guard.recordSpend({ decisions: 3, inputTokens: 400 });
    assert.equal(guard.overBudget(), null);
});

test('spend alone (the interrupt question) does not count as a decision taken', () => {
    const guard = new LoopGuard({ stallAfter: 2 });
    guard.check(facts());
    for (let i = 0; i < 10; i++) guard.recordSpend({ decisions: 1 });
    assert.equal(guard.check(facts()).action, 'go');
    assert.equal(guard.usage().decisions.hour, 10);
});

test('reset clears the stall count and bans, but not what was spent', () => {
    const guard = new LoopGuard({ stallAfter: 1, repeatLimit: 1 });
    guard.check(facts());
    guard.recordDecision('!x', { inputTokens: 100 });
    assert.equal(guard.check(facts()).action, 'shake');
    assert.deepEqual(guard.bannedNow(), ['!x']);
    guard.reset();
    assert.equal(guard.check(facts()).action, 'go');
    assert.deepEqual(guard.bannedNow(), []);
    assert.equal(guard.usage().tokens.hour, 100);
});
