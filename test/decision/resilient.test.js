// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resilient, DecisionError, AllProvidersFailedError } from '../../src/decision/index.js';

/** @typedef {import('../../src/decision/types.js').DecisionProvider} DecisionProvider */

/** @type {import('../../src/decision/types.js').Question[]} */
const questions = [{ id: 'go', type: 'noul', prompt: 'Go?' }];
const yes = { answers: { go: /** @type {const} */ ({ type: 'noul', value: true, probability: 0.9, confidence: 0.9 }) } };

/**
 * A provider that plays back a script: each entry is a response, an error to throw, or 'hang'.
 * @param {string} name
 * @param {(object | Error | 'hang' | 'deaf')[]} script
 */
function scripted(name, script) {
    const calls = { count: 0, aborted: 0 };
    /** @type {DecisionProvider} */
    const provider = {
        name,
        decide({ signal }) {
            const step = script[Math.min(calls.count++, script.length - 1)];
            if (step === 'deaf') return new Promise(() => {}); // ignores the signal entirely
            if (step === 'hang') {
                return new Promise((_, reject) => signal?.addEventListener('abort', () => {
                    calls.aborted++;
                    reject(new Error('aborted'));
                }));
            }
            if (step instanceof Error) return Promise.reject(step);
            return Promise.resolve(/** @type {any} */ (step));
        },
    };
    return { provider, calls };
}

/** Records requested delays instead of waiting. */
function fakeSleep() {
    /** @type {number[]} */
    const delays = [];
    return { delays, sleep: (/** @type {number} */ ms) => { delays.push(ms); return Promise.resolve(); } };
}

test('returns the answer with provenance on first success', async () => {
    const a = scripted('a', [{ ...yes, inputTokens: 321 }]);
    const result = await resilient([a.provider]).decide({ state: {}, questions });
    assert.equal(result.provider, 'a');
    assert.equal(result.attempts, 1);
    assert.equal(result.inputTokens, 321);
    assert.equal(result.answers.go.value, true);
});

test('retries retryable errors with exponential backoff and jitter', async () => {
    const busy = DecisionError.fromHttpStatus(429, 'rate limited');
    const a = scripted('a', [busy, busy, yes]);
    const { delays, sleep } = fakeSleep();
    const result = await resilient([a.provider], { retries: 2, backoffMs: 100, sleep, random: () => 0 })
        .decide({ state: {}, questions });
    assert.equal(result.attempts, 3);
    assert.deepEqual(delays, [50, 100]); // random()=0 gives the lower bound base/2 of 100 then 200
});

test('backoff is capped', async () => {
    const busy = DecisionError.fromHttpStatus(503, 'down');
    const a = scripted('a', [busy]);
    const { delays, sleep } = fakeSleep();
    await assert.rejects(resilient([a.provider], { retries: 4, backoffMs: 1000, maxBackoffMs: 2000, sleep, random: () => 0.999 })
        .decide({ state: {}, questions }));
    assert.equal(delays.length, 4);
    assert.ok(delays.every(d => d < 2000), String(delays));
});

test('does not retry non-retryable errors, falls through to the next provider', async () => {
    const a = scripted('a', [DecisionError.fromHttpStatus(401, 'bad key')]);
    const b = scripted('b', [yes]);
    const result = await resilient([a.provider, b.provider], { retries: 3, sleep: () => Promise.resolve() })
        .decide({ state: {}, questions });
    assert.equal(a.calls.count, 1);
    assert.equal(result.provider, 'b');
    assert.equal(result.attempts, 2);
});

test('an invalid answer moves on to the next provider without retrying', async () => {
    const a = scripted('a', [{ answers: { go: { type: 'choice', value: 'x', confidence: 1 } } }]);
    const b = scripted('b', [yes]);
    const result = await resilient([a.provider, b.provider], { sleep: () => Promise.resolve() }).decide({ state: {}, questions });
    assert.equal(a.calls.count, 1);
    assert.equal(result.provider, 'b');
});

test('unknown errors (e.g. network) are retried', async () => {
    const a = scripted('a', [new TypeError('fetch failed'), yes]);
    const result = await resilient([a.provider], { sleep: () => Promise.resolve() }).decide({ state: {}, questions });
    assert.equal(result.attempts, 2);
});

test('times out a hanging provider, aborts its request, and falls back', async () => {
    const a = scripted('a', ['hang']);
    const b = scripted('b', [yes]);
    const result = await resilient([a.provider, b.provider], { timeoutMs: 20, retries: 1, sleep: () => Promise.resolve() })
        .decide({ state: {}, questions });
    assert.equal(a.calls.count, 2);
    assert.equal(a.calls.aborted, 2);
    assert.equal(result.provider, 'b');
});

test('reports every provider when all fail', async () => {
    const a = scripted('a', [DecisionError.fromHttpStatus(401, 'bad key')]);
    const b = scripted('b', [DecisionError.fromHttpStatus(500, 'boom')]);
    await assert.rejects(
        resilient([a.provider, b.provider], { retries: 1, sleep: () => Promise.resolve() }).decide({ state: {}, questions }),
        error => {
            assert.ok(error instanceof AllProvidersFailedError);
            assert.deepEqual(error.errors.map(e => e.provider), ['a', 'b']);
            assert.match(error.message, /bad key.*boom/);
            return true;
        },
    );
    assert.equal(b.calls.count, 2);
});

test('malformed questions fail before any provider is called', async () => {
    const a = scripted('a', [yes]);
    await assert.rejects(resilient([a.provider]).decide({ state: {}, questions: [] }), DecisionError);
    assert.equal(a.calls.count, 0);
});

// The timeout tests use real timers on purpose: the scripted provider never settles unless it is aborted, so
// nothing races the timer and a slow machine only makes them slower, not flaky.
for (const kind of /** @type {const} */ (['hang', 'deaf'])) {
    test(`a timeout is reported the same way whether or not the provider honours the signal (${kind})`, async () => {
        const a = scripted('a', [kind]);
        await assert.rejects(
            resilient([a.provider], { timeoutMs: 20, retries: 0 }).decide({ state: {}, questions }),
            error => {
                assert.ok(error instanceof AllProvidersFailedError);
                const cause = error.errors[0].error;
                assert.ok(cause instanceof DecisionError);
                assert.match(cause.message, /a timed out after 20 ms/);
                assert.equal(error.retryable, true);
                return true;
            },
        );
    });
}

test('the caller can cancel: no retry, no fallback, request aborted', async () => {
    const a = scripted('a', ['hang']);
    const b = scripted('b', [yes]);
    const controller = new AbortController();
    const pending = resilient([a.provider, b.provider], { timeoutMs: 10_000 })
        .decide({ state: {}, questions, signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, error => error instanceof DecisionError && error.fatal && /cancelled/.test(error.message));
    assert.equal(a.calls.aborted, 1);
    assert.equal(b.calls.count, 0);
});

test('an already-cancelled request never reaches a provider', async () => {
    const a = scripted('a', [yes]);
    await assert.rejects(resilient([a.provider]).decide({ state: {}, questions, signal: AbortSignal.abort() }), /cancelled/);
    assert.equal(a.calls.count, 0);
});

test('the overall deadline stops retries and fallbacks', async () => {
    let clock = 0;
    const busy = DecisionError.fromHttpStatus(503, 'down');
    const a = scripted('a', [busy]);
    const b = scripted('b', [yes]);
    const chain = resilient([a.provider, b.provider], {
        deadlineMs: 1000, retries: 5, backoffMs: 400, random: () => 0.999,
        now: () => clock,
        sleep: ms => { clock += ms; return Promise.resolve(); },
    });
    const result = await chain.decide({ state: {}, questions });
    // a: attempt, wait ~400, attempt; the next wait (~800) would pass the deadline, so it moves on to b
    assert.equal(a.calls.count, 2);
    assert.equal(result.provider, 'b');

    clock = 0;
    const slow = scripted('slow', [busy]);
    const never = scripted('never', [yes]);
    const late = resilient([slow.provider, never.provider], {
        deadlineMs: 1000, retries: 0, now: () => { clock += 600; return clock; }, // every look at the clock costs 600 ms
    });
    await assert.rejects(late.decide({ state: {}, questions }), AllProvidersFailedError);
    assert.equal(never.calls.count, 0);
});

test('Retry-After is honoured when it is longer than the backoff', async () => {
    const limited = DecisionError.fromHttpStatus(429, 'slow down', { retryAfterMs: 900 });
    const a = scripted('a', [limited, yes]);
    const { delays, sleep } = fakeSleep();
    await resilient([a.provider], { backoffMs: 100, sleep, random: () => 0 }).decide({ state: {}, questions });
    assert.deepEqual(delays, [900]);
});

test('provider bugs are not retried; network-style errors are', async () => {
    const buggy = scripted('buggy', [new ReferenceError('x is not defined')]);
    const b = scripted('b', [yes]);
    const result = await resilient([buggy.provider, b.provider], { sleep: () => Promise.resolve() }).decide({ state: {}, questions });
    assert.equal(buggy.calls.count, 1);
    assert.equal(result.provider, 'b');
});

test('fatal errors are rethrown without trying the next provider', async () => {
    const a = scripted('a', [new DecisionError('policy bug', { fatal: true })]);
    const b = scripted('b', [yes]);
    await assert.rejects(resilient([a.provider, b.provider]).decide({ state: {}, questions }), /policy bug/);
    assert.equal(b.calls.count, 0);
});

test('results keep only the asked ids and normalise a missing confidence to null', async () => {
    const a = scripted('a', [{ answers: {
        go: { type: 'noul', value: true, probability: 0.7 },
        extra: { type: 'noul', value: false, probability: 0.1, confidence: 0.9 },
    } }]);
    const { answers } = await resilient([a.provider]).decide({ state: {}, questions });
    assert.deepEqual(Object.keys(answers), ['go']);
    assert.equal(answers.go.confidence, null);
});

test('the combined error tells a rate limit from a bad key', async () => {
    const a = scripted('a', [DecisionError.fromHttpStatus(401, 'bad key')]);
    const b = scripted('b', [DecisionError.fromHttpStatus(429, 'slow down', { retryAfterMs: 1500 })]);
    await assert.rejects(
        resilient([a.provider, b.provider], { retries: 0 }).decide({ state: {}, questions }),
        error => {
            assert.ok(error instanceof AllProvidersFailedError);
            assert.deepEqual(error.statuses, [401, 429]);
            assert.equal(error.retryable, true);
            assert.equal(error.retryAfterMs, 1500);
            return true;
        },
    );
    const onlyBadKey = scripted('a', [DecisionError.fromHttpStatus(401, 'bad key')]);
    await assert.rejects(
        resilient([onlyBadKey.provider]).decide({ state: {}, questions }),
        error => error instanceof AllProvidersFailedError && error.retryable === false,
    );
});

test('nonsense options are rejected up front', () => {
    const a = scripted('a', [yes]);
    assert.throws(() => resilient([a.provider], { retries: -1 }), /decision_options\.retries/);
    assert.throws(() => resilient([a.provider], { timeoutMs: /** @type {any} */ ('fast') }), /decision_options\.timeoutMs/);
    assert.throws(() => resilient([]), DecisionError);
});
