// @ts-check
// A decision provider with no model behind it: a handful of rules over the same state a model would see.
// It exists so the whole loop can run with no API key, and so benchmarks have a "no model at all" baseline
// to beat. Unlike the mock provider it is deterministic and configured from a profile, not from code.
import { DecisionError } from '../errors.js';

/** @typedef {import('../types.js').DecisionProvider} DecisionProvider */
/** @typedef {import('../types.js').Question} Question */
/** @typedef {import('../types.js').Answer} Answer */

/**
 * The fields of the compressed state these rules look at.
 * @typedef {object} RuleState
 * @property {number} [hp]
 * @property {number} [food]
 * @property {Record<string, {n: number, d: number}>} [mobs]
 * @property {Record<string, number>} [inv]
 * @property {string} [plan_action] the action the planner wants next, if any
 */

/**
 * @typedef {object} RulesOptions
 * @property {number} [fleeBelowHp] flee when health is at or under this and a hostile mob is close
 * @property {number} [fightBelowHp] at or under this, being near a hostile counts as hurt (used by callers)
 * @property {number} [eatBelowFood]
 * @property {number} [threatRange] blocks
 */

/**
 * @param {unknown} state
 * @returns {RuleState}
 */
function read(state) {
    return state && typeof state === 'object' ? /** @type {RuleState} */ (state) : {};
}

/**
 * @param {RulesOptions} [options]
 * @returns {DecisionProvider}
 */
export function createRulesProvider(options = {}) {
    const fleeBelowHp = options.fleeBelowHp ?? 8;
    const fightBelowHp = options.fightBelowHp ?? 14;
    const eatBelowFood = options.eatBelowFood ?? 14;
    const threatRange = options.threatRange ?? 8;

    /**
     * @param {RuleState} s
     * @returns {{danger: boolean, hurt: boolean, starving: boolean}}
     */
    function assess(s) {
        const closest = Math.min(Infinity, ...Object.values(s.mobs ?? {}).map(mob => mob.d));
        return {
            // A hostile mob within reach is the emergency, whatever the health bar says; health decides
            // whether the answer is to fight it or to run from it.
            danger: closest <= threatRange,
            hurt: (s.hp ?? 20) <= fightBelowHp,
            starving: (s.food ?? 20) <= eatBelowFood,
        };
    }

    /**
     * @param {RuleState} s
     * @param {string[]} choices
     * @returns {string}
     */
    function pickAction(s, choices) {
        const { danger, starving } = assess(s);
        /** @param {...string} ids */
        const first = (...ids) => ids.find(id => choices.includes(id));
        if (danger) {
            const fight = (s.hp ?? 20) > fleeBelowHp;
            const move = fight ? first('attack', 'flee') : first('flee', 'attack');
            if (move) return move;
        }
        if (starving) {
            const eat = first('eat');
            if (eat) return eat;
        }
        // otherwise: do what the planner wants, and if that is not on offer, keep busy rather than stall
        return first(s.plan_action ?? '', 'collect_blocks', 'craft', 'search_for_block', 'explore', 'wait') ?? choices[0];
    }

    return {
        name: 'rules',

        decide({ state, questions }) {
            const s = read(state);
            const { danger } = assess(s);
            /** @type {Record<string, Answer>} */
            const answers = {};
            for (const question of questions) {
                switch (question.type) {
                    case 'choice':
                        answers[question.id] = question.id === 'action'
                            ? { type: 'choice', value: pickAction(s, question.options), confidence: 1 }
                            // targets and quantities are the planner's job; when asked, take the first on offer,
                            // which the catalog orders by distance or by how much there is
                            : { type: 'choice', value: question.options[0], confidence: 0.5 };
                        break;
                    case 'noul': {
                        // The one yes/no the loop asks: "should the bot stop what it is doing?" Only real
                        // danger justifies that. Hunger does not: there may be nothing to eat, and the loop
                        // will pick eating on its own as soon as the current action finishes.
                        const probability = danger ? 0.9 : 0.05;
                        answers[question.id] = { type: 'noul', value: probability >= 0.5, probability, confidence: 0.8 };
                        break;
                    }
                    case 'score':
                        answers[question.id] = { type: 'score', value: (question.min + question.max) / 2, confidence: 0 };
                        break;
                    default:
                        return Promise.reject(new DecisionError(`The rules provider cannot answer "${/** @type {any} */ (question).type}".`, { fatal: true }));
                }
            }
            return Promise.resolve({ answers, inputTokens: null });
        },
    };
}
