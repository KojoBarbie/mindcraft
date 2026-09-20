// @ts-check
import { DecisionError } from './errors.js';

/** @typedef {import('./types.js').Question} Question */
/** @typedef {import('./types.js').Answer} Answer */

/** @param {unknown} n */
const isProbability = n => typeof n === 'number' && n >= 0 && n <= 1;

/**
 * Throws if the questions are malformed. This is a programming error on the caller's side, never retryable.
 * @param {Question[]} questions
 */
export function validateQuestions(questions) {
    if (!Array.isArray(questions) || questions.length === 0)
        throw new DecisionError('A decision request needs at least one question.');
    const ids = new Set();
    for (const q of questions) {
        if (!q || typeof q.id !== 'string' || q.id === '')
            throw new DecisionError('Every question needs a non-empty string id.');
        if (ids.has(q.id)) throw new DecisionError(`Duplicate question id "${q.id}".`);
        ids.add(q.id);
        if (typeof q.prompt !== 'string' || q.prompt === '')
            throw new DecisionError(`Question "${q.id}" needs a prompt.`);
        switch (q.type) {
            case 'choice':
                if (!Array.isArray(q.options) || q.options.length === 0)
                    throw new DecisionError(`Choice question "${q.id}" needs at least one option.`);
                if (q.options.some(o => typeof o !== 'string' || o === ''))
                    throw new DecisionError(`Choice question "${q.id}" has an empty or non-string option.`);
                if (new Set(q.options).size !== q.options.length)
                    throw new DecisionError(`Choice question "${q.id}" has duplicate options.`);
                break;
            case 'score':
                if (!Number.isFinite(q.min) || !Number.isFinite(q.max) || q.min >= q.max)
                    throw new DecisionError(`Score question "${q.id}" needs finite min < max.`);
                break;
            case 'noul':
                break;
            default:
                throw new DecisionError(`Question "${/** @type {any} */ (q).id}" has unknown type "${/** @type {any} */ (q).type}".`);
        }
    }
}

/**
 * Throws if a provider's answers do not fit the questions. A model can always be wrong about the world, but it
 * must never hand back an option that was not offered: downstream code turns answers into game commands.
 * Not retryable on the same provider (it would likely repeat itself); the wrapper falls through to the next.
 * @param {Question[]} questions
 * @param {Record<string, Answer>} answers
 */
export function validateAnswers(questions, answers) {
    if (!answers || typeof answers !== 'object')
        throw new DecisionError('Provider returned no answers.');
    for (const q of questions) {
        const a = answers[q.id];
        if (!a) throw new DecisionError(`Provider did not answer question "${q.id}".`);
        if (a.type !== q.type)
            throw new DecisionError(`Answer to "${q.id}" has type "${a.type}", expected "${q.type}".`);
        if (a.confidence !== null && !isProbability(a.confidence))
            throw new DecisionError(`Answer to "${q.id}" has an invalid confidence.`);
        if (q.type === 'choice' && a.type === 'choice') {
            if (!q.options.includes(a.value))
                throw new DecisionError(`Answer to "${q.id}" is "${a.value}", which is not one of the options.`);
            if (a.distribution) {
                for (const [option, p] of Object.entries(a.distribution)) {
                    if (!q.options.includes(option) || !isProbability(p))
                        throw new DecisionError(`Answer to "${q.id}" has an invalid distribution.`);
                }
            }
        } else if (q.type === 'score' && a.type === 'score') {
            if (!Number.isFinite(a.value) || a.value < q.min || a.value > q.max)
                throw new DecisionError(`Answer to "${q.id}" is ${a.value}, outside [${q.min}, ${q.max}].`);
        } else if (a.type === 'noul') {
            if (typeof a.value !== 'boolean' || !isProbability(a.probability))
                throw new DecisionError(`Answer to "${q.id}" is not a valid yes/no probability.`);
            if (a.value !== (a.probability >= 0.5))
                throw new DecisionError(`Answer to "${q.id}" has a value that contradicts its probability.`);
        }
    }
}
