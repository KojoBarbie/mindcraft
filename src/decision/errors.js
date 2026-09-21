// @ts-check

/** An error from the decision layer. `retryable` tells the resilient wrapper whether asking again can help. */
export class DecisionError extends Error {
    /**
     * @param {string} message
     * @param {object} [options]
     * @param {boolean} [options.retryable] asking the same provider again may help
     * @param {boolean} [options.fatal] a bug or a cancelled request: do not retry and do not fall back
     * @param {number} [options.status] HTTP status, when there was one
     * @param {number} [options.retryAfterMs] the provider asked us to wait at least this long (Retry-After)
     * @param {unknown} [options.cause]
     */
    constructor(message, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'DecisionError';
        this.retryable = options.retryable ?? false;
        this.fatal = options.fatal ?? false;
        this.status = options.status;
        this.retryAfterMs = options.retryAfterMs;
    }

    /**
     * Rate limits and server errors are worth retrying; other 4xx are not.
     * @param {number} status
     * @param {string} message
     * @param {{retryAfterMs?: number}} [options]
     */
    static fromHttpStatus(status, message, options = {}) {
        const retryable = status === 408 || status === 429 || status >= 500;
        return new DecisionError(message, { retryable, status, retryAfterMs: options.retryAfterMs });
    }
}

/** Thrown when every provider in the chain has failed. `errors` holds the last error of each provider. */
export class AllProvidersFailedError extends DecisionError {
    /**
     * @param {{provider: string, error: unknown}[]} errors
     * @param {number} [attempts] requests sent before giving up; they may be billed even though they failed
     */
    constructor(errors, attempts = errors.length) {
        const detail = errors
            .map(e => `${e.provider}: ${e.error instanceof Error ? e.error.message : String(e.error)}`)
            .join('; ');
        // retryable: some provider might answer later, so the caller should slow down rather than give up
        const retryable = errors.some(e => !(e.error instanceof DecisionError) || e.error.retryable);
        super(`All decision providers failed (${detail})`, { retryable });
        this.name = 'AllProvidersFailedError';
        this.errors = errors;
        this.attempts = attempts;
        /** HTTP statuses seen, e.g. to tell a rate limit (429) from a bad key (401). */
        this.statuses = errors.flatMap(e => (e.error instanceof DecisionError && e.error.status !== undefined ? [e.error.status] : []));
        /** Longest wait any provider asked for. */
        this.retryAfterMs = Math.max(0, ...errors.map(e => (e.error instanceof DecisionError ? e.error.retryAfterMs ?? 0 : 0)));
    }
}
