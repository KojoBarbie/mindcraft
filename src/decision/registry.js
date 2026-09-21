// @ts-check
import { DecisionError } from './errors.js';
import { createMockProvider } from './providers/mock.js';
import { createRulesProvider } from './providers/rules.js';
import { createOpenAIProvider } from './providers/openai.js';
import { resilient } from './resilient.js';

/** @typedef {import('./types.js').DecisionProvider} DecisionProvider */

/**
 * One entry of a profile's `decision_model`: a provider name, or an object with the name and its options.
 * @typedef {string | ({provider: string} & Record<string, unknown>)} ProviderSpec
 */

/** @typedef {(options: Record<string, unknown>) => DecisionProvider} ProviderFactory */

// A Map, not an object: a profile saying "constructor" must not resolve to Object.prototype.constructor.
/** @type {Map<string, ProviderFactory>} */
const factories = new Map([
    ['mock', /** @type {ProviderFactory} */ (options => createMockProvider(options))],
    ['rules', /** @type {ProviderFactory} */ (options => createRulesProvider(options))],
    ['openai', /** @type {ProviderFactory} */ (options => createOpenAIProvider(options))],
    // Ollama speaks the same API on localhost and needs no key. The default is a model that does not think
    // before answering: a thinking model (qwen3) cannot be told not to through this API and blows the timeout.
    ['ollama', /** @type {ProviderFactory} */ (options => createOpenAIProvider({
        baseURL: 'http://localhost:11434/v1', model: 'llama3.2:3b', name: `ollama:${options.model ?? 'llama3.2:3b'}`, ...options,
    }))],
]);

/**
 * Make a provider available under a name. Registering a name twice is almost always a mistake (two modules
 * fighting over it), so it throws; the returned function removes the registration again (for tests).
 *
 * Every agent builds its own provider instances. State that must be shared between agents in one process,
 * such as a rate limiter for one API key, belongs in the provider module's scope, not here.
 * @param {string} name
 * @param {ProviderFactory} factory
 * @returns {() => void} unregister
 */
export function registerDecisionProvider(name, factory) {
    if (factories.has(name)) throw new DecisionError(`Decision provider "${name}" is already registered.`, { fatal: true });
    factories.set(name, factory);
    return () => { factories.delete(name); };
}

/**
 * @param {ProviderSpec} spec
 * @returns {DecisionProvider}
 */
export function createDecisionProvider(spec) {
    const { provider: name, ...options } = typeof spec === 'string' ? { provider: spec } : spec;
    const factory = factories.get(name);
    if (!factory)
        throw new DecisionError(`Unknown decision provider "${name}". Known: ${[...factories.keys()].join(', ')}.`, { fatal: true });
    return factory(options);
}

/**
 * Build the resilient provider chain for an agent profile.
 *
 *   "decision_model": "mock"
 *   "decision_model": {"provider": "mock", "seed": 7}
 *   "decision_model": ["jev", {"provider": "ollama", "model": "qwen3:4b"}]   // fallback order
 *   "decision_options": {"timeoutMs": 2000, "deadlineMs": 4000, "retries": 1}
 *
 * @param {{decision_model?: ProviderSpec | ProviderSpec[], decision_options?: import('./resilient.js').ResilienceOptions}} profile
 * @returns {ReturnType<typeof resilient> | null} null when the profile does not configure a decision model
 */
export function createDecisionProviderFromProfile(profile) {
    if (profile.decision_model === undefined || profile.decision_model === null) return null;
    const specs = Array.isArray(profile.decision_model) ? profile.decision_model : [profile.decision_model];
    return resilient(specs.map(spec => createDecisionProvider(spec)), profile.decision_options);
}
