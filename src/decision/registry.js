// @ts-check
import { DecisionError } from './errors.js';
import { createMockProvider } from './providers/mock.js';
import { resilient } from './resilient.js';

/** @typedef {import('./types.js').DecisionProvider} DecisionProvider */

/**
 * One entry of a profile's `decision_model`: a provider name, or an object with the name and its options.
 * @typedef {string | ({provider: string} & Record<string, unknown>)} ProviderSpec
 */

/** @type {Record<string, (options: Record<string, unknown>) => DecisionProvider>} */
const factories = {
    mock: options => createMockProvider(options),
};

/**
 * Make a provider available under a name (used by provider modules and tests).
 * @param {string} name
 * @param {(options: Record<string, unknown>) => DecisionProvider} factory
 */
export function registerDecisionProvider(name, factory) {
    factories[name] = factory;
}

/**
 * @param {ProviderSpec} spec
 * @returns {DecisionProvider}
 */
export function createDecisionProvider(spec) {
    const { provider: name, ...options } = typeof spec === 'string' ? { provider: spec } : spec;
    const factory = factories[name];
    if (!factory)
        throw new DecisionError(`Unknown decision provider "${name}". Known: ${Object.keys(factories).join(', ')}.`);
    return factory(options);
}

/**
 * Build the resilient provider chain for an agent profile.
 *
 *   "decision_model": "mock"
 *   "decision_model": {"provider": "mock", "seed": 7}
 *   "decision_model": ["jev", {"provider": "ollama", "model": "qwen3:4b"}]   // fallback order
 *   "decision_options": {"timeoutMs": 2000, "retries": 1}
 *
 * @param {{decision_model?: ProviderSpec | ProviderSpec[], decision_options?: import('./resilient.js').ResilienceOptions}} profile
 * @returns {ReturnType<typeof resilient> | null} null when the profile does not configure a decision model
 */
export function createDecisionProviderFromProfile(profile) {
    if (profile.decision_model === undefined || profile.decision_model === null) return null;
    const specs = Array.isArray(profile.decision_model) ? profile.decision_model : [profile.decision_model];
    return resilient(specs.map(createDecisionProvider), profile.decision_options);
}
