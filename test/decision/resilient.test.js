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
 * @param {(object | Error | 'hang')[]} script
 */
function scripted(name, script) {
    const calls = { count: 0, aborted: 0 };
    /** @type {DecisionProvider} */
    const provider = {
        name,
        decide({ signal }) {
            const step = script[Math.min(calls.count++, script.length - 1)];
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
