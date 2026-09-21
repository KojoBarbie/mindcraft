// @ts-check
// The loop that actually drives the bot: every second or so it looks at the world, works out what the current
// goal needs next, and asks the decision model to pick one action. It runs alongside Mindcraft's own pieces
// rather than replacing them — the reflex modes in src/agent/modes.js keep the bot alive between decisions,
// and the chosen action is an ordinary !command executed by src/agent/commands.
//
// Two things keep it responsive. A command is fired without waiting for it to finish, so the loop keeps
// ticking while the bot digs; and while something is running the only question asked is "should this stop?".
import { chooseCommand } from './choose.js';
import { buildCommand, listActions, listQuantities, maxQuantity } from './catalog.js';
import { createKnowledge } from './knowledge.js';
import { describeGoal, isDone } from './goals.js';
import { focusFor, planGoal } from './planner.js';
import { compressState } from './state.js';
import { takeSnapshot } from './snapshot.js';
import { LoopGuard, metered } from './guard.js';
import { STATE_VERSION, fingerprint, loadJSON, saveJSON } from './persistence.js';
import { RECORDED_EVENTS, createTelemetry, describeCall, estimateUsd } from './telemetry.js';

/** @typedef {import('./snapshot.js').Snapshot} Snapshot */
/** @typedef {import('./snapshot.js').RecentAction} RecentAction */
/** @typedef {import('./goals.js').GoalQueue} GoalQueue */
/** @typedef {import('./gamedata.js').GameData} GameData */

/**
 * Actions the bot may take at any time, whatever the plan says. The planner's own action is added to these,
 * so the model is choosing between "get on with the goal" and "deal with what is in front of me".
 */
const SITUATIONAL = ['eat', 'flee', 'attack', 'take_from_furnace', 'go_to_surface', 'explore', 'wait'];

/** Looking for the thing the plan needs beats wandering: !moveAway happily walks into a cave. */
const SEARCH_FOR = { collect_blocks: 'search_for_block', attack: 'search_for_entity' };

/**
 * Mindcraft's commands report in prose, with no status to read, and the prose is not a reliable signal on its
 * own: skills.goToPosition logs "Path not found, but attempting to navigate anyway" on the way to succeeding.
 * So failure words are only believed when nothing actually improved, and that phrase is cut out first.
 */
const FAILURE = /\b(fail|failed|error|could not|couldn't|cannot|can't|unable|no such|none found|timed out|invalid|don't have|do not have|not enough)\b/i;
const BENIGN = /Path not found, but attempting to navigate anyway[^.]*\.?/gi;

/**
 * @typedef {object} ProgressSignature
 * @property {Record<string, number>} inventory
 * @property {{x: number, y: number, z: number}} pos
 * @property {number} hp
 * @property {number} food
 */

/**
 * @typedef {object} TacticalLoopOptions
 * @property {number} [periodMs] how often to think when nothing else wakes the loop
 * @property {number} [minGapMs] never decide twice within this window, however many events arrive
 * @property {number} [lowConfidence] below this, onLowConfidence is called (a strategist can step in)
 * @property {number} [settleMs] leave a freshly started action alone for this long, and wait this long again
 *   after interrupting one. Without it a standing reason to stop (a mob that will not go away) makes the bot
 *   abandon everything it starts, over and over.
 * @property {number} [commandTimeoutMs] give up waiting on a command that never comes back
 * @property {number} [stuckGoalMs] how long a goal may stay unplannable before it counts as a failure
 * @property {boolean} [pauseWhenAlone] stop deciding while no human player is on the server
 * @property {number} [recentActions] how many past results to show the model
 * @property {(info: {chosen: import('./choose.js').ChosenCommand, state: unknown, goal: string}) => void} [onLowConfidence]
 * @property {(event: {type: string, detail?: unknown}) => void} [onEvent] for logging and, later, telemetry
 * @property {(command: string) => Promise<string>} [execute] injected in tests; defaults to Mindcraft's executeCommand
 * @property {LoopGuard} [guard] stall and repeat detection and budgets; a default one if omitted
 * @property {string} [statePath] where to save the loop's state so a restarted agent carries on; unset = not saved
 * @property {string} [goalsFingerprint] what the profile asked for, saved alongside so a changed profile starts afresh
 * @property {number} [crashBanMs] how long to ban the command that was running when the agent last crashed
 * @property {number} [retryFailedAfterMs] a goal given up is tried again after this long
 * @property {(record: Record<string, unknown>) => void} [telemetry] receives every provider call and the loop's
 *   notable events (see telemetry.js); unset = nothing recorded
 */

// What Mindcraft says when it kills the agent because an action wedged it (modes.js unstuck, action_manager.js),
// as opposed to a kick, a lost connection or a restart asked for from the UI.
const WEDGED = /stuck|refused stop|infinite action loop/i;

/**
 * @param {string} reason the message Mindcraft passed to agent.cleanKill()
 * @returns {{reason: string, wedged: boolean}}
 */
export function exitInfo(reason) {
    return { reason, wedged: WEDGED.test(reason) };
}

/**
 * The command a planned action would issue, to check it against the guard's bans before paying to ask.
 * @param {import('./catalog.js').CatalogContext} ctx
 * @param {string} id
 * @param {{target?: string, quantity?: number}} preset
 */
function buildPlannedCommand(ctx, id, preset) {
    try {
        const quantities = listQuantities(ctx, id, preset.target);
        const quantity = quantities.length > 0 ? Math.min(preset.quantity ?? quantities[0], maxQuantity(ctx, id, preset.target)) : undefined;
        return buildCommand(ctx, { id, target: preset.target, quantity });
    } catch {
        return '';
    }
}

export class TacticalLoop {
    /**
     * @param {any} agent a Mindcraft Agent (bot, isIdle(), actions, name)
     * @param {{decide: (request: import('./types.js').DecisionRequest) => Promise<import('./types.js').DecisionResult>}} provider
     * @param {GoalQueue} goals
     * @param {GameData} data
     * @param {TacticalLoopOptions} [options]
     */
    constructor(agent, provider, goals, data, options = {}) {
        this.agent = agent;
        this.goals = goals;
        this.data = data;
        this.periodMs = options.periodMs ?? 1500;
        this.minGapMs = options.minGapMs ?? 400;
        this.lowConfidence = options.lowConfidence ?? 0.4;
        this.pauseWhenAlone = options.pauseWhenAlone ?? false;
        this.recentActions = options.recentActions ?? 3;
        this.settleMs = options.settleMs ?? 4000;
        this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
        this.stuckGoalMs = options.stuckGoalMs ?? 60_000;
        this.onLowConfidence = options.onLowConfidence;
        const onEvent = options.onEvent ?? (() => {});
        const telemetry = options.telemetry;
        /** @type {{goal: string, command: string, confidence: number | null, latencyMs: number, provider?: string, at: number} | null} */
        this.lastDecision = null;
        this.currentGoal = '';
        /** @param {{type: string, detail?: any}} event */
        this.onEvent = event => {
            if (event.type === 'decision') {
                const d = event.detail;
                this.lastDecision = { goal: d.goal, command: d.command, confidence: d.confidence, latencyMs: d.latencyMs, provider: d.provider, at: Date.now() };
            }
            onEvent(event);
            if (telemetry && RECORDED_EVENTS.has(event.type)) telemetry({ kind: 'event', type: event.type, detail: event.detail });
        };
        this.execute = options.execute;
        this.guard = options.guard ?? new LoopGuard();
        this.statePath = options.statePath;
        this.goalsFingerprint = options.goalsFingerprint ?? '';
        this.crashBanMs = options.crashBanMs ?? 5 * 60_000;
        this.retryFailedAfterMs = options.retryFailedAfterMs ?? 30 * 60_000;
        this.restarts = 0;
        this.lastSavedAt = 0;
        /** @type {{cmd: string, at: number, endedAt: number | null} | null} the last command fired, for crash blame */
        this.lastFired = null;
        // Every call through the loop is charged to the guard, retries and failures included.
        this.provider = metered(provider, this.guard, telemetry && (call => {
            const result = call.result;
            const usage = { inputTokens: result?.inputTokens ?? null, outputTokens: result?.outputTokens ?? null };
            const name = result?.provider ?? /** @type {any} */ (provider).name ?? 'unknown';
            const price = this.guard.priced ? { inputUsdPerMillion: this.guard.inputUsdPerMillion, outputUsdPerMillion: this.guard.outputUsdPerMillion } : {};
            telemetry({
                kind: 'call',
                provider: name,
                questions: describeCall(call.request.questions ?? [], result?.answers),
                latencyMs: call.latencyMs,
                ...usage,
                attempts: result?.attempts ?? /** @type {any} */ (call.error)?.attempts ?? 1,
                usd: result ? estimateUsd(name, usage, price) : null,
                ...(call.error ? { error: call.error instanceof Error ? call.error.message : String(call.error) } : {}),
            });
        }));
        /** @type {number | null} the goal the guard's counters are about */
        this.guardGoalId = null;

        this.running = false;
        this.deciding = false;
        this.dead = false;
        this.lastDecisionAt = 0;
        /** @type {RecentAction[]} */
        this.recent = [];
        /** @type {NodeJS.Timeout | null} */
        this.timer = null;
        /** @type {(() => void)[]} */
        this.unbind = [];
        /** Set while a command fired by this loop is still running; see decide(). */
        this.pendingCommand = '';
        this.commandStartedAt = 0;
        this.lastInterruptAt = 0;
        /** A command this loop cut short itself: neither its own success nor its own failure. */
        this.interruptedCommand = '';
        this.stopping = false;
        // Bumped by stop(). Anything that was waiting on an answer when the loop stopped must not act on it.
        this.epoch = 0;
        /** @type {Map<number, number>} goal id -> since when it has had no workable plan */
        this.stuckSince = new Map();
        this.heldUntil = 0;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.bindEvents();
        this.onEvent({ type: 'start' });
        this.schedule(0);
    }

    async stop() {
        this.running = false;
        this.epoch++;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        for (const off of this.unbind.splice(0)) off();
        this.persist(true);
        this.onEvent({ type: 'stop' });
        while (this.deciding) await new Promise(resolve => setTimeout(resolve, 50));
    }

    /** Think now rather than at the next tick. */
    wake(reason = 'event') {
        if (!this.running) return;
        this.onEvent({ type: 'wake', detail: reason });
        this.schedule(0);
    }

    /** @param {number} delayMs */
    schedule(delayMs) {
        if (!this.running) return;
        if (this.timer) clearTimeout(this.timer);
        const since = Date.now() - this.lastDecisionAt;
        const held = Math.max(0, this.heldUntil - Date.now());
        this.timer = setTimeout(() => this.tick(), Math.max(delayMs, this.minGapMs - since, held));
    }

    /**
     * Do not tick again before `ms` from now, whatever wakes the loop in between. Used while a budget is used up.
     * @param {number} ms
     */
    holdUntil(ms) {
        this.heldUntil = Date.now() + ms;
    }

    bindEvents() {
        const bot = this.agent.bot;
        /** @param {string} event @param {(...args: any[]) => void} handler */
        const on = (event, handler) => {
            bot.on(event, handler);
            this.unbind.push(() => bot.removeListener(event, handler));
        };
        on('idle', () => this.wake('action finished'));       // an action ended: decide what is next
        on('health', () => this.wake('health changed'));      // hurt or healed: the situation may have changed
        on('sunset', () => this.wake('sunset'));
        on('sunrise', () => this.wake('sunrise'));
        on('chat', (/** @type {string} */ username) => { if (username !== this.agent.name) this.wake('chat'); });
        // Deciding while dead means planning around an inventory that is lying on the ground somewhere.
        on('death', () => {
            this.dead = true;
            this.pendingCommand = '';
            this.onEvent({ type: 'death' });
        });
        on('respawn', () => {
            this.dead = false;
            this.wake('respawn');
        });
        // The agent process usually exits with the connection, but stop cleanly if it does not.
        on('end', () => { void this.stop(); });
    }

    /** Human players other than this bot and its siblings. */
    anyPlayerOnline() {
        const bots = new Set([this.agent.name, ...(this.agent.bot.modes?.getBotNames?.() ?? [])]);
        return Object.keys(this.agent.bot.players ?? {}).some(name => !bots.has(name));
    }

    /**
     * What changed since a question was asked. A decision made about a world that has moved on is worse than
     * no decision: the bot would walk to where a zombie used to be.
     * @param {Snapshot} snapshot
     */
    fingerprint(snapshot) {
        const { x, y, z } = snapshot.pos;
        return [Math.round(x), Math.round(y), Math.round(z), Math.round(snapshot.hp), this.agent.actions.currentActionLabel].join('|');
    }

    /** @param {Snapshot} snapshot @returns {ProgressSignature} */
    progressSignature(snapshot) {
        return { inventory: { ...snapshot.inventory }, pos: snapshot.pos, hp: snapshot.hp, food: snapshot.food };
    }

    /**
     * Did the command achieve anything? Judged from the world rather than from the wording of the reply:
     * more of some item, a restored bar, or having actually travelled.
     * @param {ProgressSignature} before
     */
    madeProgress(before) {
        const now = this.rawSnapshot();
        if (Object.entries(now.inventory).some(([name, count]) => count > (before.inventory[name] ?? 0))) return true;
        if (now.food > before.food || now.hp > before.hp) return true;
        return Math.hypot(now.pos.x - before.pos.x, now.pos.z - before.pos.z) > 3;
    }

    /** A command that never comes back would otherwise wedge the loop in "something is running" for ever. */
    checkCommandTimeout() {
        if (!this.pendingCommand || Date.now() - this.commandStartedAt < this.commandTimeoutMs) return;
        this.onEvent({ type: 'command timeout', detail: this.pendingCommand });
        this.interruptedCommand = this.pendingCommand;
        this.pendingCommand = '';
        void this.stopAction();
    }

    /**
     * Ask the action manager to stop, without waiting on it indefinitely. ActionManager.stop() spins until the
     * running code yields and kills the whole process after 10 s, so the loop must not sit inside it.
     */
    async stopAction() {
        if (this.stopping) return;
        this.stopping = true;
        try {
            await Promise.race([
                this.agent.actions.stop(),
                new Promise(resolve => setTimeout(resolve, 5000)),
            ]);
        } catch (error) {
            this.onEvent({ type: 'error', detail: `stop failed: ${error instanceof Error ? error.message : String(error)}` });
        } finally {
            this.stopping = false;
        }
    }

    async tick() {
        this.timer = null;
        if (!this.running || this.deciding) return;
        this.deciding = true;
        try {
            this.checkCommandTimeout();
            await this.decide();
            this.persist();
        } catch (error) {
            this.onEvent({ type: 'error', detail: error instanceof Error ? error.message : String(error) });
        } finally {
            this.deciding = false;
            this.schedule(this.periodMs);
        }
    }

    async decide() {
        if (this.dead) return;
        const epoch = this.epoch;
        if (this.pauseWhenAlone && !this.anyPlayerOnline()) {
            this.onEvent({ type: 'idle', detail: 'nobody online' });
            return;
        }

        // Budgets apply to every provider call, the cheap interrupt question included.
        const paused = this.guard.overBudget();
        if (paused) {
            this.onEvent({ type: 'paused', detail: { reason: paused.reason, retryAfterMs: paused.retryAfterMs } });
            this.holdUntil(paused.retryAfterMs ?? this.periodMs);
            return;
        }

        const revived = this.goals.reviveFailed(Date.now(), this.retryFailedAfterMs);
        if (revived > 0) this.onEvent({ type: 'retrying failed goals', detail: { count: revived } });
        const queued = this.goals.current(this.rawSnapshot(), this.data.isFood);
        if (!queued) {
            this.onEvent({ type: 'idle', detail: 'no goals left' });
            return;
        }
        const goalText = describeGoal(queued.goal);
        this.currentGoal = goalText;
        if (queued.id !== this.guardGoalId) {
            this.guard.reset(); // a new goal starts with a clean slate
            this.guardGoalId = queued.id;
        }

        // Something is already running: the only question worth asking is whether to stop it. `pendingCommand`
        // matters as much as isIdle(): a command that has been fired but has not reached the action manager
        // yet still leaves the agent "idle", and deciding again there fires the same command twice.
        if (this.pendingCommand || !this.agent.isIdle()) {
            await this.checkInterrupt(goalText);
            return;
        }

        const snapshot = this.snapshotFor(goalText);
        const verdict = this.guard.check({ inventory: snapshot.inventory, pos: snapshot.pos, goal: goalText });
        if (verdict.action === 'shake' && this.guard.shouldGiveUp()) {
            // Commands keep "succeeding" and nothing changes: the #810 failure mode. Move on.
            this.goals.giveUp(queued.id);
            this.onEvent({ type: 'gave up', detail: { goal: goalText, reason: verdict.reason } });
            this.guard.reset();
            this.guardGoalId = null;
            return;
        }
        const plan = planGoal(queued.goal, snapshot, this.data);
        const focus = plan.steps.length > 0 ? focusFor(plan.steps[0], snapshot) : null;
        if (this.noteStuck(queued.id, plan.unresolved, goalText)) return; // given up: the next tick takes the next goal

        // When the planned target is out of sight, offer "go and look for it" in place of the step itself.
        const searching = focus && !focus.inSight ? SEARCH_FOR[/** @type {keyof typeof SEARCH_FOR} */ (focus.action)] : undefined;
        const ctx = {
            snapshot,
            knowledge: createKnowledge(this.agent.bot, snapshot),
            wanted: searching && focus?.target
                ? (searching === 'search_for_block' ? { blocks: [focus.target] } : { entities: [focus.target] })
                : undefined,
        };
        const possible = new Set(listActions(ctx).map(action => action.id));
        const wanted = searching ?? (focus && focus.inSight ? focus.action : null);
        // Shaking: the plan has been followed for a while with nothing to show for it, so for one decision it
        // is not on offer and the model has to try something else.
        const shaking = verdict.action === 'shake';
        const banned = new Set(verdict.banned ?? []);
        const presetFor = /** @param {string} id */ id => ({ target: focus?.target, quantity: searching ? undefined : focus?.quantity });
        let planned = wanted && possible.has(wanted) && !shaking ? wanted : null;
        // A banned planned command is dropped before asking, not after: a paid call that picks it would be wasted.
        if (planned && banned.has(buildPlannedCommand(ctx, planned, presetFor(planned)))) planned = null;
        let only = [...new Set([planned, ...SITUATIONAL].filter(id => id && possible.has(id)))];
        if (shaking) this.onEvent({ type: 'shake', detail: { goal: goalText, reason: verdict.reason } });
        if (only.length === 0) return;

        const state = compressState(snapshot, { view: 'tactical' });
        if (focus) state.next = searching ? `find ${focus.target} first, then ${focus.text}` : focus.text;
        if (planned) state.plan_action = planned;
        if (shaking) state.stuck = verdict.reason;

        const before = this.fingerprint(snapshot);
        const preset = planned && focus ? { [planned]: presetFor(planned) } : undefined;
        let chosen = await chooseCommand(this.provider, ctx, state, { only: /** @type {string[]} */ (only), preset });
        // The model can still land on a banned command through a situational action. Take that action off
        // the table and ask once more; if that is banned too, the round was fruitless and counts as such.
        if (banned.has(chosen.command)) {
            this.onEvent({ type: 'banned pick', detail: chosen.command });
            only = only.filter(id => id !== chosen.action);
            if (only.length > 0) chosen = await chooseCommand(this.provider, ctx, state, { only: /** @type {string[]} */ (only) });
            if (only.length === 0 || banned.has(chosen.command)) {
                this.guard.recordNoop();
                return;
            }
        }

        if (epoch !== this.epoch) return;
        if (this.fingerprint(this.rawSnapshot()) !== before) {
            this.onEvent({ type: 'stale', detail: chosen.command });
            return;
        }
        if (chosen.confidence !== null && chosen.confidence < this.lowConfidence)
            this.onLowConfidence?.({ chosen, state, goal: goalText });

        this.lastDecisionAt = Date.now();
        this.onEvent({ type: 'decision', detail: { goal: goalText, ...chosen } });
        const repeat = this.guard.recordDecision(chosen.command);
        if (repeat.banned) this.onEvent({ type: 'banned', detail: { command: repeat.banned, repeats: repeat.repeats } });
        // While a goal has no workable plan the bot is only casting about for the missing piece. Letting that
        // count as progress would reset the counter that eventually gives the goal up.
        this.run(chosen.command, queued.id, this.progressSignature(snapshot), epoch, plan.unresolved.length === 0);
    }

    /**
     * A goal the planner cannot find a route for produces no steps at all, so the bot would otherwise wander
     * for ever without anything counting against it. Give it a while to find the missing piece, then treat the
     * goal as failed so the queue can move on.
     * @param {number} goalId
     * @param {string[]} unresolved
     * @param {string} goalText
     * @returns {boolean} true if the goal has now been given up
     */
    noteStuck(goalId, unresolved, goalText) {
        if (unresolved.length === 0) {
            this.stuckSince.delete(goalId);
            return false;
        }
        const since = this.stuckSince.get(goalId);
        if (since === undefined) {
            this.stuckSince.set(goalId, Date.now());
            this.onEvent({ type: 'unresolved', detail: { goal: goalText, items: unresolved } });
            return false;
        }
        if (Date.now() - since < this.stuckGoalMs) return false;
        this.stuckSince.delete(goalId);
        const givenUp = this.goals.reportFailure(goalId);
        this.onEvent({ type: 'stuck', detail: { goal: goalText, items: unresolved, givenUp } });
        return givenUp;
    }

    /**
     * Ask whether to abandon what the bot is doing. Cheap: one yes/no over a combat-shaped state.
     * @param {string} goalText
     */
    async checkInterrupt(goalText) {
        const epoch = this.epoch;
        const label = this.agent.actions.currentActionLabel;
        // Only ever second-guess a command this loop fired. Anything else running is Mindcraft's reflex layer
        // (mode:unstuck, mode:self_preservation, ...), which exists to act without asking. Stopping it is
        // actively harmful: unstuck arms a 10 s timer that kills the whole process if the bot is still stuck,
        // so interrupting it turns "stuck for a moment" into a crash-and-restart loop.
        if (!this.pendingCommand || (label && !label.startsWith('action:'))) return;
        const running = label || this.pendingCommand;
        const settled = Math.max(this.commandStartedAt, this.lastInterruptAt) + this.settleMs;
        if (Date.now() < settled) return; // give it a moment to make progress before second-guessing it
        const snapshot = this.snapshotFor(goalText);
        // the goal is part of the picture: without it a model sees "collecting logs" and asks "why?"
        const state = { ...compressState(snapshot, { view: 'combat' }), goal: goalText };
        const result = await this.provider.decide({
            state,
            questions: [{
                id: 'interrupt', type: 'noul',
                prompt: `The bot is busy with "${running}" as part of its goal. Is there an emergency that means it must `
                    + 'stop right now, such as a hostile mob attacking, very low health, lava, or drowning? '
                    + 'Answer no if it is safe to carry on.',
            }],
        });
        const answer = result.answers.interrupt;
        this.lastDecisionAt = Date.now();
        if (epoch !== this.epoch || answer.type !== 'noul' || !answer.value) return;
        this.lastInterruptAt = Date.now();
        this.interruptedCommand = this.pendingCommand;
        this.onEvent({ type: 'interrupt', detail: { action: running, probability: answer.probability } });
        await this.stopAction();
        this.wake('interrupted');
    }

    /**
     * Fire a command and remember how it went. Deliberately not awaited by the caller: the loop has to keep
     * running while the bot works, or it could never decide to interrupt.
     * @param {string} command
     * @param {number} goalId
     * @param {ProgressSignature} before
     * @param {number} [epoch]
     * @param {boolean} [countsTowardGoal] whether the outcome says anything about the goal's reachability
     */
    run(command, goalId, before, epoch = this.epoch, countsTowardGoal = true) {
        const execute = this.execute ?? (async (/** @type {string} */ cmd) => {
            const { executeCommand } = await import('../agent/commands/index.js');
            return executeCommand(this.agent, cmd);
        });
        this.pendingCommand = command;
        this.commandStartedAt = Date.now();
        const fired = { cmd: command, at: this.commandStartedAt, endedAt: /** @type {number | null} */ (null) };
        this.lastFired = fired;
        // Saved before it runs: if this command wedges the agent and Mindcraft kills the process, the restarted
        // agent needs to know what it was doing.
        this.persist(true);
        Promise.resolve(execute(command))
            .then(output => this.record(command, String(output ?? ''), goalId, before, epoch, countsTowardGoal))
            .catch(error => this.record(command, `failed: ${error instanceof Error ? error.message : String(error)}`, goalId, before, epoch, countsTowardGoal))
            .finally(() => {
                fired.endedAt = Date.now();
                if (this.pendingCommand === command) this.pendingCommand = '';
                this.wake('command finished');
            });
    }

    /**
     * @param {string} command
     * @param {string} output
     * @param {number} goalId
     * @param {ProgressSignature} before
     * @param {number} [epoch]
     * @param {boolean} [countsTowardGoal]
     */
    record(command, output, goalId, before, epoch = this.epoch, countsTowardGoal = true) {
        if (epoch !== this.epoch) return; // the loop was stopped while this command was running
        const progressed = this.madeProgress(before);
        const said = output.replace(BENIGN, '').replace(/\s+/g, ' ').trim();

        // A command this loop cut short, and one that came back with nothing to show for itself, say nothing
        // about whether the goal is reachable. Counting either would make the three-strikes rule meaningless.
        const inconclusive = !countsTowardGoal || this.interruptedCommand === command || (!progressed && said === '');
        if (this.interruptedCommand === command) this.interruptedCommand = '';

        const ok = progressed || !FAILURE.test(said);
        this.recent.push({ cmd: command, ok: ok || inconclusive, note: ok || inconclusive ? undefined : said });
        if (this.recent.length > this.recentActions) this.recent.shift();

        if (!inconclusive) {
            if (ok) this.goals.reportProgress(goalId);
            else this.goals.reportFailure(goalId);
        }
        this.onEvent({ type: 'result', detail: { command, ok, progressed, inconclusive, output: said } });
        this.persist();
    }

    /**
     * Save the state to `statePath`, at most every ten seconds unless forced.
     * @param {boolean} [force]
     * @param {{clean?: boolean, exit?: {reason: string, wedged: boolean}}} [options]
     */
    persist(force = false, options = {}) {
        if (!this.statePath) return;
        const now = Date.now();
        if (!force && now - this.lastSavedAt < 10_000) return;
        this.lastSavedAt = now;
        try {
            saveJSON(this.statePath, this.stateSnapshot(options));
        } catch (error) {
            this.onEvent({ type: 'error', detail: `could not save state: ${error instanceof Error ? error.message : String(error)}` });
        }
    }

    /**
     * The command to blame if the process is dying now: the one running, or one that ended moments ago. The
     * unstuck mode and ActionManager.stop() first interrupt the action (so it has already "ended") and kill the
     * process 10 s later if the bot is still stuck.
     */
    suspect() {
        if (this.pendingCommand) return this.pendingCommand;
        const last = this.lastFired;
        if (last && (last.endedAt === null || Date.now() - last.endedAt <= 20_000)) return last.cmd;
        return null;
    }

    /**
     * @param {{clean?: boolean, exit?: {reason: string, wedged: boolean}}} [options] clean: shut down on purpose;
     *   exit: why the process is ending, saved from the exit handler
     */
    stateSnapshot(options = {}) {
        return {
            version: STATE_VERSION,
            savedAt: Date.now(),
            clean: options.clean === true,
            ...(options.exit ? { exit: options.exit } : {}),
            goalsFingerprint: this.goalsFingerprint,
            goals: this.goals.toJSON(),
            guard: this.guard.toJSON(),
            loop: {
                recent: this.recent,
                stuckSince: [...this.stuckSince],
                restarts: this.restarts,
                guardGoalId: this.guardGoalId,
                suspect: options.clean ? null : this.suspect(),
            },
        };
    }

    /**
     * Carry on from a saved state. If Mindcraft killed the agent moments ago because an action wedged it, the
     * command it was running is the prime suspect and is banned for a while instead of being tried again from
     * the same spot. Any other ending (a stop, a kick, a lost connection) is just a resume.
     * @param {any} saved from stateSnapshot()
     * @param {{recentMs?: number, goalsRestored?: boolean}} [options] goalsRestored: false when the goal queue
     *   was rebuilt, so ids in the saved state point at other goals now
     */
    restoreState(saved, options = {}) {
        if (!saved || saved.version !== STATE_VERSION) return;
        const goalsRestored = options.goalsRestored ?? true;
        const age = Math.max(0, Date.now() - (Number.isFinite(saved.savedAt) ? saved.savedAt : 0));
        this.guard.restore(saved.guard);
        const loop = saved.loop ?? {};
        if (Array.isArray(loop.recent))
            this.recent = loop.recent.filter((/** @type {any} */ r) => r && typeof r.cmd === 'string').slice(-this.recentActions);
        if (goalsRestored) {
            if (Number.isInteger(loop.guardGoalId)) this.guardGoalId = loop.guardGoalId; // else the guard's per-goal state is reset at once
            // the time spent down does not count towards "stuck for too long"
            if (Array.isArray(loop.stuckSince))
                this.stuckSince = new Map(loop.stuckSince
                    .filter((/** @type {any} */ e) => Array.isArray(e) && Number.isInteger(e[0]) && Number.isFinite(e[1]))
                    .map((/** @type {[number, number]} */ [id, since]) => [id, since + age]));
        }
        this.restarts = Number.isInteger(loop.restarts) && loop.restarts >= 0 ? loop.restarts : 0;
        if (saved.clean !== true && saved.exit?.wedged === true && age <= (options.recentMs ?? 90_000)) {
            this.restarts++;
            const suspect = typeof loop.suspect === 'string' && loop.suspect ? loop.suspect : null;
            if (suspect) this.guard.ban(suspect, this.crashBanMs);
            this.onEvent({ type: 'restored after crash', detail: { restarts: this.restarts, reason: saved.exit.reason, bannedSuspect: suspect, ageMs: age } });
        } else {
            this.onEvent({ type: 'restored', detail: { ageMs: age, exit: saved.clean ? 'stopped' : saved.exit?.reason ?? 'unknown' } });
        }
    }

    /** For the MindServer dashboard: what the loop is doing and what it has spent. */
    status() {
        return {
            goal: this.currentGoal || null,
            running: this.pendingCommand || null,
            lastDecision: this.lastDecision,
            usage: this.guard.usage(),
            restarts: this.restarts,
            goals: this.goals.toJSON().goals.map(q => ({ goal: describeGoal(q.goal), status: q.status })),
        };
    }

    /** @param {string} [goalText] */
    snapshotFor(goalText) {
        const running = this.agent.actions.currentActionLabel || this.pendingCommand;
        return takeSnapshot(this.agent.bot, {
            goal: goalText ?? null,
            recent: this.recent,
            action: running ? { name: running, elapsedMs: Date.now() - this.commandStartedAt } : null,
        });
    }

    /** Cheap enough to take on every tick; used where only the inventory matters. */
    rawSnapshot() {
        return takeSnapshot(this.agent.bot, { blockRange: 0, entityRange: 0 });
    }
}

/**
 * Start a tactical loop for an agent, if its profile asks for one. Called from the agent's spawn handler; with
 * no `decision_model` in the profile it does nothing and Mindcraft behaves exactly as before.
 *
 *   "decision_model": "rules",                       // no API key needed
 *   "decision_options": {"timeoutMs": 2000},
 *   "tactical": {"periodMs": 1500, "pauseWhenAlone": false},
 *   "guard": {"maxUsdPerDay": 1, "inputUsdPerMillion": 0.042, "stallAfter": 6, "failAfter": 12},
 *   "goals": [{"type": "have_item", "item": "torch", "count": 16}],   // or omit for the survival ladder
 *   "curriculum": "none"                              // no goals at all
 *
 * @param {any} agent
 * @returns {Promise<TacticalLoop | null>}
 */
export async function attachTacticalLoop(agent) {
    const profile = agent.prompter?.profile ?? {};
    if (!profile.decision_model) return null;

    const [{ createDecisionProviderFromProfile }, { createGameData }, { GoalQueue }, { loadCurriculum }] = await Promise.all([
        import('./registry.js'), import('./gamedata.js'), import('./goals.js'), import('./curriculum.js'),
    ]);
    const provider = createDecisionProviderFromProfile(profile);
    if (!provider) return null;

    const statePath = `./bots/${agent.name}/decision_state.json`;
    const saved = loadJSON(statePath);
    const goalsFingerprint = fingerprint({ goals: profile.goals ?? null, curriculum: profile.curriculum ?? null });
    const sameGoals = saved?.version === STATE_VERSION && saved.goalsFingerprint === goalsFingerprint && saved.goals;

    const goals = sameGoals ? GoalQueue.fromJSON(saved.goals) : new GoalQueue();
    if (sameGoals) {
        // carrying on where it left off, failed goals and all
    } else if (Array.isArray(profile.goals)) {
        // explicit goals, in priority order: what a server operator asks the bot to do
        const known = ['have_item', 'have_tool', 'have_food'];
        profile.goals.forEach((/** @type {any} */ goal, /** @type {number} */ index) => {
            if (goal && known.includes(goal.type)) goals.add(goal, { priority: profile.goals.length - index });
            else console.warn(`[tactical:${agent.name}] ignoring goal ${JSON.stringify(goal)}: unknown type`);
        });
    } else if (profile.curriculum !== 'none') {
        loadCurriculum(goals);
    }

    const loop = new TacticalLoop(agent, provider, goals, createGameData(agent.bot.registry), {
        ...profile.tactical,
        guard: new LoopGuard(profile.guard ?? {}),
        statePath,
        goalsFingerprint,
        telemetry: profile.telemetry === false ? undefined : createTelemetry(`./bots/${agent.name}/decisions.jsonl`, {
            onError: error => console.warn(`[tactical:${agent.name}] telemetry write failed:`, error instanceof Error ? error.message : error),
        }),
        onEvent: event => console.log(`[tactical:${agent.name}]`, event.type, event.detail === undefined ? '' : JSON.stringify(event.detail)),
    });
    // budgets and bans carry over even when the goals were rebuilt
    loop.restoreState(saved, { goalsRestored: Boolean(sameGoals) });
    // Mindcraft ends the agent through agent.cleanKill(reason) (a wedged action, a kick, a lost connection, a
    // restart from the UI) and with SIGINT when told to stop. Only the reason tells a wedge from the rest.
    let stopping = false;
    let exitReason = 'exited without a reason';
    const cleanKill = agent.cleanKill.bind(agent);
    agent.cleanKill = (/** @type {string | undefined} */ msg, /** @type {number | undefined} */ code) => {
        exitReason = msg ?? 'Killing agent process...';
        return cleanKill(msg, code);
    };
    process.once('exit', () => {
        if (!stopping) loop.persist(true, { exit: exitInfo(exitReason) });
    });
    process.once('SIGINT', () => {
        stopping = true;
        loop.persist(true, { clean: true });
        process.exit(0);
    });
    loop.start();
    return loop;
}
