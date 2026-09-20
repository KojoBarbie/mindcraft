// @ts-check

/** An error from the decision layer. `retryable` tells the resilient wrapper whether asking again can help. */
export class DecisionError extends Error {
    /**
     * @param {string} message
     * @param {{retryable?: boolean, status?: number, cause?: unknown}} [options]
     */
    constructor(message, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'DecisionError';
        this.retryable = options.retryable ?? false;
        this.status = options.status;
    }

    /**
     * Rate limits and server errors are worth retrying; other 4xx are not.
     * @param {number} status
     * @param {string} message
     */
    static fromHttpStatus(status, message) {
        const retryable = status === 408 || status === 429 || status >= 500;
        return new DecisionError(message, { retryable, status });
    }
}

/** Thrown when every provider in the chain has failed. `errors` holds the last error of each provider. */
export class AllProvidersFailedError extends DecisionError {
    /** @param {{provider: string, error: unknown}[]} errors */
    constructor(errors) {
        const detail = errors
            .map(e => `${e.provider}: ${e.error instanceof Error ? e.error.message : String(e.error)}`)
            .join('; ');
        super(`All decision providers failed (${detail})`);
        this.name = 'AllProvidersFailedError';
        this.errors = errors;
    }
}
