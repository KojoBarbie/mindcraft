// @ts-check
// What keeps an autonomous bot from being a liability: it notices when nothing is changing, when it is doing
// the same thing over and over, and when it has spent too much. Mindcraft's own self-prompting loop has none
// of this, and the upstream issue tracker has a report of it running up $100 in a day on one stuck task.
//
// Kept as a pure decision-maker with an injectable clock: the tactical loop asks "may I decide?", reports
// what happened, and does what it is told. Everything here is testable without a bot, a server or a model.

/**
 * @typedef {object} ProgressFacts what "getting somewhere" means, gathered by the caller each decision
 * @property {Record<string, number>} inventory
 * @property {{x: number, y: number, z: number}} pos
 * @property {number} hp
 * @property {number} food
 * @property {string} goal the goal being worked on; a new goal is progress by definition
 */

/**
 * @typedef {object} Spend
 * @property {number} [decisions] provider calls made for this decision
 * @property {number} [inputTokens]
 * @property {number} [usd] estimated cost
 */

/**
 * @typedef {object} Verdict
 * @property {'go' | 'shake' | 'pause'} action
 *   go: carry on. shake: stop following the plan for one decision and try something else.
 *   pause: do not decide at all right now.
 * @property {string} [reason] short, for logs and for the model's state
 * @property {number} [retryAfterMs] pause only: when it is worth asking again
 * @property {string[]} [banned] commands that must not be offered right now
 */

/**
 * @typedef {object} GuardOptions
 * @property {number} [stallAfter] decisions with no progress before the plan is shaken up
 * @property {number} [failAfter] decisions with no progress before the goal is given up
 * @property {number} [repeatLimit] identical commands within the window before that command is banned
 * @property {number} [repeatWindowMs]
 * @property {number} [banForMs] how long a banned command stays banned
 * @property {number} [maxDecisionsPerHour] 0 or undefined = no limit
 * @property {number} [maxDecisionsPerDay]
 * @property {number} [maxTokensPerHour]
 * @property {number} [maxTokensPerDay]
 * @property {number} [maxUsdPerHour]
 * @property {number} [maxUsdPerDay]
 * @property {number} [inputUsdPerMillion] price used to estimate usd when a provider reports only tokens
 *   (Jev: 0.042). Output is not counted: Jev does not charge for it, and #10 measures the rest
 * @property {() => number} [now] injectable clock
 */

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/**
 * Two positions are "the same place" unless the bot has actually gone somewhere. Rounding keeps idle drift,
 * mob shoving and pathfinder jitter from reading as progress.
 * @param {ProgressFacts} facts
 */
function progressKey(facts) {
    const inventory = Object.entries(facts.inventory)
        .filter(([, count]) => count > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => `${name}:${count}`)
        .join(',');
    const pos = [facts.pos.x, facts.pos.y, facts.pos.z].map(n => Math.round(n / 8)).join(',');
    return `${facts.goal}|${inventory}|${pos}|${Math.round(facts.hp)}|${Math.round(facts.food)}`;
}

/** A rolling window of stamped amounts, for "how much in the last hour / day". */
class Window {
    /** @param {number} spanMs */
    constructor(spanMs) {
        this.spanMs = spanMs;
        /** @type {{at: number, amount: number}[]} */
        this.entries = [];
        this.sum = 0;
    }

    /** @param {number} at @param {number} amount */
    add(at, amount) {
        if (amount <= 0) return;
        this.entries.push({ at, amount });
        this.sum += amount;
    }

    /** @param {number} now */
    total(now) {
        const cutoff = now - this.spanMs;
        let dropped = 0;
        while (this.entries.length > 0 && this.entries[0].at <= cutoff) dropped += (this.entries.shift()?.amount ?? 0);
        this.sum -= dropped;
        return this.sum;
    }

    /** When the oldest entry falls out of the window, freeing room. @param {number} now */
    nextFreeAt(now) {
        return this.entries.length > 0 ? this.entries[0].at + this.spanMs - now : 0;
    }
}

export class LoopGuard {
    /** @param {GuardOptions} [options] */
    constructor(options = {}) {
        this.stallAfter = options.stallAfter ?? 6;
        this.failAfter = options.failAfter ?? 12;
        this.repeatLimit = options.repeatLimit ?? 3;
        this.repeatWindowMs = options.repeatWindowMs ?? 60_000;
        this.banForMs = options.banForMs ?? 120_000;
        this.now = options.now ?? Date.now;
        this.inputUsdPerMillion = options.inputUsdPerMillion ?? 0;
        this.limits = {
            decisions: { hour: options.maxDecisionsPerHour ?? 0, day: options.maxDecisionsPerDay ?? 0 },
            tokens: { hour: options.maxTokensPerHour ?? 0, day: options.maxTokensPerDay ?? 0 },
            usd: { hour: options.maxUsdPerHour ?? 0, day: options.maxUsdPerDay ?? 0 },
        };
        this.spent = {
            decisions: { hour: new Window(HOUR), day: new Window(DAY) },
            tokens: { hour: new Window(HOUR), day: new Window(DAY) },
            usd: { hour: new Window(HOUR), day: new Window(DAY) },
        };

        /** @type {string | null} */
        this.lastKey = null;
        this.stillFor = 0;
        /** @type {{cmd: string, at: number}[]} */
        this.history = [];
        /** @type {Map<string, number>} command -> banned until */
        this.bans = new Map();
    }

    /**
     * Is any budget used up? Checked before every provider call, including the cheap "should this stop?"
     * question, which costs as much per request as a real decision.
     * @returns {Verdict | null} a pause verdict, or null if there is room
     */
    overBudget() {
        const now = this.now();
        for (const [name, limit] of Object.entries(this.limits)) {
            const spent = /** @type {Record<string, {hour: Window, day: Window}>} */ (this.spent)[name];
            for (const span of /** @type {const} */ (['hour', 'day'])) {
                const cap = /** @type {Record<string, number>} */ (limit)[span];
                if (cap > 0 && spent[span].total(now) >= cap) {
                    return {
                        action: 'pause',
                        reason: `${name} budget for the ${span} reached (${cap})`,
                        retryAfterMs: Math.max(1000, spent[span].nextFreeAt(now)),
                        banned: this.bannedNow(now),
                    };
                }
            }
        }
        return null;
    }

    /**
     * May the loop decide now, and under what restrictions?
     * @param {ProgressFacts} facts
     * @returns {Verdict}
     */
    check(facts) {
        const now = this.now();
        const paused = this.overBudget();
        if (paused) return paused;

        const key = progressKey(facts);
        if (key !== this.lastKey) {
            this.lastKey = key;
            this.stillFor = 0;
        }
        const banned = this.bannedNow(now);
        if (this.stillFor >= this.stallAfter)
            return { action: 'shake', reason: `nothing has changed for ${this.stillFor} decisions`, banned };
        return { action: 'go', banned };
    }

    /** Has this goal been stuck long enough to give up on? Checked after check() returns 'shake'. */
    shouldGiveUp() {
        return this.stillFor >= this.failAfter;
    }

    /**
     * Record a decision that was acted on. `spend` is what the provider reported.
     * @param {string} command
     * @param {Spend} [spend]
     * @returns {{banned?: string, repeats?: number}} whatever the caller should log
     */
    recordDecision(command, spend = {}) {
        const now = this.now();
        this.stillFor++;
        this.recordSpend(spend);

        this.history.push({ cmd: command, at: now });
        const cutoff = now - this.repeatWindowMs;
        while (this.history.length > 0 && this.history[0].at <= cutoff) this.history.shift();
        const repeats = this.history.filter(entry => entry.cmd === command).length;
        if (repeats >= this.repeatLimit && !this.bans.has(command)) {
            this.bans.set(command, now + this.banForMs);
            return { banned: command, repeats };
        }
        return { repeats };
    }

    /**
     * Count what a provider call cost, without it counting as a decision taken (the interrupt question).
     * @param {Spend} [spend]
     */
    recordSpend(spend = {}) {
        const now = this.now();
        const decisions = spend.decisions ?? 1;
        const tokens = spend.inputTokens ?? 0;
        const usd = spend.usd ?? (tokens * this.inputUsdPerMillion) / 1e6;
        this.spent.decisions.hour.add(now, decisions);
        this.spent.decisions.day.add(now, decisions);
        this.spent.tokens.hour.add(now, tokens);
        this.spent.tokens.day.add(now, tokens);
        this.spent.usd.hour.add(now, usd);
        this.spent.usd.day.add(now, usd);
    }

    /** The goal changed or finished: nothing that came before says anything about the new one. */
    reset() {
        this.lastKey = null;
        this.stillFor = 0;
        this.history = [];
        this.bans.clear();
    }

    /** @param {number} [now] */
    bannedNow(now = this.now()) {
        for (const [command, until] of this.bans) if (until <= now) this.bans.delete(command);
        return [...this.bans.keys()];
    }

    /** What has been spent, for logs and for #10. */
    usage() {
        const now = this.now();
        return {
            decisions: { hour: this.spent.decisions.hour.total(now), day: this.spent.decisions.day.total(now) },
            tokens: { hour: this.spent.tokens.hour.total(now), day: this.spent.tokens.day.total(now) },
            usd: { hour: this.spent.usd.hour.total(now), day: this.spent.usd.day.total(now) },
            stillFor: this.stillFor,
        };
    }
}
