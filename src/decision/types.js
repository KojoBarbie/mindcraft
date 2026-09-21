// @ts-check
// Types for the decision layer. A decision provider answers typed questions about a state; it never writes
// free text. This mirrors what decision-specialised models (e.g. TypeSafe's Jev) offer natively, and what a
// chat model can be constrained to with structured output.

/**
 * @typedef {object} ChoiceQuestion
 * @property {string} id unique within one request
 * @property {'choice'} type
 * @property {string} prompt
 * @property {string[]} options at least one, unique
 */

/**
 * @typedef {object} ScoreQuestion
 * @property {string} id
 * @property {'score'} type
 * @property {string} prompt
 * @property {number} min
 * @property {number} max greater than min
 */

/**
 * A yes/no question answered with a probability ("noul" is Jev's name for it).
 * @typedef {object} NoulQuestion
 * @property {string} id
 * @property {'noul'} type
 * @property {string} prompt
 */

/** @typedef {ChoiceQuestion | ScoreQuestion | NoulQuestion} Question */

/**
 * @typedef {object} ChoiceAnswer
 * @property {'choice'} type
 * @property {string} value one of the question's options
 * @property {number | null} confidence probability of `value` in [0, 1]; null if the provider cannot tell
 * @property {Record<string, number>} [distribution] probability per option, when available
 */

/**
 * @typedef {object} ScoreAnswer
 * @property {'score'} type
 * @property {number} value within [min, max]
 * @property {number | null} confidence
 */

/**
 * @typedef {object} NoulAnswer
 * @property {'noul'} type
 * @property {boolean} value probability >= 0.5
 * @property {number} probability probability that the answer is yes, in [0, 1]
 * @property {number | null} confidence how sure the provider is of `value`: max(p, 1 - p) unless it says otherwise
 */

/** @typedef {ChoiceAnswer | ScoreAnswer | NoulAnswer} Answer */

/**
 * @typedef {object} DecisionRequest
 * @property {unknown} state JSON-serialisable context; keep it small, providers bill by input size
 * @property {Question[]} questions
 * @property {AbortSignal} [signal] aborted on timeout or when the caller cancels; providers should pass it to fetch
 */

/**
 * @typedef {object} DecisionResponse
 * @property {Record<string, Answer>} answers keyed by question id; one per question. `confidence` may be left
 *   undefined by a provider; the resilient wrapper normalises it to null
 * @property {number | null} [inputTokens] as reported by the provider
 * @property {number | null} [outputTokens] as reported by the provider; reasoning models bill reasoning here
 */

/**
 * What callers get back from a resilient provider: the response plus how it was obtained.
 * @typedef {object} DecisionResult
 * @property {Record<string, Answer>} answers
 * @property {number | null} inputTokens
 * @property {number | null} [outputTokens]
 * @property {string} provider name of the provider that answered
 * @property {number} latencyMs wall time including retries and fallbacks
 * @property {number} attempts calls made across all providers
 */

/**
 * @typedef {object} DecisionProvider
 * @property {string} name
 * @property {(request: DecisionRequest) => Promise<DecisionResponse>} decide
 */

export {};
