// @ts-check
// TypeSafe's Jev, a "System One" decision model: it takes a state and typed questions and answers each with a
// calibrated probability, without writing any text. Reached through the Vercel AI Gateway's evaluate endpoint,
// which is not chat-compatible, hence a provider of its own.
//
// Measured from Japan on 2026-09-21: the model itself answers in ~130 ms, a whole decision through the gateway
// (processed in the US) takes ~410 ms p50 with occasional 2-4 s spikes. Every request carries
// ~300 input tokens of fixed overhead whatever the state, so questions are best asked together.
import { DecisionError, retryAfterMs } from '../errors.js';

/** @typedef {import('../types.js').DecisionProvider} DecisionProvider */
/** @typedef {import('../types.js').Question} Question */
/** @typedef {import('../types.js').Answer} Answer */

/**
 * @typedef {object} JevOptions
 * @property {string} [model] default typesafe-ai/jev
 * @property {string} [baseURL] default https://ai-gateway.vercel.sh/v1
 * @property {string} [apiKey] the key itself
 * @property {string} [apiKeyName] key in keys.json / the environment. Default: AI_GATEWAY_API_KEY, else
 *   VERCEL_API_KEY; either must be an AI Gateway key, not a Vercel REST API token. Without apiKeyName the key is
 *   only sent to the AI Gateway itself, never to a replaced baseURL.
 * @property {string} [name]
 * @property {typeof fetch} [fetch] injectable for tests
 * @property {(name: string) => string} [getKey] injectable for tests
 */

const GATEWAY = 'https://ai-gateway.vercel.sh/v1';

/**
 * Jev's wire format for one question. Our "noul" is its "boolean". A choice's criteria are where Jev reads what
 * each option means, so hints go there rather than into the instructions. A score is anchored at its two ends.
 * @param {Question} q
 */
export function toJevQuestion(q) {
    if (q.type === 'choice')
        return { type: 'choice', instructions: q.prompt, criteria: Object.fromEntries(q.options.map(option => [option, q.hints?.[option] || option])) };
    if (q.type === 'noul') return { type: 'boolean', instructions: q.prompt };
    return {
        type: 'score', instructions: q.prompt,
        criteria: [{ score: q.min, description: `${q.min}: as low as it can be` }, { score: q.max, description: `${q.max}: as high as it can be` }],
    };
}

/** @param {unknown} x */
const unit = x => (typeof x === 'number' && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : null);

/**
 * Jev's probabilities over the offered options, clamped and renormalised: float noise such as 1.0000001 or a sum
 * of 1.02 must not make the shared validation throw away an otherwise good answer. Null when nothing usable.
 * @param {string[]} options
 * @param {unknown} raw
 */
function distributionOver(options, raw) {
    /** @type {Record<string, number>} */
    const out = {};
    let sum = 0;
    for (const [option, p] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
        const v = unit(p);
        if (options.includes(option) && v !== null) {
            out[option] = v;
            sum += v;
        }
    }
    if (sum <= 0) return null;
    for (const option of Object.keys(out)) out[option] /= sum;
    return out;
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
        const confidence = unit(a.confidence);
        if (q.type === 'choice') {
            if (!q.options.includes(a.choice)) throw new DecisionError(`Jev chose "${a.choice}" for "${q.id}", which was not offered.`, { retryable: true });
            const distribution = distributionOver(q.options, a.probabilities);
            // a distribution that does not even include the choice is not one to hand on
            const usable = distribution && a.choice in distribution ? { distribution } : {};
            answers[q.id] = { type: 'choice', value: a.choice, confidence, ...usable };
        } else if (q.type === 'noul') {
            if (typeof a.probability !== 'number' || !Number.isFinite(a.probability)) throw new DecisionError(`Jev gave "${q.id}" no probability.`);
            const probability = Math.min(1, Math.max(0, a.probability));
            // Jev's yes/no answer is itself a calibrated probability, so how sure it is follows from it
            answers[q.id] = { type: 'noul', value: probability >= 0.5, probability, confidence: Math.max(probability, 1 - probability) };
        } else {
            // Jev answers with a probability for each anchor, keyed by the anchor's index; the expected value over
            // the anchors we sent is the answer. `score` is the same thing as a position (0 = first anchor), kept
            // as a fallback for a response without the distribution.
            const anchors = [q.min, q.max];
            const probs = anchors.map((_, i) => unit(a.probabilities?.[i]) ?? NaN);
            const total = probs[0] + probs[1];
            let value;
            if (total > 0) { // NaN if either is missing
                value = (probs[0] * anchors[0] + probs[1] * anchors[1]) / total;
            } else {
                const position = unit(a.score);
                if (position === null) throw new DecisionError(`Jev gave "${q.id}" no score.`);
                value = q.min + position * (q.max - q.min);
            }
            answers[q.id] = { type: 'score', value: Math.min(q.max, Math.max(q.min, value)), confidence };
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
    const baseURL = (options.baseURL ?? GATEWAY).replace(/\/+$/, '');
    const fetchFn = options.fetch ?? fetch;
    /** @type {string | undefined} */
    let apiKey = options.apiKey;

    return {
        name: options.name ?? 'jev',

        async decide({ state, questions, signal }) {
            if (!apiKey) {
                // a gateway key is not for anyone else: only an explicitly named key goes to a replaced baseURL
                if (!options.apiKeyName && new URL(baseURL).origin !== new URL(GATEWAY).origin)
                    throw new DecisionError(`Jev: no key for ${baseURL}; name one with apiKeyName.`, { status: 401 });
                const lookup = options.getKey ?? (await import('../../utils/keys.js')).getKey;
                /** @type {unknown} */
                let lastError;
                for (const name of options.apiKeyName ? [options.apiKeyName] : ['AI_GATEWAY_API_KEY', 'VERCEL_API_KEY']) {
                    try {
                        apiKey = lookup(name);
                        if (apiKey) break;
                    } catch (error) {
                        lastError = error;
                    }
                }
                if (!apiKey)
                    throw new DecisionError(`No API key for Jev: ${lastError instanceof Error ? lastError.message : String(lastError ?? 'empty')}`, { status: 401 });
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

            if (!response.ok) {
                // read as text first: a proxy's HTML error page must still be classified by its status
                const text = await response.text().catch(() => '');
                /** @type {any} */
                let error = {};
                try {
                    error = JSON.parse(text)?.error ?? {};
                } catch { /* not JSON */ }
                const message = String(error.message ?? (text.slice(0, 200) || `HTTP ${response.status}`));
                // A gateway account with no credit answers 403; waiting will not help.
                if (error.type === 'customer_verification_required' || response.status === 402)
                    throw new DecisionError(`Jev: the AI Gateway account needs credit (${message})`, { status: response.status });
                const failure = DecisionError.fromHttpStatus(response.status, `Jev: ${message}`, {
                    retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
                });
                // the upstream provider says whether trying again can help; believe it over the status code
                if (typeof error.param?.isRetryable === 'boolean') failure.retryable = error.param.isRetryable;
                // TypeSafe is in early access and sheds load ("system_overloaded"); that always passes
                if (/system_overloaded|high traffic/i.test(message)) failure.retryable = true;
                throw failure;
            }
            /** @type {any} */
            let data;
            try {
                data = await response.json();
            } catch {
                throw new DecisionError(`Jev: the response was not JSON (HTTP ${response.status}).`, { retryable: true });
            }
            return {
                answers: toAnswers(questions, data?.answers),
                inputTokens: data?.usage?.inputTokens ?? null,
                outputTokens: data?.usage?.outputTokens ?? null,
            };
        },
    };
}
