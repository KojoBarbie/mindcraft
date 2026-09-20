// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createMockProvider, createDecisionProvider, createDecisionProviderFromProfile,
    registerDecisionProvider, validateAnswers, DecisionError,
} from '../../src/decision/index.js';

/** @type {import('../../src/decision/types.js').Question[]} */
const questions = [
    { id: 'skill', type: 'choice', prompt: 'What next?', options: ['mine', 'craft', 'eat', 'flee'] },
    { id: 'risk', type: 'score', prompt: 'How risky?', min: -5, max: 5 },
    { id: 'flee', type: 'noul', prompt: 'Flee now?' },
];

/** @param {import('../../src/decision/types.js').DecisionProvider} provider */
async function sequence(provider, n = 20) {
    const values = [];
    for (let i = 0; i < n; i++) values.push((await provider.decide({ state: {}, questions })).answers);
    return values;
}

test('mock answers are always valid', async () => {
    for (const answers of await sequence(createMockProvider({ seed: 3 })))
        validateAnswers(questions, answers);
});

test('same seed reproduces the same answers; a different seed does not', async () => {
    assert.deepEqual(await sequence(createMockProvider({ seed: 42 })), await sequence(createMockProvider({ seed: 42 })));
    assert.notDeepEqual(await sequence(createMockProvider({ seed: 42 })), await sequence(createMockProvider({ seed: 43 })));
});

test('random choices report uniform confidence', async () => {
    const { answers } = await createMockProvider().decide({ state: {}, questions });
    assert.equal(answers.skill.confidence, 0.25);
});

test('a policy turns the mock into a rule engine, falling back to random where it abstains', async () => {
    const provider = createMockProvider({
        policy: (state, q) => {
            const s = /** @type {{hp: number}} */ (state);
            if (q.id === 'skill') return s.hp < 6 ? 'flee' : 'mine';
            if (q.id === 'flee') return s.hp < 6 ? 0.95 : 0.05;
            return undefined;
        },
    });
    const hurt = (await provider.decide({ state: { hp: 3 }, questions })).answers;
    assert.equal(hurt.skill.value, 'flee');
    assert.equal(hurt.skill.confidence, 1);
    assert.equal(hurt.flee.value, true);
    validateAnswers(questions, hurt);
    const fine = (await provider.decide({ state: { hp: 20 }, questions })).answers;
    assert.equal(fine.skill.value, 'mine');
    assert.equal(fine.flee.value, false);
});

test('simulated latency is abortable', async () => {
    const controller = new AbortController();
    const pending = createMockProvider({ latencyMs: 10_000 }).decide({ state: {}, questions, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /aborted/);
});

test('registry builds providers from specs', () => {
    assert.equal(createDecisionProvider('mock').name, 'mock');
    assert.equal(createDecisionProvider({ provider: 'mock', seed: 7 }).name, 'mock');
    assert.throws(() => createDecisionProvider('nope'), DecisionError);
});

test('a profile without decision_model yields null; with one, a working chain in fallback order', async () => {
    assert.equal(createDecisionProviderFromProfile({}), null);

    const unregister = registerDecisionProvider('always_down', () => ({
        name: 'always_down',
        decide: () => Promise.reject(DecisionError.fromHttpStatus(401, 'no key')),
    }));
    try {
        const chain = createDecisionProviderFromProfile({
            decision_model: ['always_down', { provider: 'mock', seed: 1 }],
            decision_options: { retries: 0 },
        });
        assert.ok(chain);
        assert.equal(chain.name, 'always_down > mock');
        const result = await chain.decide({ state: {}, questions });
        assert.equal(result.provider, 'mock');
        assert.equal(result.attempts, 2);
    } finally {
        unregister();
    }
    assert.throws(() => createDecisionProvider('always_down'), /Unknown decision provider/);
});

test('registering a taken name throws, and prototype names are not providers', () => {
    assert.throws(() => registerDecisionProvider('mock', () => createMockProvider()), /already registered/);
    for (const name of ['constructor', 'toString', '__proto__'])
        assert.throws(() => createDecisionProvider(name), /Unknown decision provider/, name);
});

test('a policy that returns an unusable value fails loudly instead of being ignored', async () => {
    /** @type {[string, any][]} */
    const cases = [['skill', 'fly'], ['skill', 3], ['risk', 99], ['risk', 'high'], ['flee', 1.2], ['flee', 'yes']];
    for (const [id, value] of cases) {
        const provider = createMockProvider({ policy: (_state, q) => (q.id === id ? value : undefined) });
        await assert.rejects(
            provider.decide({ state: {}, questions }),
            error => error instanceof DecisionError && error.fatal === true,
            `${id}=${value}`,
        );
    }
});
