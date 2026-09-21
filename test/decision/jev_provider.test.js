// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionProvider, createJevProvider, DecisionError, resilient, validateAnswers } from '../../src/decision/index.js';
import { toJevQuestion } from '../../src/decision/providers/jev.js';

/** @type {import('../../src/decision/types.js').Question[]} */
const questions = [
    { id: 'action', type: 'choice', prompt: 'Pick the next action.', options: ['craft', 'explore', 'wait'] },
    { id: 'danger', type: 'noul', prompt: 'Is the bot in immediate danger?' },
    { id: 'risk', type: 'score', prompt: 'How risky?', min: 0, max: 10 },
];

// Shapes copied from real responses of the Vercel AI Gateway's /v1/evaluate on 2026-09-21.
const realAnswer = {
    model: 'typesafe-ai/jev',
    answers: {
        action: { type: 'choice', choice: 'craft', probabilities: { wait: 0, explore: 0.09, craft: 0.91 }, confidence: 0.82 },
        danger: { type: 'boolean', probability: 0.15 },
        risk: { type: 'score', score: 0.21, probabilities: { 0: 0.79, 1: 0.21 }, confidence: 0.59 },
    },
    usage: { inputTokens: 397, outputTokens: 47 },
};

/**
 * @param {{status?: number, body?: any, headers?: Record<string, string>}} reply
 */
function fakeFetch(reply) {
    /** @type {{url: string, init: any}[]} */
    const calls = [];
    const fn = /** @type {any} */ ((/** @type {string} */ url, /** @type {any} */ init) => {
        calls.push({ url: String(url), init: { ...init, body: JSON.parse(String(init?.body)) } });
        const status = reply.status ?? 200;
        const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
        return Promise.resolve({
            ok: status >= 200 && status < 300, status,
            headers: new Headers(reply.headers ?? {}),
            json: () => Promise.resolve(JSON.parse(text)),
        });
    });
    return { fn, calls };
}

test('the request: evaluate endpoint, questions as a record keyed by id, the state as a string', async () => {
    const { fn, calls } = fakeFetch({ body: realAnswer });
    await createJevProvider({ fetch: fn, getKey: () => 'vck_test' }).decide({ state: { hp: 20 }, questions });
    const { url, init } = calls[0];
    assert.equal(url, 'https://ai-gateway.vercel.sh/v1/evaluate');
    assert.equal(init.headers.Authorization, 'Bearer vck_test');
    assert.equal(init.body.model, 'typesafe-ai/jev');
    assert.equal(init.body.state, '{"hp":20}');
    assert.deepEqual(Object.keys(init.body.questions), ['action', 'danger', 'risk']);
});

test('each question type in Jev\'s own vocabulary', () => {
    assert.deepEqual(toJevQuestion(questions[0]), {
        type: 'choice', instructions: 'Pick the next action.', criteria: { craft: 'craft', explore: 'explore', wait: 'wait' },
    });
    assert.deepEqual(toJevQuestion(questions[1]), { type: 'boolean', instructions: 'Is the bot in immediate danger?' });
    const score = /** @type {any} */ (toJevQuestion(questions[2]));
    assert.equal(score.type, 'score');
    assert.equal(score.criteria.length, 2); // Jev refuses a score with fewer than two anchors
});

test('real answers convert, keep the calibrated distribution, and pass the shared validation', async () => {
    const { fn } = fakeFetch({ body: realAnswer });
    const result = await createJevProvider({ fetch: fn, getKey: () => 'k' }).decide({ state: {}, questions });
    validateAnswers(questions, result.answers);
    assert.deepEqual(result.answers.action, { type: 'choice', value: 'craft', confidence: 0.82, distribution: { wait: 0, explore: 0.09, craft: 0.91 } });
    assert.deepEqual(result.answers.danger, { type: 'noul', value: false, probability: 0.15, confidence: 0.85 });
    assert.ok(Math.abs(/** @type {number} */ (result.answers.risk.value) - 2.1) < 1e-9); // 21% of the way from 0 to 10
    assert.deepEqual([result.inputTokens, result.outputTokens], [397, 47]);
});

test('an empty gateway account is a clear, non-retryable error', async () => {
    const { fn } = fakeFetch({ status: 403, body: { error: { message: 'AI Gateway requires a valid credit card on file', type: 'customer_verification_required' } } });
    await assert.rejects(
        createJevProvider({ fetch: fn, getKey: () => 'k' }).decide({ state: {}, questions }),
        error => error instanceof DecisionError && !error.retryable && /needs credit/.test(error.message),
    );
});

test('an upstream 400 from TypeSafe (a malformed question) is not retried; the provider\'s own verdict wins', async () => {
    const body = { error: { message: 'Noul question must have criteria or instructions: danger', type: 'AI_APICallError', param: { isRetryable: false, statusCode: 400 } } };
    const { fn } = fakeFetch({ status: 400, body });
    await assert.rejects(
        createJevProvider({ fetch: fn, getKey: () => 'k' }).decide({ state: {}, questions }),
        error => error instanceof DecisionError && !error.retryable && /Noul question/.test(error.message),
    );
    const flaky = fakeFetch({ status: 400, body: { error: { message: 'try later', param: { isRetryable: true } } } });
    await assert.rejects(
        createJevProvider({ fetch: flaky.fn, getKey: () => 'k' }).decide({ state: {}, questions }),
        error => error instanceof DecisionError && error.retryable,
    );
});

test('rate limits and server errors are retryable; a non-JSON body is transient', async () => {
    for (const status of [429, 500, 503]) {
        const { fn } = fakeFetch({ status, body: { error: { message: `status ${status}` } } });
        await assert.rejects(
            createJevProvider({ fetch: fn, getKey: () => 'k' }).decide({ state: {}, questions }),
            error => error instanceof DecisionError && error.retryable,
            String(status),
        );
    }
    const html = fakeFetch({ status: 502, body: '<html>Bad Gateway</html>' });
    await assert.rejects(
        createJevProvider({ fetch: html.fn, getKey: () => 'k' }).decide({ state: {}, questions }),
        error => error instanceof DecisionError && error.retryable && /not JSON/.test(error.message),
    );
});

test('TypeSafe shedding load is always retryable, whatever status it arrives with', async () => {
    // as seen live: the upstream message is itself JSON
    const message = '{"error_type":"system_overloaded","message":"We are currently experiencing high traffic and cannot process your request. Please try again later."}';
    const { fn } = fakeFetch({ status: 400, body: { error: { message, param: { isRetryable: false } } } });
    await assert.rejects(
        createJevProvider({ fetch: fn, getKey: () => 'k' }).decide({ state: {}, questions }),
        error => error instanceof DecisionError && error.retryable,
    );
});

test('a missing or partial answer is an error, not a silent gap', async () => {
    const partial = fakeFetch({ body: { answers: { action: realAnswer.answers.action } } });
    await assert.rejects(createJevProvider({ fetch: partial.fn, getKey: () => 'k' }).decide({ state: {}, questions }), /did not answer "danger"/);
});

test('registered as "jev", and it sits in a fallback chain like any provider', async () => {
    const down = fakeFetch({ status: 503, body: { error: { message: 'down' } } });
    const chain = resilient([createDecisionProvider({ provider: 'jev', fetch: down.fn, getKey: () => 'k' }), createDecisionProvider('rules')],
        { retries: 0 });
    const result = await chain.decide({ state: { plan_action: 'craft' }, questions: [questions[0]] });
    assert.equal(result.provider, 'rules');
});
