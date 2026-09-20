// @ts-check

/** @typedef {import('../types.js').DecisionProvider} DecisionProvider */
/** @typedef {import('../types.js').Question} Question */
/** @typedef {import('../types.js').Answer} Answer */

/**
 * Decides one question from the state. Return undefined to let the mock pick at random.
 * For a choice, return the option; for a score, the number; for a noul, the probability of yes.
 * @typedef {(state: unknown, question: Question) => string | number | undefined} MockPolicy
 */

/**
 * @typedef {object} MockOptions
 * @property {number} [seed] same seed, same sequence of answers
 * @property {MockPolicy} [policy] rule-based answers; lets the whole loop run with no model at all
 * @property {number} [latencyMs] simulated thinking time
 */

/**
 * Small seedable PRNG (mulberry32); Math.random cannot be seeded.
 * @param {number} seed
 * @returns {() => number} values in [0, 1)
 */
export function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * A provider with no model behind it, for tests and for developing without API keys. Without a policy it
 * answers uniformly at random and reports the matching (low) confidence; with a policy it is a rule engine.
 * @param {MockOptions} [options]
 * @returns {DecisionProvider}
 */
export function createMockProvider(options = {}) {
    const random = seededRandom(options.seed ?? 1);
    const latencyMs = options.latencyMs ?? 0;

    /**
     * @param {unknown} state
     * @param {Question} q
     * @returns {Answer}
     */
    function answer(state, q) {
        const ruled = options.policy?.(state, q);
        switch (q.type) {
            case 'choice': {
                if (typeof ruled === 'string')
                    return { type: 'choice', value: ruled, confidence: 1, distribution: { [ruled]: 1 } };
                const p = 1 / q.options.length;
                const value = q.options[Math.floor(random() * q.options.length)];
                return {
                    type: 'choice',
                    value,
                    confidence: p,
                    distribution: Object.fromEntries(q.options.map(o => [o, p])),
                };
            }
            case 'score': {
                if (typeof ruled === 'number') return { type: 'score', value: ruled, confidence: 1 };
                return { type: 'score', value: q.min + random() * (q.max - q.min), confidence: 0 };
            }
            case 'noul': {
                const probability = typeof ruled === 'number' ? ruled : random();
                return {
                    type: 'noul',
                    value: probability >= 0.5,
                    probability,
                    confidence: Math.max(probability, 1 - probability),
                };
            }
        }
    }

    return {
        name: 'mock',
        async decide({ state, questions, signal }) {
            if (latencyMs > 0) {
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, latencyMs);
                    signal?.addEventListener('abort', () => {
                        clearTimeout(timer);
                        reject(new Error('aborted'));
                    }, { once: true });
                });
            }
            return {
                answers: Object.fromEntries(questions.map(q => [q.id, answer(state, q)])),
                inputTokens: null,
            };
        },
    };
}
