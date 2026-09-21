// @ts-check
// What keeps an autonomous bot from being a liability: it notices when nothing is getting better, when it keeps
// doing the same fruitless thing, and when it has spent too much. Mindcraft's own self-prompting loop has none
// of this, and the upstream issue tracker has a report of it running up $100 in a day on one stuck task.
//
// Kept as a pure decision-maker with an injectable clock: the tactical loop asks "may I decide?", reports
// what happened, and does what it is told. Everything here is testable without a bot, a server or a model.

/**
 * @typedef {object} ProgressFacts what "getting somewhere" means, gathered by the caller each decision
 * @property {Record<string, number>} inventory
 * @property {{x: number, y: number, z: number}} pos
 * @property {string} goal the goal being worked on; a new goal is progress by definition
 */

/**
 * @typedef {object} Spend what one provider call cost, as far as anyone knows
 * @property {number} [decisions] provider requests made (retries included)
 * @property {number} [inputTokens]
 * @property {number} [outputTokens]
 * @property {number} [usd] if the provider knows; otherwise estimated from tokens and the configured prices
 */

/**
 * @typedef {object} Verdict
 * @property {'go' | 'shake' | 'pause'} action
 *   go: carry on. shake: for this one decision, do not follow the plan; try something else.
 *   pause: do not call the provider at all right now.
 * @property {string} [reason] short, for logs and for the model's state
 * @property {number} [retryAfterMs] pause only: when it is worth asking again
 * @property {string[]} [banned] commands that must not be issued right now
 */

/**
 * @typedef {object} GuardOptions
 * @property {number} [stallAfter] decisions without progress before the plan is shaken up, and again every
 *   this many after that
 * @property {number} [failAfter] decisions without progress before the goal is given up
 * @property {number} [repeatLimit] fruitless repeats of one command within the window before it is banned
 * @property {number} [repeatWindowMs]
 * @property {number} [banForMs] how long a banned command stays banned
 * @property {string[]} [repeatExempt] command prefixes never banned: waiting and self-defence are repeated by
 *   nature, and banning them mid-fight leaves the bot defenceless
 * @property {number} [cellSize] blocks; moving into a cell not visited for this goal counts as progress
 * @property {number} [maxDecisionsPerHour] 0 or undefined = no limit
 * @property {number} [maxDecisionsPerDay]
 * @property {number} [maxTokensPerHour] input + output
 * @property {number} [maxTokensPerDay]
 * @property {number} [maxUsdPerHour] needs a price: inputUsdPerMillion and/or outputUsdPerMillion
 * @property {number} [maxUsdPerDay]
 * @property {number} [inputUsdPerMillion] Jev: 0.042; gpt-5-nano: 0.05
 * @property {number} [outputUsdPerMillion] Jev: 0; gpt-5-nano: 0.40 (reasoning tokens are billed as output)
 * @property {() => number} [now] injectable clock
 */

const HOUR = 3600_000;
const DAY = 24 * HOUR;

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
        if (!(amount > 0)) return;
        // One entry per minute: a day of per-call entries runs to megabytes once saved (#11). The entry keeps
        // its first stamp, so an amount leaves the window up to a minute late, never early.
        const last = this.entries.at(-1);
        if (last && at >= last.at && at - last.at < 60_000) last.amount += amount;
        else this.entries.push({ at, amount });
        this.sum += amount;
    }

    /** @param {number} now */
    total(now) {
        const cutoff = now - this.spanMs;
        while (this.entries.length > 0 && this.entries[0].at <= cutoff) this.sum -= this.entries.shift()?.amount ?? 0;
        if (this.entries.length === 0) this.sum = 0; // do not let rounding error outlive the entries
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
        this.repeatExempt = options.repeatExempt ?? ['!stay', '!attack', '!moveAway(24)'];
        this.cellSize = options.cellSize ?? 8;
        this.now = options.now ?? Date.now;
        this.inputUsdPerMillion = options.inputUsdPerMillion ?? 0;
        this.outputUsdPerMillion = options.outputUsdPerMillion ?? 0;
        this.limits = {
            decisions: { hour: options.maxDecisionsPerHour ?? 0, day: options.maxDecisionsPerDay ?? 0 },
            tokens: { hour: options.maxTokensPerHour ?? 0, day: options.maxTokensPerDay ?? 0 },
            usd: { hour: options.maxUsdPerHour ?? 0, day: options.maxUsdPerDay ?? 0 },
        };
        // A spending cap that can never trip is worse than none: it looks like protection.
        if ((this.limits.usd.hour > 0 || this.limits.usd.day > 0) && this.inputUsdPerMillion <= 0 && this.outputUsdPerMillion <= 0)
            throw new Error('guard: maxUsdPerHour/maxUsdPerDay need a price (inputUsdPerMillion and/or outputUsdPerMillion); '
                + 'without one every call is estimated at $0 and the cap never trips. Use maxDecisionsPerDay if the price is unknown.');
        this.spent = {
            decisions: { hour: new Window(HOUR), day: new Window(DAY) },
            tokens: { hour: new Window(HOUR), day: new Window(DAY) },
            usd: { hour: new Window(HOUR), day: new Window(DAY) },
        };
        // per-goal state; see reset()
        /** @type {string | null} */
        this.goal = null;
        this.stillFor = 0;
        /** @type {Map<string, number>} */
        this.bestItems = new Map();
        /** @type {Set<string>} */
        this.visited = new Set();
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
     * Did these facts beat anything seen so far for this goal? Progress means getting better, not merely
     * different: an item count above its best, or a part of the map not visited yet. Standing still while
     * health regenerates, wobbling across a cell border, or pacing between two spots is not progress.
     * @param {ProgressFacts} facts
     */
    improved(facts) {
        const cell = [facts.pos.x, facts.pos.y, facts.pos.z].map(n => Math.floor(n / this.cellSize)).join(',');
        if (this.visited.size === 0) {
            // the state a goal starts from is the baseline, not progress
            for (const [name, count] of Object.entries(facts.inventory)) this.bestItems.set(name, count);
            this.visited.add(cell);
            return false;
        }
        let better = false;
        for (const [name, count] of Object.entries(facts.inventory)) {
            if (count > (this.bestItems.get(name) ?? 0)) {
                this.bestItems.set(name, count);
                better = true;
            }
        }
        if (!this.visited.has(cell)) {
            this.visited.add(cell);
            better = true;
        }
        return better;
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

        if (facts.goal !== this.goal) {
            this.reset();
            this.goal = facts.goal;
        }
        if (this.improved(facts)) {
            this.stillFor = 0;
            this.history = []; // repeating a command that is paying off is fine
        }
        const banned = this.bannedNow(now);
        // Shake once every `stallAfter` fruitless decisions, not on every decision after the first stall: the
        // model gets one nudge to try something else, then the plan gets another chance.
        if (this.stillFor > 0 && this.stillFor % this.stallAfter === 0)
            return { action: 'shake', reason: `nothing has improved for ${this.stillFor} decisions`, banned };
        return { action: 'go', banned };
    }

    /** Has this goal gone nowhere for long enough to give up on? */
    shouldGiveUp() {
        return this.stillFor >= this.failAfter;
    }

    /**
     * Record a decision that was acted on. Spending is recorded separately (recordSpend), per provider call.
     * @param {string} command
     * @returns {{banned?: string, repeats?: number}} whatever the caller should log
     */
    recordDecision(command) {
        const now = this.now();
        this.stillFor++;
        if (this.repeatExempt.some(prefix => command.startsWith(prefix))) return {};

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

    /** A decision round that ended without acting (everything on offer was banned) still counts as fruitless. */
    recordNoop() {
        this.stillFor++;
    }

    /**
     * Count what a provider call cost. Called for every call, including retries and calls that failed.
     * @param {Spend} [spend]
     */
    recordSpend(spend = {}) {
        const now = this.now();
        const decisions = spend.decisions ?? 1;
        const tokens = (spend.inputTokens ?? 0) + (spend.outputTokens ?? 0);
        const usd = spend.usd
            ?? ((spend.inputTokens ?? 0) * this.inputUsdPerMillion + (spend.outputTokens ?? 0) * this.outputUsdPerMillion) / 1e6;
        this.spent.decisions.hour.add(now, decisions);
        this.spent.decisions.day.add(now, decisions);
        this.spent.tokens.hour.add(now, tokens);
        this.spent.tokens.day.add(now, tokens);
        this.spent.usd.hour.add(now, usd);
        this.spent.usd.day.add(now, usd);
    }

    /** A new goal: nothing that came before says anything about it. Spending is not reset. */
    reset() {
        this.goal = null;
        this.stillFor = 0;
        this.bestItems = new Map();
        this.visited = new Set();
        this.history = [];
        this.bans = new Map();
    }

    /** @param {number} [now] */
    bannedNow(now = this.now()) {
        for (const [command, until] of this.bans) if (until <= now) this.bans.delete(command);
        return [...this.bans.keys()];
    }

    /**
     * Everything worth keeping across a restart. Spending most of all: if a crash wiped the budget windows, a bot
     * that keeps crashing would never hit its daily cap.
     */
    toJSON() {
        const now = this.now();
        const windows = /** @type {Record<string, {hour: Window, day: Window}>} */ (this.spent);
        return {
            spent: Object.fromEntries(Object.entries(windows).map(([name, w]) => {
                w.day.total(now); // drop what has aged out before saving
                return [name, w.day.entries];
            })),
            goal: this.goal,
            stillFor: this.stillFor,
            bestItems: [...this.bestItems],
            visited: [...this.visited].slice(-500),
            bans: [...this.bans],
        };
    }

    /**
     * Take state saved by toJSON(). The file may be old, hand-edited or half-written: anything that does not
     * look right is skipped rather than trusted.
     * @param {any} data
     */
    restore(data) {
        if (!data || typeof data !== 'object') return;
        const now = this.now();
        const windows = /** @type {Record<string, {hour: Window, day: Window}>} */ (this.spent);
        for (const [name, entries] of Object.entries(data.spent ?? {})) {
            if (!windows[name] || !Array.isArray(entries)) continue;
            for (const entry of entries) {
                if (!entry || !Number.isFinite(entry.at) || !Number.isFinite(entry.amount) || entry.at > now) continue;
                windows[name].day.add(entry.at, entry.amount);
                if (entry.at > now - HOUR) windows[name].hour.add(entry.at, entry.amount);
            }
        }
        if (typeof data.goal === 'string') this.goal = data.goal;
        if (Number.isInteger(data.stillFor) && data.stillFor >= 0) this.stillFor = data.stillFor;
        if (Array.isArray(data.bestItems))
            this.bestItems = new Map(data.bestItems.filter((/** @type {any} */ e) => Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1])));
        if (Array.isArray(data.visited)) this.visited = new Set(data.visited.filter((/** @type {any} */ c) => typeof c === 'string'));
        if (Array.isArray(data.bans))
            this.bans = new Map(data.bans.filter((/** @type {any} */ e) => Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1]) && e[1] > now));
    }

    /**
     * Ban a command for a while from outside, e.g. the one that was running when the agent last crashed.
     * @param {string} command
     * @param {number} [forMs]
     */
    ban(command, forMs = this.banForMs) {
        this.bans.set(command, this.now() + forMs);
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

/**
 * Wrap a provider so that every call made through it is charged to the guard: retries and failed calls
 * included, which a caller counting only successful answers would miss.
 * @template {{decide: (request: any) => Promise<any>}} P
 * @param {P} provider
 * @param {LoopGuard} guard
 * @returns {P}
 */
export function metered(provider, guard) {
    return /** @type {P} */ ({
        ...provider,
        async decide(/** @type {any} */ request) {
            try {
                const result = await provider.decide(request);
                guard.recordSpend({ decisions: result.attempts ?? 1, inputTokens: result.inputTokens ?? 0, outputTokens: result.outputTokens ?? 0 });
                return result;
            } catch (error) {
                // the request went out (and may be billed) even though no answer came back
                const attempts = /** @type {any} */ (error)?.attempts;
                guard.recordSpend({ decisions: typeof attempts === 'number' ? attempts : 1 });
                throw error;
            }
        },
    });
}
