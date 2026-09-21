// @ts-check
// Hierarchical selection: action -> target -> quantity, one choice question per stage. Flat enumeration of
// every (action, target, quantity) would run to hundreds of options; staged, each question stays small, and a
// stage with a single option is not asked at all.
import { buildCommand, listActions, listQuantities, listTargets, maxQuantity, targetNotes } from './catalog.js';

/** @typedef {import('./catalog.js').CatalogContext} CatalogContext */
/** @typedef {import('./types.js').DecisionResult} DecisionResult */

/**
 * @typedef {object} ChosenCommand
 * @property {string} command ready for Mindcraft's executeCommand
 * @property {string} action
 * @property {string} [target]
 * @property {number} [quantity]
 * @property {number | null} confidence the least confident stage; null if any asked stage gave none
 * @property {number} decisions provider calls made (0-3)
 * @property {number} latencyMs summed over the calls
 * @property {number | null} inputTokens summed over the calls; null if any call did not report it
 * @property {string} [provider] which provider answered the last stage asked
 */

/**
 * @param {{decide: (request: import('./types.js').DecisionRequest) => Promise<DecisionResult>}} provider
 * @param {CatalogContext} ctx
 * @param {unknown} state what the model sees, from compressState()
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {string[]} [options.only] restrict the first stage to these action ids
 * @param {Record<string, {target?: string, quantity?: number}>} [options.preset] for these actions the target and
 *   quantity are already known (a planner worked them out), so those stages are not asked. A quantity over what
 *   the catalog offers in one go is clamped rather than refused.
 * @returns {Promise<ChosenCommand>}
 */
export async function chooseCommand(provider, ctx, state, options = {}) {
    let decisions = 0;
    /** @type {string | undefined} */
    let provider_;
    let latencyMs = 0;
    /** @type {number | null} */
    let inputTokens = 0;
    /** @type {number | null} */
    let confidence = 1;

    /**
     * @param {string} id
     * @param {string} prompt
     * @param {string[]} choices
     * @param {Record<string, string>} [hints]
     */
    async function ask(id, prompt, choices, hints) {
        if (choices.length === 1) return choices[0]; // nothing to decide
        const result = await provider.decide({
            state,
            questions: [{ id, type: 'choice', prompt, options: choices, ...(hints && Object.keys(hints).length > 0 ? { hints } : {}) }],
            signal: options.signal,
        });
        decisions++;
        latencyMs += result.latencyMs;
        inputTokens = inputTokens == null || result.inputTokens == null ? null : inputTokens + result.inputTokens;
        if (result.provider) provider_ = result.provider;
        const answer = result.answers[id];
        // `== null` on purpose: a provider used without resilient() may leave confidence undefined, and
        // Math.min(1, undefined) is NaN, which would sail through every threshold check downstream
        confidence = confidence == null || answer.confidence == null ? null : Math.min(confidence, answer.confidence);
        return /** @type {string} */ (answer.value);
    }

    let actions = listActions(ctx);
    if (options.only) actions = actions.filter(action => options.only?.includes(action.id));
    if (actions.length === 0) throw new Error('No action is possible right now.'); // cannot happen unfiltered: "wait" always is

    const action = await ask('action', 'Pick the single best next action for the bot, given its goal.', actions.map(a => a.id),
        Object.fromEntries(actions.map(a => [a.id, a.hint])));

    const preset = options.preset?.[action];
    if (preset) {
        const quantities = listQuantities(ctx, action, preset.target);
        const quantity = quantities.length > 0 ? Math.min(preset.quantity ?? quantities[0], maxQuantity(ctx, action, preset.target)) : undefined;
        return {
            command: buildCommand(ctx, { id: action, target: preset.target, quantity }),
            action, target: preset.target, quantity,
            confidence: decisions === 0 ? 1 : confidence,
            decisions, latencyMs, inputTokens, ...(provider_ ? { provider: provider_ } : {}),
        };
    }

    const targets = listTargets(ctx, action);
    const target = targets.length > 0
        ? await ask('target', `The bot will ${action}. Pick what.`, targets, targetNotes(ctx, action, targets))
        : undefined;

    const quantities = listQuantities(ctx, action, target);
    const quantity = quantities.length > 0
        ? Number(await ask('quantity', `The bot will ${action}${target ? ` ${target}` : ''}. Pick how many.`, quantities.map(String)))
        : undefined;

    return {
        command: buildCommand(ctx, { id: action, target, quantity }),
        action, target, quantity,
        confidence: decisions === 0 ? 1 : confidence,
        decisions, latencyMs, inputTokens, ...(provider_ ? { provider: provider_ } : {}),
    };
}
