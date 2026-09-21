// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard, metered } from '../../src/decision/guard.js';
import { AllProvidersFailedError, DecisionError } from '../../src/decision/errors.js';

const HOUR = 3600_000;

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
    let now = start;
    return { now: () => now, advance: (/** @type {number} */ ms) => { now += ms; } };
}

/** @param {Partial<import('../../src/decision/guard.js').ProgressFacts>} [over] */
const facts = over => ({ inventory: { oak_log: 3 }, pos: { x: 0.5, y: 64, z: 0.5 }, goal: 'have wooden_pickaxe', ...over });

/**
 * Run `n` decisions that change nothing, returning the verdicts.
 * @param {LoopGuard} guard @param {number} n @param {() => ReturnType<typeof facts>} [at]
 */
function fruitless(guard, n, at = () => facts()) {
    const verdicts = [];
    for (let i = 0; i < n; i++) {
        verdicts.push(guard.check(at()).action);
        guard.recordDecision(`!explore(${i})`);
    }
    return verdicts;
}

test('nothing improving: a shake every `stallAfter` decisions, and a give-up at `failAfter`', () => {
    const guard = new LoopGuard({ stallAfter: 3, failAfter: 7 });
    assert.deepEqual(fruitless(guard, 7), ['go', 'go', 'go', 'shake', 'go', 'go', 'shake']);
    assert.equal(guard.shouldGiveUp(), true);
});

test('the inventory a goal starts with is the baseline, not progress', () => {
    const guard = new LoopGuard({ stallAfter: 3 });
    guard.check(facts({ inventory: { diamond: 64 } }));
    guard.recordDecision('!x');
    assert.equal(guard.usage().stillFor, 1);
});

test('a new best resets the count', () => {
    const guard = new LoopGuard({ stallAfter: 3, failAfter: 7 });
    fruitless(guard, 5);
    assert.equal(guard.check(facts({ inventory: { oak_log: 4 } })).action, 'go');
    assert.equal(guard.shouldGiveUp(), false);
    assert.equal(guard.usage().stillFor, 0);
});

test('wobbling across a cell border is not progress; nor is pacing between two spots', () => {
    const guard = new LoopGuard({ stallAfter: 2, failAfter: 8 });
    let flip = false;
    const wobble = () => { flip = !flip; return facts({ pos: { x: flip ? 7.9 : 8.1, y: 64, z: 0.5 } }); };
    fruitless(guard, 6, wobble); // two cells, visited over and over
    assert.equal(guard.usage().stillFor, 5); // only the first visit to the second cell counted
    const paced = new LoopGuard({ stallAfter: 2, failAfter: 8 });
    let side = 0;
    fruitless(paced, 10, () => facts({ pos: { x: (side++ % 2) * 30, y: 64, z: 0 } }));
    assert.ok(paced.shouldGiveUp());
});

test('real travel into new ground is progress', () => {
    const guard = new LoopGuard({ stallAfter: 2 });
    let x = 0;
    const verdicts = fruitless(guard, 6, () => facts({ pos: { x: (x += 40), y: 64, z: 0 } }));
    assert.ok(verdicts.every(v => v === 'go'));
});

test('using items up and regenerating health are not progress; only beating a best is', () => {
    const guard = new LoopGuard({ stallAfter: 2, failAfter: 4 });
    const counts = [9, 5, 9, 2]; // planks crafted into sticks and back: never above the best of 9
    fruitless(guard, 4, () => facts({ inventory: { oak_planks: counts.shift() ?? 2 } }));
    assert.ok(guard.shouldGiveUp());
});

test('a new goal starts from scratch', () => {
    const guard = new LoopGuard({ stallAfter: 1 });
    fruitless(guard, 3);
    assert.equal(guard.check(facts({ goal: 'have furnace' })).action, 'go');
    assert.equal(guard.usage().stillFor, 0);
});

test('fruitless repeats are banned, then released', () => {
    const t = clock();
    const guard = new LoopGuard({ repeatLimit: 3, repeatWindowMs: 60_000, banForMs: 120_000, now: t.now });
    guard.check(facts());
    const cmd = '!collectBlocks("oak_log", 3)';
    assert.deepEqual(guard.recordDecision(cmd), { repeats: 1 });
    guard.check(facts());
    guard.recordDecision(cmd);
    guard.check(facts());
    assert.deepEqual(guard.recordDecision(cmd), { banned: cmd, repeats: 3 });
    assert.deepEqual(guard.check(facts()).banned, [cmd]);
    t.advance(121_000);
    assert.deepEqual(guard.check(facts()).banned, []);
});

test('repeating a command that is paying off is never banned', () => {
    const guard = new LoopGuard({ repeatLimit: 3 });
    for (let logs = 1; logs <= 6; logs++) {
        guard.check(facts({ inventory: { oak_log: logs } })); // one more log each time
        assert.equal(guard.recordDecision('!collectBlocks("oak_log", 1)').banned, undefined, `after ${logs}`);
    }
});

test('waiting and self-defence are exempt: banning them mid-fight would leave the bot defenceless', () => {
    const guard = new LoopGuard({ repeatLimit: 2 });
    for (let i = 0; i < 5; i++) {
        guard.check(facts());
        for (const cmd of ['!stay(3)', '!attack("zombie")', '!moveAway(24)'])
            assert.equal(guard.recordDecision(cmd).banned, undefined, cmd);
    }
    assert.deepEqual(guard.bannedNow(), []);
});

test('repeats spread out beyond the window do not add up', () => {
    const t = clock();
    const guard = new LoopGuard({ repeatLimit: 3, repeatWindowMs: 60_000, now: t.now });
    for (let i = 0; i < 5; i++) {
        guard.check(facts());
        assert.equal(guard.recordDecision('!craftRecipe("torch", 1)').banned, undefined, `attempt ${i}`);
        t.advance(31_000);
    }
});

test('a round where everything was banned still counts as fruitless', () => {
    const guard = new LoopGuard({ stallAfter: 2, failAfter: 3 });
    guard.check(facts());
    for (let i = 0; i < 3; i++) guard.recordNoop();
    assert.ok(guard.shouldGiveUp());
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
    assert.equal(paused?.retryAfterMs, 30 * 60_000);
    assert.equal(guard.check(facts()).action, 'pause');
    t.advance(30 * 60_000 + 1);
    assert.equal(guard.overBudget(), null);
});

test('budgets: input and output are both priced; reasoning models are billed on output', () => {
    const t = clock();
    // gpt-5-nano: $0.05 in, $0.40 out per million
    const guard = new LoopGuard({ inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.4, maxUsdPerDay: 0.001, now: t.now });
    guard.recordSpend({ inputTokens: 300, outputTokens: 1300 }); // one decision at the API's default reasoning effort
    assert.ok(Math.abs(guard.usage().usd.day - 0.000535) < 1e-12);
    guard.recordSpend({ inputTokens: 300, outputTokens: 1300 });
    assert.match(String(guard.overBudget()?.reason), /usd budget for the day/);
    t.advance(25 * HOUR);
    assert.equal(guard.overBudget(), null);
});

test('a dollar cap with no price is refused rather than silently never tripping', () => {
    assert.throws(() => new LoopGuard({ maxUsdPerDay: 1 }), /need a price/);
    assert.doesNotThrow(() => new LoopGuard({ maxUsdPerDay: 1, inputUsdPerMillion: 0.042 }));
    assert.doesNotThrow(() => new LoopGuard({ maxDecisionsPerDay: 5000 }));
});

test('tokens: input and output both count against a token cap', () => {
    const guard = new LoopGuard({ maxTokensPerHour: 1000 });
    guard.recordSpend({ inputTokens: 400, outputTokens: 600 });
    assert.match(String(guard.overBudget()?.reason), /tokens budget/);
});

test('no caps means no limit', () => {
    const guard = new LoopGuard();
    for (let i = 0; i < 10_000; i++) guard.recordSpend({ decisions: 3, inputTokens: 400 });
    assert.equal(guard.overBudget(), null);
});

test('metered: every call is charged, successful or not, retries included', async () => {
    const guard = new LoopGuard();
    const ok = metered({ decide: (/** @type {unknown} */ _request) => Promise.resolve({ answers: {}, attempts: 3, inputTokens: 400, outputTokens: 20 }) }, guard);
    await ok.decide({});
    assert.deepEqual([guard.usage().decisions.hour, guard.usage().tokens.hour], [3, 420]);

    const gaveUp = metered({ decide: (/** @type {unknown} */ _request) => Promise.reject(new AllProvidersFailedError([{ provider: 'a', error: new Error('x') }], 4)) }, guard);
    await assert.rejects(gaveUp.decide({}));
    const threw = metered({ decide: (/** @type {unknown} */ _request) => Promise.reject(new DecisionError('boom')) }, guard);
    await assert.rejects(threw.decide({}));
    assert.equal(guard.usage().decisions.hour, 3 + 4 + 1);
});

test('reset clears the per-goal state but not what was spent', () => {
    const guard = new LoopGuard({ stallAfter: 1, repeatLimit: 1 });
    guard.check(facts());
    guard.recordDecision('!x');
    guard.recordSpend({ inputTokens: 100 });
    assert.deepEqual(guard.bannedNow(), ['!x']);
    guard.reset();
    assert.equal(guard.check(facts()).action, 'go');
    assert.deepEqual(guard.bannedNow(), []);
    assert.equal(guard.usage().tokens.hour, 100);
});
