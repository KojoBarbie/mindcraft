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
            text: () => Promise.resolve(text),
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

test('rate limits and server errors are retryable, HTML error pages included', async () => {
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
        error => error instanceof DecisionError && error.retryable && error.status === 502,
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

test('an HTML error page is still judged by its status: a 401 is not retried, a 429 is', async () => {
    const auth = fakeFetch({ status: 401, body: '<html>Unauthorized</html>' });
    await assert.rejects(
        createJevProvider({ fetch: auth.fn, getKey: () => 'k' }).decide({ state: {}, questions }),
        error => error instanceof DecisionError && !error.retryable && error.status === 401,
    );
    const busy = fakeFetch({ status: 429, body: '<html>slow down</html>', headers: { 'retry-after': new Date(Date.now() + 30_000).toUTCString() } });
    await assert.rejects(
        createJevProvider({ fetch: busy.fn, getKey: () => 'k' }).decide({ state: {}, questions }),
        error => error instanceof DecisionError && error.retryable && error.status === 429 && (error.retryAfterMs ?? 0) > 20_000,
    );
});

test('hints become the criteria Jev reads; options without one keep their name', () => {
    const q = /** @type {any} */ (toJevQuestion({ id: 'a', type: 'choice', prompt: 'p', options: ['craft', 'wait'], hints: { craft: 'make an item' } }));
    assert.deepEqual(q.criteria, { craft: 'make an item', wait: 'wait' });
});

test('float noise in the probabilities is cleaned up, not a reason to throw the answer away', async () => {
    const noisy = { ...realAnswer.answers.action, probabilities: { craft: 1.0000001, explore: 0.02, wait: 0 }, confidence: 1.0000002 };
    const { fn } = fakeFetch({ body: { answers: { ...realAnswer.answers, action: noisy } } });
    const result = await createJevProvider({ fetch: fn, getKey: () => 'k' }).decide({ state: {}, questions });
    validateAnswers(questions, result.answers);
    assert.equal(result.answers.action.confidence, 1);
    const d = /** @type {Record<string, number>} */ (/** @type {any} */ (result.answers.action).distribution);
    assert.ok(Math.abs(Object.values(d).reduce((a, b) => a + b, 0) - 1) < 1e-9);

    const missing = { ...realAnswer.answers.action, probabilities: { explore: 1 } }; // says craft, gives no mass to it
    const other = fakeFetch({ body: { answers: { ...realAnswer.answers, action: missing } } });
    const kept = await createJevProvider({ fetch: other.fn, getKey: () => 'k' }).decide({ state: {}, questions });
    assert.equal(kept.answers.action.value, 'craft');
    assert.equal(/** @type {any} */ (kept.answers.action).distribution, undefined);

    const offList = fakeFetch({ body: { answers: { ...realAnswer.answers, action: { ...realAnswer.answers.action, choice: 'dance' } } } });
    await assert.rejects(createJevProvider({ fetch: offList.fn, getKey: () => 'k' }).decide({ state: {}, questions }), /not offered/);
});

test('a score is the expected value over the anchors, whatever the range', async () => {
    const q = /** @type {import('../../src/decision/types.js').Question} */ ({ id: 'risk', type: 'score', prompt: 'p', min: 5, max: 15 });
    const { fn } = fakeFetch({ body: { answers: { risk: { score: 0.25, probabilities: { 0: 0.75, 1: 0.25 }, confidence: 0.5 } } } });
    const result = await createJevProvider({ fetch: fn, getKey: () => 'k' }).decide({ state: {}, questions: [q] });
    assert.ok(Math.abs(/** @type {number} */ (result.answers.risk.value) - 7.5) < 1e-9);
    const bare = fakeFetch({ body: { answers: { risk: { score: 0.5 } } } });
    const fallback = await createJevProvider({ fetch: bare.fn, getKey: () => 'k' }).decide({ state: {}, questions: [q] });
    assert.equal(fallback.answers.risk.value, 10);
});

test('keys: AI_GATEWAY_API_KEY first, VERCEL_API_KEY after; never sent to another host unless named', async () => {
    const { fn, calls } = fakeFetch({ body: realAnswer });
    /** @type {string[]} */
    const asked = [];
    await createJevProvider({ fetch: fn, getKey: name => { asked.push(name); if (name === 'VERCEL_API_KEY') return 'v'; throw new Error('none'); } })
        .decide({ state: {}, questions });
    assert.deepEqual(asked, ['AI_GATEWAY_API_KEY', 'VERCEL_API_KEY']);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer v');

    const elsewhere = fakeFetch({ body: realAnswer });
    await assert.rejects(
        createJevProvider({ fetch: elsewhere.fn, baseURL: 'https://proxy.example/v1', getKey: () => 'secret' }).decide({ state: {}, questions }),
        error => error instanceof DecisionError && error.status === 401,
    );
    assert.equal(elsewhere.calls.length, 0);
    await createJevProvider({ fetch: elsewhere.fn, baseURL: 'https://proxy.example/v1', apiKeyName: 'PROXY_KEY', getKey: () => 'p' })
        .decide({ state: {}, questions });
    assert.equal(elsewhere.calls[0].url, 'https://proxy.example/v1/evaluate');

    const none = fakeFetch({ body: realAnswer });
    await assert.rejects(
        createJevProvider({ fetch: none.fn, getKey: () => { throw new Error('no key'); } }).decide({ state: {}, questions }),
        error => error instanceof DecisionError && !error.retryable && /No API key/.test(error.message),
    );
});

test('a 200 without answers is an error', async () => {
    const { fn } = fakeFetch({ body: { usage: {} } });
    await assert.rejects(createJevProvider({ fetch: fn, getKey: () => 'k' }).decide({ state: {}, questions }), /did not answer/);
});
