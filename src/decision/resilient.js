// @ts-check
import { AllProvidersFailedError, DecisionError } from './errors.js';
import { validateAnswers, validateQuestions } from './validate.js';

/** @typedef {import('./types.js').DecisionProvider} DecisionProvider */
/** @typedef {import('./types.js').DecisionRequest} DecisionRequest */
/** @typedef {import('./types.js').DecisionResult} DecisionResult */

/**
 * @typedef {object} ResilienceOptions
 * @property {number} [timeoutMs] per attempt. Decisions are only useful while the world still looks the same.
 * @property {number} [retries] extra attempts per provider after a retryable error
 * @property {number} [backoffMs] delay before the first retry; doubles each time
 * @property {number} [maxBackoffMs]
 * @property {(ms: number) => Promise<void>} [sleep] injectable for tests
 * @property {() => number} [random] in [0, 1), for backoff jitter; injectable for tests
 * @property {() => number} [now]
 */

/** @param {number} ms */
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Call one provider once, giving up after `timeoutMs`. The provider gets an AbortSignal so it can cancel its
 * HTTP request instead of leaving it running.
 * @param {DecisionProvider} provider
 * @param {DecisionRequest} request
 * @param {number} timeoutMs
 */
async function attempt(provider, request, timeoutMs) {
    const controller = new AbortController();
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new DecisionError(`${provider.name} timed out after ${timeoutMs} ms`, { retryable: true }));
        }, timeoutMs);
    });
    try {
        const call = provider.decide({ ...request, signal: controller.signal });
        call.catch(() => {}); // if the timeout wins, a later rejection from the abort must not go unhandled
        const response = await Promise.race([call, timeout]);
        validateAnswers(request.questions, response.answers);
        return response;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Wrap a chain of providers with validation, per-attempt timeout, retry with exponential backoff, and
 * fallback to the next provider. Providers stay thin: they translate the request and throw DecisionError.
 *
 * Errors that are not DecisionError (network failures, bugs in a provider) are treated as retryable once the
 * provider has been given the benefit of the doubt; after the retries are used up the chain moves on.
 * @param {DecisionProvider[]} providers tried in order
 * @param {ResilienceOptions} [options]
 * @returns {{name: string, decide: (request: Omit<DecisionRequest, 'signal'>) => Promise<DecisionResult>}}
 */
export function resilient(providers, options = {}) {
    if (providers.length === 0) throw new DecisionError('resilient() needs at least one provider.');
    const timeoutMs = options.timeoutMs ?? 3000;
    const retries = options.retries ?? 2;
    const backoffMs = options.backoffMs ?? 250;
    const maxBackoffMs = options.maxBackoffMs ?? 4000;
    const sleep = options.sleep ?? defaultSleep;
    const random = options.random ?? Math.random;
    const now = options.now ?? Date.now;

    return {
        name: providers.map(p => p.name).join(' > '),

        async decide(request) {
            validateQuestions(request.questions);
            const startedAt = now();
            let attempts = 0;
            /** @type {{provider: string, error: unknown}[]} */
            const failures = [];

            for (const provider of providers) {
                /** @type {unknown} */
                let lastError;
                for (let retry = 0; retry <= retries; retry++) {
                    if (retry > 0) {
                        const base = Math.min(backoffMs * 2 ** (retry - 1), maxBackoffMs);
                        await sleep(base / 2 + random() * base / 2); // jitter: [base/2, base)
                    }
                    attempts++;
                    try {
                        const response = await attempt(provider, request, timeoutMs);
                        return {
                            answers: response.answers,
                            inputTokens: response.inputTokens ?? null,
                            provider: provider.name,
                            latencyMs: now() - startedAt,
                            attempts,
                        };
                    } catch (error) {
                        lastError = error;
                        const retryable = error instanceof DecisionError ? error.retryable : true;
                        if (!retryable) break;
                    }
                }
                failures.push({ provider: provider.name, error: lastError });
            }
            throw new AllProvidersFailedError(failures);
        },
    };
}
