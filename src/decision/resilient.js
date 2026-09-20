// @ts-check
import { AllProvidersFailedError, DecisionError } from './errors.js';
import { validateAnswers, validateQuestions } from './validate.js';

/** @typedef {import('./types.js').DecisionProvider} DecisionProvider */
/** @typedef {import('./types.js').DecisionRequest} DecisionRequest */
/** @typedef {import('./types.js').DecisionResult} DecisionResult */
/** @typedef {import('./types.js').Answer} Answer */

/**
 * @typedef {object} ResilienceOptions
 * @property {number} [timeoutMs] per attempt
 * @property {number} [deadlineMs] for the whole decide() call across retries and fallbacks. A decision is only
 *   useful while the world still looks the same, and abandoned requests still cost tokens and rate limit.
 * @property {number} [retries] extra attempts per provider after a retryable error
 * @property {number} [backoffMs] delay before the first retry; doubles each time
 * @property {number} [maxBackoffMs]
 * @property {(ms: number) => Promise<void>} [sleep] injectable for tests
 * @property {() => number} [random] in [0, 1), for backoff jitter; injectable for tests
 * @property {() => number} [now]
 */

/** @param {number} ms */
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Bugs in a provider, as opposed to the network failing. `TypeError` is not here: fetch throws it when offline. */
const PROGRAMMING_ERRORS = [ReferenceError, SyntaxError, RangeError];

/**
 * @param {unknown} error
 * @returns {'retry' | 'next' | 'abort'} retry this provider, move to the next one, or give up entirely
 */
function classify(error) {
    if (error instanceof DecisionError) {
        if (error.fatal) return 'abort';
        return error.retryable ? 'retry' : 'next';
    }
    if (PROGRAMMING_ERRORS.some(type => error instanceof type)) return 'next';
    return 'retry'; // network errors and the like
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {number} min
 */
function checkOption(name, value, min) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min)
        throw new DecisionError(`decision_options.${name} must be a number >= ${min}, got ${value}.`, { fatal: true });
}

/**
 * Call one provider once, giving up after `timeoutMs` or when the caller cancels. The provider gets an
 * AbortSignal so it can cancel its HTTP request instead of leaving it running.
 * @param {DecisionProvider} provider
 * @param {DecisionRequest} request
 * @param {number} timeoutMs
 */
async function attempt(provider, request, timeoutMs) {
    const controller = new AbortController();
    const callerSignal = request.signal;
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    let timedOut = false;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const aborted = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
    });
    aborted.catch(() => {});

    try {
        const call = provider.decide({ ...request, signal: controller.signal });
        call.catch(() => {}); // a rejection that arrives after we stopped waiting must not go unhandled
        const response = await Promise.race([call, aborted]);
        validateAnswers(request.questions, response.answers);
        return response;
    } catch (error) {
        // Whoever wins the race, report the abort the same way: a provider that honours the signal rejects
        // synchronously inside abort(), one that does not never rejects at all.
        if (callerSignal?.aborted) throw new DecisionError('Decision cancelled by the caller.', { fatal: true });
        if (timedOut) throw new DecisionError(`${provider.name} timed out after ${timeoutMs} ms`, { retryable: true });
        throw error;
    } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
    }
}

/**
 * Wrap a chain of providers with validation, per-attempt timeout, an overall deadline, retry with exponential
 * backoff (honouring Retry-After), fallback to the next provider, and cancellation. Providers stay thin: they
 * translate the request and throw DecisionError.
 *
 * - retryable errors (429, 5xx, timeouts, network failures) are retried on the same provider
 * - other errors, including answers that fail validation, move on to the next provider
 * - fatal errors (malformed questions, cancellation) are rethrown at once: no provider can fix them
 *
 * @param {DecisionProvider[]} providers tried in order
 * @param {ResilienceOptions} [options]
 * @returns {{name: string, decide: (request: DecisionRequest) => Promise<DecisionResult>}}
 *   `request.signal` cancels the whole call, e.g. when the loop has moved on and no longer wants the answer
 */
export function resilient(providers, options = {}) {
    if (providers.length === 0) throw new DecisionError('resilient() needs at least one provider.', { fatal: true });
    const timeoutMs = options.timeoutMs ?? 3000;
    const deadlineMs = options.deadlineMs ?? 6000;
    const retries = options.retries ?? 2;
    const backoffMs = options.backoffMs ?? 250;
    const maxBackoffMs = options.maxBackoffMs ?? 4000;
    checkOption('timeoutMs', timeoutMs, 1);
    checkOption('deadlineMs', deadlineMs, 1);
    checkOption('retries', retries, 0);
    checkOption('backoffMs', backoffMs, 0);
    checkOption('maxBackoffMs', maxBackoffMs, 0);
    const sleep = options.sleep ?? defaultSleep;
    const random = options.random ?? Math.random;
    const now = options.now ?? Date.now;

    return {
        name: providers.map(p => p.name).join(' > '),

        async decide(request) {
            validateQuestions(request.questions);
            if (request.signal?.aborted) throw new DecisionError('Decision cancelled by the caller.', { fatal: true });
            const startedAt = now();
            const remaining = () => deadlineMs - (now() - startedAt);
            let attempts = 0;
            /** @type {{provider: string, error: unknown}[]} */
            const failures = [];
            const outOfTime = () => new DecisionError(`deadline of ${deadlineMs} ms exceeded`, { retryable: true });

            providers: for (const provider of providers) {
                /** @type {unknown} */
                let lastError;
                for (let retry = 0; retry <= retries; retry++) {
                    if (retry > 0) {
                        const base = Math.min(backoffMs * 2 ** (retry - 1), maxBackoffMs);
                        const asked = lastError instanceof DecisionError ? lastError.retryAfterMs ?? 0 : 0;
                        const delay = Math.max(base / 2 + random() * base / 2, asked); // jitter: [base/2, base)
                        if (delay >= remaining()) break; // waiting would blow the deadline; try the next provider
                        await sleep(delay);
                    }
                    if (remaining() <= 0) {
                        failures.push({ provider: provider.name, error: lastError ?? outOfTime() });
                        break providers;
                    }
                    attempts++;
                    try {
                        const response = await attempt(provider, request, Math.min(timeoutMs, remaining()));
                        /** @type {Record<string, Answer>} */
                        const answers = {};
                        for (const q of request.questions) // drop ids nobody asked about; undefined confidence -> null
                            answers[q.id] = { ...response.answers[q.id], confidence: response.answers[q.id].confidence ?? null };
                        return {
                            answers,
                            inputTokens: response.inputTokens ?? null,
                            provider: provider.name,
                            latencyMs: now() - startedAt,
                            attempts,
                        };
                    } catch (error) {
                        lastError = error;
                        const verdict = classify(error);
                        if (verdict === 'abort') throw error;
                        if (verdict === 'next') break;
                    }
                }
                failures.push({ provider: provider.name, error: lastError });
            }
            throw new AllProvidersFailedError(failures);
        },
    };
}
