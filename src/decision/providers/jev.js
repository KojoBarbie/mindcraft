// @ts-check
// TypeSafe's Jev, a "System One" decision model: it takes a state and typed questions and answers each with a
// calibrated probability, without writing any text. Reached through the Vercel AI Gateway's evaluate endpoint,
// which is not chat-compatible, hence a provider of its own.
//
// Measured from Japan on 2026-09-21: the model itself answers in ~127 ms (p50), the round trip through the
// gateway (processed in Cleveland) takes ~560 ms p50 with occasional 1.5-2.5 s spikes. Every request carries
// ~300 input tokens of fixed overhead whatever the state, so questions are best asked together.
import { DecisionError } from '../errors.js';

/** @typedef {import('../types.js').DecisionProvider} DecisionProvider */
/** @typedef {import('../types.js').Question} Question */
/** @typedef {import('../types.js').Answer} Answer */

/**
 * @typedef {object} JevOptions
 * @property {string} [model] default typesafe-ai/jev
 * @property {string} [baseURL] default https://ai-gateway.vercel.sh/v1
 * @property {string} [apiKey] the key itself
 * @property {string} [apiKeyName] key in keys.json / the environment; default VERCEL_API_KEY (an AI Gateway key)
 * @property {string} [name]
 * @property {typeof fetch} [fetch] injectable for tests
 * @property {(name: string) => string} [getKey] injectable for tests
 */

/**
 * Jev's wire format for one question. Our "noul" is its "boolean". A score is anchored at two described ends and
 * comes back as a position between them, which toAnswers maps onto [min, max].
 * @param {Question} q
 */
export function toJevQuestion(q) {
    if (q.type === 'choice')
        return { type: 'choice', instructions: q.prompt, criteria: Object.fromEntries(q.options.map(option => [option, option])) };
    if (q.type === 'noul') return { type: 'boolean', instructions: q.prompt };
    return {
        type: 'score', instructions: q.prompt,
        criteria: [{ score: q.min, description: `the lowest: ${q.min}` }, { score: q.max, description: `the highest: ${q.max}` }],
    };
}

/**
 * @param {Question[]} questions
 * @param {any} raw the evaluate response's `answers`
 * @returns {Record<string, Answer>}
 */
export function toAnswers(questions, raw) {
    /** @type {Record<string, Answer>} */
    const answers = {};
    for (const q of questions) {
        const a = raw?.[q.id];
        if (!a || typeof a !== 'object') throw new DecisionError(`Jev did not answer "${q.id}".`);
        const confidence = typeof a.confidence === 'number' && Number.isFinite(a.confidence) ? a.confidence : null;
        if (q.type === 'choice') {
            /** @type {Record<string, number>} */
            const distribution = {};
            for (const [option, p] of Object.entries(a.probabilities ?? {}))
                if (q.options.includes(option) && typeof p === 'number' && Number.isFinite(p)) distribution[option] = p;
            answers[q.id] = { type: 'choice', value: a.choice, confidence, ...(Object.keys(distribution).length > 0 ? { distribution } : {}) };
        } else if (q.type === 'noul') {
            if (typeof a.probability !== 'number' || !Number.isFinite(a.probability)) throw new DecisionError(`Jev gave "${q.id}" no probability.`);
            const probability = Math.min(1, Math.max(0, a.probability));
            // Jev's yes/no answer is itself a calibrated probability, so how sure it is follows from it
            answers[q.id] = { type: 'noul', value: probability >= 0.5, probability, confidence: Math.max(probability, 1 - probability) };
        } else {
            if (typeof a.score !== 'number' || !Number.isFinite(a.score)) throw new DecisionError(`Jev gave "${q.id}" no score.`);
            // two anchors: 0 means the low end, 1 the high end
            const position = Math.min(1, Math.max(0, a.score));
            answers[q.id] = { type: 'score', value: q.min + position * (q.max - q.min), confidence };
        }
    }
    return answers;
}

/**
 * @param {JevOptions} [options]
 * @returns {DecisionProvider}
 */
export function createJevProvider(options = {}) {
    const model = options.model ?? 'typesafe-ai/jev';
    const baseURL = (options.baseURL ?? 'https://ai-gateway.vercel.sh/v1').replace(/\/+$/, '');
    const fetchFn = options.fetch ?? fetch;
    /** @type {string | undefined} */
    let apiKey = options.apiKey;

    return {
        name: options.name ?? 'jev',

        async decide({ state, questions, signal }) {
            if (!apiKey) {
                const lookup = options.getKey ?? (await import('../../utils/keys.js')).getKey;
                try {
                    apiKey = lookup(options.apiKeyName ?? 'VERCEL_API_KEY');
                } catch (error) {
                    throw new DecisionError(`No API key for Jev: ${error instanceof Error ? error.message : String(error)}`, { status: 401 });
                }
            }
            const response = await fetchFn(`${baseURL}/evaluate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({
                    model,
                    state: typeof state === 'string' ? state : JSON.stringify(state),
                    questions: Object.fromEntries(questions.map(q => [q.id, toJevQuestion(q)])),
                }),
                signal,
            });

            /** @type {any} */
            let data;
            try {
                data = await response.json();
            } catch {
                throw new DecisionError(`Jev: the response was not JSON (HTTP ${response.status}).`, { retryable: true });
            }
            if (!response.ok) {
                const error = data?.error ?? {};
                const message = String(error.message ?? `HTTP ${response.status}`);
                // A gateway account with no credit answers 403; waiting will not help.
                if (error.type === 'customer_verification_required' || response.status === 402)
                    throw new DecisionError(`Jev: the AI Gateway account needs credit (${message})`, { status: response.status });
                const failure = DecisionError.fromHttpStatus(response.status, `Jev: ${message}`, {
                    retryAfterMs: Number(response.headers.get('retry-after')) * 1000 || undefined,
                });
                // the upstream provider says whether trying again can help; believe it over the status code
                if (typeof error.param?.isRetryable === 'boolean') failure.retryable = error.param.isRetryable;
                // TypeSafe is in early access and sheds load ("system_overloaded"); that always passes
                if (/system_overloaded|high traffic/i.test(message)) failure.retryable = true;
                throw failure;
            }
            return {
                answers: toAnswers(questions, data?.answers),
                inputTokens: data?.usage?.inputTokens ?? null,
                outputTokens: data?.usage?.outputTokens ?? null,
            };
        },
    };
}
