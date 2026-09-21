// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionProvider, createOpenAIProvider, DecisionError, resilient, validateAnswers } from '../../src/decision/index.js';
import { lowestEffort, schemaFor, toAnswers } from '../../src/decision/providers/openai.js';

/** @type {import('../../src/decision/types.js').Question[]} */
const questions = [
    { id: 'action', type: 'choice', prompt: 'What next?', options: ['craft', 'explore', 'wait'] },
    { id: 'risk', type: 'score', prompt: 'How risky?', min: 0, max: 10 },
    { id: 'danger', type: 'noul', prompt: 'In danger?' },
];
const good = { action: { choice: 'craft', confidence: 0.9 }, risk: { value: 3, confidence: 0.6 }, danger: { probability: 0.1 } };

/**
 * A stand-in for fetch that records what was sent and replies as told.
 * @param {{status?: number, body?: any, headers?: Record<string, string>}} reply
 */
function fakeFetch(reply) {
    /** @type {{url: string, init: any}[]} */
    const calls = [];
    /** @type {typeof fetch} */
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

/** @param {any} content @param {Record<string, unknown>} [extra] */
const completion = (content, extra = {}) => ({
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 116 }, ...extra,
});

test('the request: strict schema with the options as an enum, minimal reasoning for gpt-5, key from the lookup', async () => {
    const { fn, calls } = fakeFetch({ body: completion(good) });
    const provider = createOpenAIProvider({ fetch: fn, getKey: () => 'sk-test' });
    await provider.decide({ state: { hp: 20 }, questions });
    const { url, init } = calls[0];
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer sk-test');
    assert.equal(init.body.model, 'gpt-5-nano');
    assert.equal(init.body.reasoning_effort, 'minimal');
    assert.equal(init.body.max_completion_tokens, 2000);
    assert.equal(init.body.response_format.json_schema.strict, true);
    assert.deepEqual(init.body.response_format.json_schema.schema.properties.action.properties.choice.enum, ['craft', 'explore', 'wait']);
    assert.match(init.body.messages[1].content, /"hp":20/);
    assert.match(init.body.messages[1].content, /action \(choose one of: craft, explore, wait\)/);
});

test('the answers are converted and pass the shared validation; self-reported confidence is off by default', async () => {
    const { fn, calls } = fakeFetch({ body: completion(good, { usage: { prompt_tokens: 116, completion_tokens: 17 } }) });
    const result = await createOpenAIProvider({ fetch: fn, getKey: () => 'k' }).decide({ state: {}, questions });
    validateAnswers(questions, result.answers);
    assert.deepEqual(result.answers.action, { type: 'choice', value: 'craft', confidence: null });
    assert.deepEqual(result.answers.danger, { type: 'noul', value: false, probability: 0.1, confidence: null });
    assert.deepEqual([result.inputTokens, result.outputTokens], [116, 17]);
    // and it is not asked for, which saves output tokens
    assert.deepEqual(calls[0].init.body.response_format.json_schema.schema.properties.action.required, ['choice']);
    assert.doesNotMatch(calls[0].init.body.messages[0].content, /confidence/);
});

test('self-reported confidence can be asked for explicitly', async () => {
    const { fn, calls } = fakeFetch({ body: completion(good) });
    const result = await createOpenAIProvider({ fetch: fn, getKey: () => 'k', selfReportedConfidence: true }).decide({ state: {}, questions });
    assert.equal(result.answers.action.confidence, 0.9);
    assert.deepEqual(calls[0].init.body.response_format.json_schema.schema.properties.action.required, ['choice', 'confidence']);
});

test('out-of-range numbers are pulled back into range rather than failing validation downstream', () => {
    const answers = toAnswers(questions, { action: { choice: 'wait', confidence: 1.7 }, risk: { value: 42, confidence: -1 }, danger: { probability: 1.3 } }, true);
    assert.equal(answers.action.confidence, 1);
    assert.equal(answers.risk.value, 10);
    assert.equal(answers.risk.confidence, 0);
    assert.deepEqual(answers.danger, { type: 'noul', value: true, probability: 1, confidence: 1 });
});

test('the schema has one required object per question', () => {
    const schema = /** @type {any} */ (schemaFor(questions));
    assert.deepEqual(schema.required, ['action', 'risk', 'danger']);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.danger.required, ['probability']);
});

test('the lowest reasoning effort each model accepts (measured against the API)', () => {
    assert.equal(lowestEffort('gpt-5-nano'), 'minimal');
    assert.equal(lowestEffort('gpt-5-mini-2025-08-07'), 'minimal');
    assert.equal(lowestEffort('gpt-5'), 'minimal');
    assert.equal(lowestEffort('openai/gpt-5-nano'), 'minimal'); // vendor prefix ignored
    assert.equal(lowestEffort('gpt-5.1'), 'none');              // rejects minimal
    assert.equal(lowestEffort('gpt-5.4-nano'), 'none');
    assert.equal(lowestEffort('gpt-5.6-luna'), 'none');
    assert.equal(lowestEffort('o4-mini'), 'low');               // rejects minimal and none
    assert.equal(lowestEffort('o3'), 'low');
    assert.equal(lowestEffort('gpt-5.2-chat-latest'), null);
    assert.equal(lowestEffort('gpt-4o-mini'), null);
    assert.equal(lowestEffort('llama3.2:3b'), null);
});

test('Ollama: localhost, no key, no reasoning_effort, the older max_tokens too, and a custom name is kept', async () => {
    const { fn, calls } = fakeFetch({ body: completion(good) });
    const provider = createDecisionProvider({ provider: 'ollama', fetch: fn });
    assert.equal(provider.name, 'ollama:llama3.2:3b');
    await provider.decide({ state: {}, questions });
    const { url, init } = calls[0];
    assert.equal(url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(init.body.model, 'llama3.2:3b');
    assert.equal(init.body.reasoning_effort, undefined);
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.body.max_tokens, 2000);
    assert.equal(createDecisionProvider({ provider: 'ollama', name: 'my-box', fetch: fn }).name, 'my-box');
});

test('the OpenAI key is never sent to another host unless that host names a key', async () => {
    /** @type {string[]} */
    const looked = [];
    const getKey = (/** @type {string} */ name) => { looked.push(name); return `key-for-${name}`; };
    for (const baseURL of ['https://api.groq.com/openai/v1', 'http://192.168.1.20:8000/v1', 'http://[::1]:11434/v1']) {
        const { fn, calls } = fakeFetch({ body: completion(good) });
        await createOpenAIProvider({ baseURL, fetch: fn, getKey }).decide({ state: {}, questions });
        assert.equal(calls[0].init.headers.Authorization, undefined, baseURL);
    }
    assert.deepEqual(looked, []);
    const { fn, calls } = fakeFetch({ body: completion(good) });
    await createOpenAIProvider({ baseURL: 'https://api.groq.com/openai/v1', apiKeyName: 'GROQCLOUD_API_KEY', fetch: fn, getKey }).decide({ state: {}, questions });
    assert.equal(calls[0].init.headers.Authorization, 'Bearer key-for-GROQCLOUD_API_KEY');
});

test('errors are classified so the resilient wrapper does the right thing', async () => {
    /** @param {number} status @param {Record<string, string>} [headers] */
    const failWith = async (status, headers) => {
        const { fn } = fakeFetch({ status, body: { error: { message: `nope ${status}` } }, headers });
        try {
            await createOpenAIProvider({ fetch: fn, getKey: () => 'k' }).decide({ state: {}, questions });
            assert.fail('should have thrown');
        } catch (error) {
            assert.ok(error instanceof DecisionError);
            return error;
        }
    };
    const limited = await failWith(429, { 'retry-after': '3' });
    assert.equal(limited.retryable, true);
    assert.equal(limited.retryAfterMs, 3000);
    assert.match(limited.message, /nope 429/);
    assert.equal((await failWith(500)).retryable, true);
    assert.equal((await failWith(401)).retryable, false);
});

test('an empty account is not retried: waiting will not refill it', async () => {
    const { fn } = fakeFetch({ status: 429, body: { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } } });
    await assert.rejects(
        createOpenAIProvider({ fetch: fn, getKey: () => 'k' }).decide({ state: {}, questions }),
        error => error instanceof DecisionError && !error.retryable && /out of credit/.test(error.message),
    );
});

test('a non-JSON body (an HTML error page from a proxy) is a transient error, not a provider bug', async () => {
    const { fn } = fakeFetch({ body: '<html>502 Bad Gateway</html>' });
    await assert.rejects(
        createOpenAIProvider({ fetch: fn, getKey: () => 'k' }).decide({ state: {}, questions }),
        error => error instanceof DecisionError && error.retryable && /not JSON/.test(error.message),
    );
});

test('no answer at all says why: content filter, no choices, a refusal', async () => {
    const filtered = fakeFetch({ body: { choices: [{ message: { content: null }, finish_reason: 'content_filter' }] } });
    await assert.rejects(createOpenAIProvider({ fetch: filtered.fn, getKey: () => 'k' }).decide({ state: {}, questions }), /no answer \(finish_reason: content_filter\)/);
    const none = fakeFetch({ body: { choices: [] } });
    await assert.rejects(createOpenAIProvider({ fetch: none.fn, getKey: () => 'k' }).decide({ state: {}, questions }), /no choices/);
    const refused = fakeFetch({ body: { choices: [{ message: { content: null, refusal: 'I cannot help with that' }, finish_reason: 'stop' }] } });
    await assert.rejects(createOpenAIProvider({ fetch: refused.fn, getKey: () => 'k' }).decide({ state: {}, questions }), /refused/);
});

test('a network failure (offline) reaches the resilient wrapper as a retryable error', async () => {
    const offline = /** @type {any} */ (() => Promise.reject(new TypeError('fetch failed')));
    let attempts = 0;
    const counting = /** @type {any} */ ((/** @type {any} */ ...args) => { attempts++; return offline(...args); });
    const chain = resilient([createOpenAIProvider({ fetch: counting, getKey: () => 'k' })], { retries: 2, sleep: () => Promise.resolve() });
    await assert.rejects(chain.decide({ state: {}, questions }));
    assert.equal(attempts, 3);
});

test('running out of tokens (reasoning counts too) and broken JSON are errors, not empty answers', async () => {
    const cut = fakeFetch({ body: { choices: [{ message: { content: '' }, finish_reason: 'length' }] } });
    await assert.rejects(createOpenAIProvider({ fetch: cut.fn, getKey: () => 'k' }).decide({ state: {}, questions }), /ran out of tokens/);
    const garbled = fakeFetch({ body: completion('{"action": ') });
    await assert.rejects(createOpenAIProvider({ fetch: garbled.fn, getKey: () => 'k' }).decide({ state: {}, questions }), /did not return JSON/);
    const partial = fakeFetch({ body: completion({ action: { choice: 'craft', confidence: 1 } }) });
    await assert.rejects(createOpenAIProvider({ fetch: partial.fn, getKey: () => 'k' }).decide({ state: {}, questions }), /did not answer "risk"/);
});

test('a missing key is a clear, non-retryable error', async () => {
    const { fn } = fakeFetch({ body: completion(good) });
    const provider = createOpenAIProvider({ fetch: fn, getKey: () => { throw new Error('API key "OPENAI_API_KEY" not found'); } });
    await assert.rejects(provider.decide({ state: {}, questions }), error => error instanceof DecisionError && !error.retryable && /No API key/.test(error.message));
});

test('it plugs into the resilient chain: a failing OpenAI call falls back to the next provider', async () => {
    const { fn } = fakeFetch({ status: 401, body: { error: { message: 'bad key' } } });
    const chain = resilient([createOpenAIProvider({ fetch: fn, getKey: () => 'k' }), createDecisionProvider('rules')]);
    const result = await chain.decide({ state: { plan_action: 'craft' }, questions: [questions[0]] });
    assert.equal(result.provider, 'rules');
    assert.equal(result.answers.action.value, 'craft');
});

test('the abort signal reaches fetch', async () => {
    const { fn, calls } = fakeFetch({ body: completion(good) });
    const controller = new AbortController();
    await createOpenAIProvider({ fetch: fn, getKey: () => 'k' }).decide({ state: {}, questions, signal: controller.signal });
    assert.equal(calls[0].init.signal, controller.signal);
});

test('option hints reach a chat model in the prompt', async () => {
    const { fn, calls } = fakeFetch({ body: completion({ action: 'craft' }) });
    await createOpenAIProvider({ fetch: fn, getKey: () => 'k' }).decide({
        state: {}, questions: [{ id: 'action', type: 'choice', prompt: 'What next?', options: ['craft', 'wait'], hints: { craft: 'make an item' } }],
    }).catch(() => {}); // only the request matters here
    assert.match(calls[0].init.body.messages[1].content, /choose one of: craft = make an item; wait\)/);
});
