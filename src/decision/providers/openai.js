// @ts-check
// A decision provider on top of any OpenAI-compatible chat completions endpoint (OpenAI itself, Ollama, Groq,
// vLLM, ...). A chat model has no native "pick one of these" call, so the questions become a strict JSON schema:
// the model can only return one of the offered options, and it reports its own confidence alongside.
//
// A chat model's stated confidence is its own estimate, not a calibrated probability like a decision model (Jev)
// gives: gpt-5-nano says ~0.65 about answers it gets right every time. Mixing the two in one threshold would make
// "ask a bigger model when unsure" fire on every nano decision, so it is left out unless asked for.
import { DecisionError, retryAfterMs } from '../errors.js';

/** @typedef {import('../types.js').DecisionProvider} DecisionProvider */
/** @typedef {import('../types.js').Question} Question */
/** @typedef {import('../types.js').Answer} Answer */

/**
 * @typedef {object} OpenAIOptions
 * @property {string} [model] default gpt-5-nano
 * @property {string} [baseURL] default https://api.openai.com/v1; Ollama is http://localhost:11434/v1
 * @property {string} [apiKey] the key itself
 * @property {string} [apiKeyName] which key in keys.json / the environment to send. Defaults to OPENAI_API_KEY for
 *   api.openai.com only: an OpenAI key is never sent to another host unless asked for (Groq: GROQCLOUD_API_KEY)
 * @property {'none' | 'minimal' | 'low' | 'medium' | 'high' | null} [reasoningEffort] null leaves it out. The
 *   default is the lowest each model accepts (see lowestEffort): at the API's default effort gpt-5-nano spends
 *   ~1300 reasoning tokens and ~10 s on a two-word answer, which no real-time loop can wait for
 * @property {number} [maxCompletionTokens] includes reasoning tokens; too small and the answer comes back empty
 * @property {boolean} [selfReportedConfidence] ask the model to state its confidence (extra output tokens, and
 *   not comparable with a decision model's calibrated confidence). Off: confidence is null
 * @property {string} [name] provider name for logs, default "openai:<model>"
 * @property {typeof fetch} [fetch] injectable for tests
 * @property {(name: string) => string} [getKey] injectable for tests
 */

/** @param {boolean} withConfidence */
const systemPrompt = withConfidence => [
    'You make decisions for a Minecraft bot.',
    'You receive the bot\'s current state as JSON and a list of questions. Answer every question.',
    'For a choice, pick exactly one of the offered options.',
    ...(withConfidence ? ['confidence is your probability, from 0 to 1, that your answer is the right one.'] : []),
    'For a yes/no question, probability is the probability, from 0 to 1, that the answer is yes.',
].join(' ');

/**
 * The lowest reasoning effort each model family accepts, measured against the API on 2026-09-21. Sending one a
 * model does not accept is a 400 on every call. Vendor prefixes (openai/gpt-5-nano) are ignored.
 * @param {string} model
 * @returns {'none' | 'minimal' | 'low' | null}
 */
export function lowestEffort(model) {
    const name = model.replace(/^[a-z-]+\//, '');
    if (/chat/.test(name)) return null;                 // chat variants take no reasoning setting
    if (/^gpt-5(-(mini|nano|pro|codex))?(-\d{4}|$)/.test(name)) return 'minimal'; // gpt-5 family: minimal/low/...
    if (/^gpt-5\.\d/.test(name)) return 'none';         // gpt-5.1 onwards: none/low/..., not minimal
    if (/^o\d/.test(name)) return 'low';                 // o-series: low/medium/high only
    return null;
}
/** @param {number} n @param {number} lo @param {number} hi */
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * The strict schema for a set of questions: one object per question id.
 * @param {Question[]} questions
 * @param {boolean} [withConfidence]
 */
export function schemaFor(questions, withConfidence = false) {
    const confidence = withConfidence ? { confidence: { type: 'number' } } : {};
    /** @type {Record<string, object>} */
    const properties = {};
    for (const q of questions) {
        const field = q.type === 'choice'
            ? { choice: { type: 'string', enum: q.options }, ...confidence }
            : q.type === 'score'
                ? { value: { type: 'number' }, ...confidence }
                : { probability: { type: 'number' } };
        properties[q.id] = { type: 'object', additionalProperties: false, required: Object.keys(field), properties: field };
    }
    return { type: 'object', additionalProperties: false, required: questions.map(q => q.id), properties };
}

/** @param {Question[]} questions */
function describeQuestions(questions) {
    return questions.map(q => {
        if (q.type === 'choice') return `- ${q.id} (choose one of: ${q.options.map(o => (q.hints?.[o] ? `${o} = ${q.hints[o]}` : o)).join(q.hints ? '; ' : ', ')}): ${q.prompt}`;
        if (q.type === 'score') return `- ${q.id} (a number from ${q.min} to ${q.max}): ${q.prompt}`;
        return `- ${q.id} (yes/no): ${q.prompt}`;
    }).join('\n');
}

/**
 * Turn the model's raw JSON into answers, keeping every value inside what the question allows. Strict mode
 * guarantees the shape and the enum, not numeric ranges.
 * @param {Question[]} questions
 * @param {any} raw
 * @param {boolean} [withConfidence]
 * @returns {Record<string, Answer>}
 */
export function toAnswers(questions, raw, withConfidence = false) {
    /** @type {Record<string, Answer>} */
    const answers = {};
    for (const q of questions) {
        const a = raw?.[q.id];
        if (!a || typeof a !== 'object') throw new DecisionError(`The model did not answer "${q.id}".`);
        const confidence = withConfidence && typeof a.confidence === 'number' && Number.isFinite(a.confidence) ? clamp(a.confidence, 0, 1) : null;
        if (q.type === 'choice') {
            answers[q.id] = { type: 'choice', value: a.choice, confidence };
        } else if (q.type === 'score') {
            if (typeof a.value !== 'number' || !Number.isFinite(a.value)) throw new DecisionError(`The model gave "${q.id}" no number.`);
            answers[q.id] = { type: 'score', value: clamp(a.value, q.min, q.max), confidence };
        } else {
            if (typeof a.probability !== 'number' || !Number.isFinite(a.probability)) throw new DecisionError(`The model gave "${q.id}" no probability.`);
            const probability = clamp(a.probability, 0, 1);
            answers[q.id] = { type: 'noul', value: probability >= 0.5, probability, confidence: withConfidence ? Math.max(probability, 1 - probability) : null };
        }
    }
    return answers;
}

/**
 * @param {OpenAIOptions} [options]
 * @returns {DecisionProvider}
 */
export function createOpenAIProvider(options = {}) {
    const model = options.model ?? 'gpt-5-nano';
    const baseURL = (options.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    const isOpenAI = new URL(baseURL).hostname === 'api.openai.com';
    // Only api.openai.com gets the OpenAI key by default; anything else must name its key explicitly.
    const keyName = options.apiKeyName ?? (isOpenAI ? 'OPENAI_API_KEY' : null);
    const reasoningEffort = options.reasoningEffort === undefined ? (isOpenAI ? lowestEffort(model) : null) : options.reasoningEffort;
    const maxCompletionTokens = options.maxCompletionTokens ?? 2000;
    const withConfidence = options.selfReportedConfidence ?? false;
    const fetchFn = options.fetch ?? fetch;
    /** @type {string | undefined} */
    let apiKey = options.apiKey;

    return {
        name: options.name ?? `openai:${model}`,

        async decide({ state, questions, signal }) {
            if (!apiKey && keyName) {
                const lookup = options.getKey ?? (await import('../../utils/keys.js')).getKey;
                try {
                    apiKey = lookup(keyName);
                } catch (error) {
                    throw new DecisionError(`No API key: ${error instanceof Error ? error.message : String(error)}`, { status: 401 });
                }
            }
            /** @type {Record<string, unknown>} */
            const body = {
                model,
                messages: [
                    { role: 'system', content: systemPrompt(withConfidence) },
                    { role: 'user', content: `STATE:\n${JSON.stringify(state)}\n\nQUESTIONS:\n${describeQuestions(questions)}` },
                ],
                response_format: { type: 'json_schema', json_schema: { name: 'decision', strict: true, schema: schemaFor(questions, withConfidence) } },
                max_completion_tokens: maxCompletionTokens,
            };
            // Ollama and other compatible servers still read the older name
            if (!isOpenAI) body.max_tokens = maxCompletionTokens;
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
                /** @type {string | undefined} */
                let code;
                try {
                    const error = JSON.parse(text)?.error;
                    message = error?.message ?? message;
                    code = error?.code ?? error?.type;
                } catch { /* not JSON */ }
                // An empty account also answers 429, but waiting will not refill it.
                if (code === 'insufficient_quota')
                    throw new DecisionError(`${model}: out of credit (${message})`, { status: response.status });
                throw DecisionError.fromHttpStatus(response.status, `${model}: ${message}`, { retryAfterMs: retryAfterMs(response.headers.get('retry-after')) });
            }

            /** @type {any} */
            let data;
            try {
                data = await response.json();
            } catch {
                // a proxy or load balancer answering with an HTML page: transient, not a bug in this code
                throw new DecisionError(`${model}: the response was not JSON (HTTP ${response.status}).`, { retryable: true });
            }
            const choice = data?.choices?.[0];
            const finish = choice?.finish_reason;
            if (finish === 'length')
                throw new DecisionError(`${model} ran out of tokens before answering (max_completion_tokens ${maxCompletionTokens}; reasoning counts too).`);
            if (choice?.message?.refusal) throw new DecisionError(`${model} refused: ${choice.message.refusal}`);
            const content = choice?.message?.content;
            if (typeof content !== 'string' || content === '')
                throw new DecisionError(`${model} returned no answer (finish_reason: ${finish ?? 'none'}${data?.choices?.length === 0 ? ', no choices' : ''}).`);
            /** @type {any} */
            let raw;
            try {
                raw = JSON.parse(content);
            } catch {
                throw new DecisionError(`${model} did not return JSON (finish_reason: ${finish ?? 'none'}).`);
            }
            return {
                answers: toAnswers(questions, raw, withConfidence),
                inputTokens: data?.usage?.prompt_tokens ?? null,
                outputTokens: data?.usage?.completion_tokens ?? null,
            };
        },
    };
}
