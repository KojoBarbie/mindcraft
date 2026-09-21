// @ts-check
// A decision provider on top of any OpenAI-compatible chat completions endpoint (OpenAI itself, Ollama, Groq,
// vLLM, ...). A chat model has no native "pick one of these" call, so the questions become a strict JSON schema:
// the model can only return one of the offered options, and it reports its own confidence alongside.
//
// That confidence is the model's own estimate, not a calibrated probability like a decision model (Jev) gives.
// Treat low values as a hint, not a measurement.
import { DecisionError } from '../errors.js';

/** @typedef {import('../types.js').DecisionProvider} DecisionProvider */
/** @typedef {import('../types.js').Question} Question */
/** @typedef {import('../types.js').Answer} Answer */

/**
 * @typedef {object} OpenAIOptions
 * @property {string} [model] default gpt-5-nano
 * @property {string} [baseURL] default https://api.openai.com/v1; Ollama is http://localhost:11434/v1
 * @property {string} [apiKey] the key itself; otherwise looked up by `apiKeyName`
 * @property {string} [apiKeyName] default OPENAI_API_KEY; ignored when `apiKey` is given or for local servers
 * @property {'minimal' | 'low' | 'medium' | 'high' | null} [reasoningEffort] for reasoning models. Defaults to
 *   minimal for gpt-5 and o-series models: at the default effort gpt-5-nano spends ~1300 reasoning tokens and
 *   ~10 s on a two-word answer, which no real-time loop can wait for. null leaves it out (non-reasoning models)
 * @property {number} [maxCompletionTokens] includes reasoning tokens; too small and the answer comes back empty
 * @property {string} [name] provider name for logs, default "openai:<model>"
 * @property {typeof fetch} [fetch] injectable for tests
 * @property {(name: string) => string} [getKey] injectable for tests
 */

const SYSTEM = [
    'You make decisions for a Minecraft bot.',
    'You receive the bot\'s current state as JSON and a list of questions. Answer every question.',
    'For a choice, pick exactly one of the offered options.',
    'confidence is your probability, from 0 to 1, that your answer is the right one.',
    'For a yes/no question, probability is the probability, from 0 to 1, that the answer is yes.',
].join(' ');

/** @param {string} model */
const isReasoningModel = model => /^(gpt-5|o\d)/.test(model);
/** @param {number} n @param {number} lo @param {number} hi */
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * The strict schema for a set of questions: one object per question id.
 * @param {Question[]} questions
 */
export function schemaFor(questions) {
    /** @type {Record<string, object>} */
    const properties = {};
    for (const q of questions) {
        const field = q.type === 'choice'
            ? { choice: { type: 'string', enum: q.options }, confidence: { type: 'number' } }
            : q.type === 'score'
                ? { value: { type: 'number' }, confidence: { type: 'number' } }
                : { probability: { type: 'number' } };
        properties[q.id] = { type: 'object', additionalProperties: false, required: Object.keys(field), properties: field };
    }
    return { type: 'object', additionalProperties: false, required: questions.map(q => q.id), properties };
}

/** @param {Question[]} questions */
function describeQuestions(questions) {
    return questions.map(q => {
        if (q.type === 'choice') return `- ${q.id} (choose one of: ${q.options.join(', ')}): ${q.prompt}`;
        if (q.type === 'score') return `- ${q.id} (a number from ${q.min} to ${q.max}): ${q.prompt}`;
        return `- ${q.id} (yes/no): ${q.prompt}`;
    }).join('\n');
}

/**
 * Turn the model's raw JSON into answers, keeping every value inside what the question allows. Strict mode
 * guarantees the shape and the enum, not numeric ranges.
 * @param {Question[]} questions
 * @param {any} raw
 * @returns {Record<string, Answer>}
 */
export function toAnswers(questions, raw) {
    /** @type {Record<string, Answer>} */
    const answers = {};
    for (const q of questions) {
        const a = raw?.[q.id];
        if (!a || typeof a !== 'object') throw new DecisionError(`The model did not answer "${q.id}".`);
        const confidence = typeof a.confidence === 'number' && Number.isFinite(a.confidence) ? clamp(a.confidence, 0, 1) : null;
        if (q.type === 'choice') {
            answers[q.id] = { type: 'choice', value: a.choice, confidence };
        } else if (q.type === 'score') {
            if (typeof a.value !== 'number' || !Number.isFinite(a.value)) throw new DecisionError(`The model gave "${q.id}" no number.`);
            answers[q.id] = { type: 'score', value: clamp(a.value, q.min, q.max), confidence };
        } else {
            if (typeof a.probability !== 'number' || !Number.isFinite(a.probability)) throw new DecisionError(`The model gave "${q.id}" no probability.`);
            const probability = clamp(a.probability, 0, 1);
            answers[q.id] = { type: 'noul', value: probability >= 0.5, probability, confidence: Math.max(probability, 1 - probability) };
        }
    }
    return answers;
}

/** @param {string | null} header seconds or an HTTP date */
function retryAfterMs(header) {
    if (!header) return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const at = Date.parse(header);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * @param {OpenAIOptions} [options]
 * @returns {DecisionProvider}
 */
export function createOpenAIProvider(options = {}) {
    const model = options.model ?? 'gpt-5-nano';
    const baseURL = (options.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    const local = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(baseURL);
    const reasoningEffort = options.reasoningEffort === undefined ? (isReasoningModel(model) ? 'minimal' : null) : options.reasoningEffort;
    const maxCompletionTokens = options.maxCompletionTokens ?? 2000;
    const fetchFn = options.fetch ?? fetch;
    /** @type {string | undefined} */
    let apiKey = options.apiKey;

    return {
        name: options.name ?? `openai:${model}`,

        async decide({ state, questions, signal }) {
            if (!apiKey && !local) {
                const lookup = options.getKey ?? (await import('../../utils/keys.js')).getKey;
                try {
                    apiKey = lookup(options.apiKeyName ?? 'OPENAI_API_KEY');
                } catch (error) {
                    throw new DecisionError(`No API key: ${error instanceof Error ? error.message : String(error)}`, { status: 401 });
                }
            }
            /** @type {Record<string, unknown>} */
            const body = {
                model,
                messages: [
                    { role: 'system', content: SYSTEM },
                    { role: 'user', content: `STATE:\n${JSON.stringify(state)}\n\nQUESTIONS:\n${describeQuestions(questions)}` },
                ],
                response_format: { type: 'json_schema', json_schema: { name: 'decision', strict: true, schema: schemaFor(questions) } },
                max_completion_tokens: maxCompletionTokens,
            };
            if (reasoningEffort) body.reasoning_effort = reasoningEffort;

            const response = await fetchFn(`${baseURL}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
                body: JSON.stringify(body),
                signal,
            });
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                let message = text.slice(0, 300);
                try { message = JSON.parse(text)?.error?.message ?? message; } catch { /* not JSON */ }
                throw DecisionError.fromHttpStatus(response.status, `${model}: ${message}`, { retryAfterMs: retryAfterMs(response.headers.get('retry-after')) });
            }

            const data = await response.json();
            const choice = data?.choices?.[0];
            if (choice?.finish_reason === 'length')
                throw new DecisionError(`${model} ran out of tokens before answering (max_completion_tokens ${maxCompletionTokens}; reasoning counts too).`);
            if (choice?.message?.refusal) throw new DecisionError(`${model} refused: ${choice.message.refusal}`);
            /** @type {any} */
            let raw;
            try {
                raw = JSON.parse(choice?.message?.content ?? '');
            } catch {
                throw new DecisionError(`${model} did not return JSON.`);
            }
            return { answers: toAnswers(questions, raw), inputTokens: data?.usage?.prompt_tokens ?? null };
        },
    };
}
