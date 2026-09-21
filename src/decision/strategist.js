// @ts-check
// The strategic layer: a large chat model, consulted rarely, that turns a player's request or a stalled run
// into a short list of typed goals. It never drives the bot itself and the tactical loop never waits for it:
// a consultation runs in the background and its goals join the queue whenever they arrive.
//
// Everything the model proposes is checked before it is used: the goal must be one of the typed goals, name
// real items, and have a route the deterministic planner can find from where the bot stands. A model that
// invents "have 1 house" gets its goal dropped, not a bot wandering about looking for a house.
import { describeGoal } from './goals.js';
import { planGoal } from './planner.js';
import { estimateTokens } from './tokens.js';

/** @typedef {import('./goals.js').Goal} Goal */
/** @typedef {import('./goals.js').GoalQueue} GoalQueue */
/** @typedef {import('./gamedata.js').GameData} GameData */
/** @typedef {import('./snapshot.js').Snapshot} Snapshot */

/**
 * @typedef {'chat' | 'low_confidence' | 'gave_up'} TriggerKind
 * @typedef {{kind: TriggerKind, from?: string, message?: string, detail?: unknown}} Trigger
 * @typedef {{snapshot: Snapshot, goals: GoalQueue, currentGoal?: string | null, recent?: unknown[]}} Context
 * @typedef {{reply: string | null, accepted: Goal[], rejected: {goal: unknown, reason: string}[]}} Consultation
 */

/**
 * @typedef {object} StrategistOptions
 * @property {(system: string, user: string) => Promise<{text: string, inputTokens?: number, outputTokens?: number}>} complete
 *   one call to the chat model
 * @property {GameData} data
 * @property {string} [name] of the model, for logs
 * @property {[number, number]} [price] USD per million tokens in/out, to charge the guard; unknown = tokens only
 * @property {import('./guard.js').LoopGuard} [guard] consultations are charged to the same budget as decisions
 * @property {(record: Record<string, unknown>) => void} [telemetry]
 * @property {(event: {type: string, detail?: unknown}) => void} [onEvent]
 * @property {(text: string) => void} [say] how a reply reaches the players
 * @property {number} [maxPerHour] default 20
 * @property {Partial<Record<TriggerKind, number>>} [cooldownMs] per trigger kind; a player is never kept waiting
 * @property {number} [maxGoals] per consultation, default 5
 * @property {() => number} [now]
 */

const TOOLS = ['pickaxe', 'axe', 'sword', 'shovel', 'hoe'];
const TIERS = ['wooden', 'stone', 'iron', 'diamond'];

export const SYSTEM_PROMPT = `You plan for a Minecraft survival bot. A fast tactical controller carries out goals on its own; you only
decide which goals come next. Answer with one JSON object and nothing else:
{"reply": string or null, "goals": [goal, ...]}
Each goal is one of:
  {"type": "have_item", "item": "<minecraft item id, e.g. iron_ingot>", "count": <1-640>}
  {"type": "have_tool", "tool": "pickaxe|axe|sword|shovel|hoe", "tier": "wooden|stone|iron|diamond"}
  {"type": "have_food", "count": <1-64>}
List at most five goals, most important first. Break a big request into the items it needs: armour means the
armour pieces themselves (iron_helmet, iron_chestplate, ...); a house means its materials (planks, cobblestone,
glass, a door), since the bot cannot build yet, which the reply should say. Use exact item ids.
"reply" answers a player who asked for something, in the player's language, in one short sentence; null when
no player asked. Give an empty goal list when nothing should change.`;

/**
 * The JSON object in a chat model's answer, which may come wrapped in a code fence or a sentence.
 * @param {string} text
 * @returns {any | null}
 */
export function extractJson(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
}

/**
 * Is this a goal the queue understands, naming things that exist? Returns the cleaned goal or a reason.
 * @param {unknown} raw
 * @param {GameData} data
 * @returns {{goal: Goal} | {reason: string}}
 */
export function validateGoal(raw, data) {
    const g = /** @type {any} */ (raw);
    if (!g || typeof g !== 'object') return { reason: 'not an object' };
    if (g.type === 'have_item') {
        const item = typeof g.item === 'string' ? g.item.replace(/^minecraft:/, '') : '';
        if (!data.isItem(item)) return { reason: `unknown item "${g.item}"` };
        const count = Number(g.count);
        if (!Number.isInteger(count) || count < 1 || count > 640) return { reason: `bad count ${g.count}` };
        return { goal: { type: 'have_item', item, count } };
    }
    if (g.type === 'have_tool') {
        if (!TOOLS.includes(g.tool) || !TIERS.includes(g.tier)) return { reason: `unknown tool ${g.tier}_${g.tool}` };
        return { goal: { type: 'have_tool', tool: g.tool, tier: g.tier } };
    }
    if (g.type === 'have_food') {
        const count = Number(g.count);
        if (!Number.isInteger(count) || count < 1 || count > 64) return { reason: `bad count ${g.count}` };
        return { goal: { type: 'have_food', count } };
    }
    return { reason: `unknown goal type "${g.type}"` };
}

/**
 * Is a chat message meant for the bot? Commands (Mindcraft's "!") are not requests; otherwise a message that
 * names the bot is, and so is any message when the bot and one player are alone together.
 * @param {string} message
 * @param {string} botName
 * @param {number} otherPlayers humans online besides the bot
 */
export function isAddressedTo(message, botName, otherPlayers) {
    const text = message.trim();
    if (text === '' || text.startsWith('!')) return false;
    if (text.toLowerCase().includes(botName.toLowerCase())) return true;
    return otherPlayers <= 1;
}

/** @param {Goal} a @param {Goal} b */
const sameGoal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What the model is shown: short, and only what bears on choosing goals.
 * @param {Trigger} trigger
 * @param {Context} context
 */
export function describeSituation(trigger, context) {
    const s = context.snapshot;
    return JSON.stringify({
        why: trigger.kind === 'chat' ? `${trigger.from ?? 'a player'} said: ${trigger.message}`
            : trigger.kind === 'gave_up' ? `the bot gave up a goal: ${JSON.stringify(trigger.detail)}`
                : `the controller is unsure what to do next: ${JSON.stringify(trigger.detail)}`,
        inventory: s.inventory,
        health: s.hp, food: s.food, time_of_day: s.timeOfDay, dimension: s.dimension,
        current_goal: context.currentGoal ?? null,
        goals: context.goals.toJSON().goals.slice(-12).map(q => ({ goal: describeGoal(q.goal), status: q.status })),
        recent_actions: (context.recent ?? []).slice(-5),
    });
}

/**
 * @param {StrategistOptions} options
 */
export function createStrategist(options) {
    const now = options.now ?? Date.now;
    const maxPerHour = options.maxPerHour ?? 20;
    const maxGoals = options.maxGoals ?? 5;
    /** @type {Record<TriggerKind, number>} */
    const cooldownMs = { chat: 0, low_confidence: 120_000, gave_up: 60_000, ...options.cooldownMs };
    const onEvent = options.onEvent ?? (() => {});
    /** @type {number[]} */
    const calls = [];
    /** @type {Partial<Record<TriggerKind, number>>} */
    const lastAt = {};
    /** @type {Promise<Consultation | null> | null} */
    let running = null;

    /**
     * Why a consultation would not start now, or null if it can.
     * @param {TriggerKind} kind
     */
    function refusal(kind) {
        const t = now();
        while (calls.length > 0 && calls[0] <= t - 3_600_000) calls.shift();
        if (running) return 'busy';
        if (calls.length >= maxPerHour) return 'hourly limit';
        if (options.guard?.overBudget()) return 'over budget';
        if (t - (lastAt[kind] ?? -Infinity) < cooldownMs[kind]) return 'cooling down';
        return null;
    }

    /**
     * @param {Trigger} trigger
     * @param {Context} context
     * @returns {Promise<Consultation>}
     */
    async function consultNow(trigger, context) {
        const user = describeSituation(trigger, context);
        const started = now();
        /** @type {{text: string, inputTokens?: number, outputTokens?: number}} */
        let answer;
        try {
            answer = await options.complete(SYSTEM_PROMPT, user);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            options.guard?.recordSpend({ decisions: 1 }); // may be billed even though it failed
            options.telemetry?.({ kind: 'strategy', model: options.name, trigger: trigger.kind, latencyMs: now() - started, error: message });
            throw error;
        }
        const inputTokens = answer.inputTokens ?? estimateTokens(SYSTEM_PROMPT) + estimateTokens(user);
        const outputTokens = answer.outputTokens ?? estimateTokens(answer.text);
        const usd = options.price ? (inputTokens * options.price[0] + outputTokens * options.price[1]) / 1e6 : null;
        options.guard?.recordSpend({ decisions: 1, inputTokens, outputTokens, ...(usd === null ? {} : { usd }) });

        const parsed = extractJson(answer.text);
        /** @type {Consultation} */
        const result = { reply: null, accepted: [], rejected: [] };
        if (!parsed) {
            result.rejected.push({ goal: answer.text.slice(0, 200), reason: 'no JSON in the answer' });
        } else {
            result.reply = typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim().slice(0, 240) : null;
            for (const raw of Array.isArray(parsed.goals) ? parsed.goals.slice(0, maxGoals) : []) {
                const checked = validateGoal(raw, options.data);
                if ('reason' in checked) {
                    result.rejected.push({ goal: raw, reason: checked.reason });
                    continue;
                }
                const plan = planGoal(checked.goal, context.snapshot, options.data);
                if (plan.unresolved.length > 0) {
                    result.rejected.push({ goal: raw, reason: `no route to ${plan.unresolved.join(', ')}` });
                    continue;
                }
                result.accepted.push(checked.goal);
            }
        }
        options.telemetry?.({
            kind: 'strategy', model: options.name, trigger: trigger.kind, latencyMs: now() - started,
            inputTokens, outputTokens, usd, reply: result.reply,
            accepted: result.accepted.map(describeGoal), rejected: result.rejected,
        });
        return result;
    }

    /**
     * Put accepted goals in the queue: a player's request ahead of everything, in the order given; a proposal
     * of the bot's own after what it is doing now. Goals already pending are not added twice.
     * @param {Trigger} trigger
     * @param {Goal[]} goals
     * @param {GoalQueue} queue
     */
    function enqueue(trigger, goals, queue) {
        const pending = queue.toJSON().goals.filter(q => q.status === 'pending');
        const top = Math.max(0, ...pending.map(q => q.priority));
        const current = pending.length > 0 ? Math.min(...pending.map(q => q.priority)) : 0;
        /** @type {Goal[]} */
        const added = [];
        goals.forEach((goal, i) => {
            if (pending.some(q => sameGoal(q.goal, goal)) || added.some(a => sameGoal(a, goal))) return;
            const priority = trigger.kind === 'chat' ? top + goals.length - i : current - 1 - i;
            queue.add(goal, { priority });
            added.push(goal);
        });
        return added;
    }

    return {
        /** How many consultations started in the last hour. */
        get callsThisHour() {
            const t = now();
            return calls.filter(at => at > t - 3_600_000).length;
        },

        /**
         * Start a consultation in the background, unless one is running, the kind is cooling down or the budget
         * is spent. Never throws; failures are reported through onEvent.
         * @param {Trigger} trigger
         * @param {Context} context
         * @returns {Promise<Consultation | null> | null} null if it did not start
         */
        consult(trigger, context) {
            const refused = refusal(trigger.kind);
            if (refused) {
                onEvent({ type: 'strategy skipped', detail: { trigger: trigger.kind, reason: refused } });
                return null;
            }
            calls.push(now());
            lastAt[trigger.kind] = now();
            onEvent({ type: 'strategy asked', detail: { trigger: trigger.kind, message: trigger.message } });
            running = consultNow(trigger, context)
                .then(result => {
                    const added = enqueue(trigger, result.accepted, context.goals);
                    if (result.reply) options.say?.(result.reply);
                    onEvent({ type: 'strategy', detail: { trigger: trigger.kind, added: added.map(describeGoal), rejected: result.rejected, reply: result.reply } });
                    return result;
                })
                .catch(error => {
                    onEvent({ type: 'error', detail: `strategist: ${error instanceof Error ? error.message : String(error)}` });
                    if (trigger.kind === 'chat') options.say?.('Sorry, I could not think that through just now.');
                    return null;
                })
                .finally(() => {
                    running = null;
                });
            return running;
        },
    };
}
