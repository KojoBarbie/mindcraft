// @ts-check
// The loop that actually drives the bot: every second or so it looks at the world, works out what the current
// goal needs next, and asks the decision model to pick one action. It runs alongside Mindcraft's own pieces
// rather than replacing them — the reflex modes in src/agent/modes.js keep the bot alive between decisions,
// and the chosen action is an ordinary !command executed by src/agent/commands.
//
// Two things keep it responsive. A command is fired without waiting for it to finish, so the loop keeps
// ticking while the bot digs; and while something is running the only question asked is "should this stop?".
import { chooseCommand } from './choose.js';
import { listActions } from './catalog.js';
import { createKnowledge } from './knowledge.js';
import { describeGoal, isDone } from './goals.js';
import { focusFor, planGoal } from './planner.js';
import { compressState } from './state.js';
import { takeSnapshot } from './snapshot.js';

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

/** Mindcraft's commands report failure in prose; there is no status to read. */
const FAILURE = /\b(fail|failed|error|could not|couldn't|cannot|can't|unable|no such|not found|none found|timeout|timed out|invalid|don't have|do not have|not enough)\b/i;

/**
 * @typedef {object} TacticalLoopOptions
 * @property {number} [periodMs] how often to think when nothing else wakes the loop
 * @property {number} [minGapMs] never decide twice within this window, however many events arrive
 * @property {number} [lowConfidence] below this, onLowConfidence is called (a strategist can step in)
 * @property {number} [settleMs] leave a freshly started action alone for this long, and wait this long again
 *   after interrupting one. Without it a standing reason to stop (a mob that will not go away) makes the bot
 *   abandon everything it starts, over and over.
 * @property {boolean} [pauseWhenAlone] stop deciding while no human player is on the server
 * @property {number} [recentActions] how many past results to show the model
 * @property {(info: {chosen: import('./choose.js').ChosenCommand, state: unknown, goal: string}) => void} [onLowConfidence]
 * @property {(event: {type: string, detail?: unknown}) => void} [onEvent] for logging and, later, telemetry
 * @property {(command: string) => Promise<string>} [execute] injected in tests; defaults to Mindcraft's executeCommand
 */

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
        this.provider = provider;
        this.goals = goals;
        this.data = data;
        this.periodMs = options.periodMs ?? 1500;
        this.minGapMs = options.minGapMs ?? 400;
        this.lowConfidence = options.lowConfidence ?? 0.4;
        this.pauseWhenAlone = options.pauseWhenAlone ?? false;
        this.recentActions = options.recentActions ?? 3;
        this.settleMs = options.settleMs ?? 4000;
        this.onLowConfidence = options.onLowConfidence;
        this.onEvent = options.onEvent ?? (() => {});
        this.execute = options.execute;

        this.running = false;
        this.deciding = false;
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
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        for (const off of this.unbind.splice(0)) off();
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
        this.timer = setTimeout(() => this.tick(), Math.max(delayMs, this.minGapMs - since));
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

    async tick() {
        this.timer = null;
        if (!this.running || this.deciding) return;
        this.deciding = true;
        try {
            await this.decide();
        } catch (error) {
            this.onEvent({ type: 'error', detail: error instanceof Error ? error.message : String(error) });
        } finally {
            this.deciding = false;
            this.schedule(this.periodMs);
        }
    }

    async decide() {
        if (this.pauseWhenAlone && !this.anyPlayerOnline()) {
            this.onEvent({ type: 'idle', detail: 'nobody online' });
            return;
        }

        const queued = this.goals.current(this.rawSnapshot(), this.data.isFood);
        if (!queued) {
            this.onEvent({ type: 'idle', detail: 'no goals left' });
            return;
        }
        const goalText = describeGoal(queued.goal);

        // Something is already running: the only question worth asking is whether to stop it. `pendingCommand`
        // matters as much as isIdle(): a command that has been fired but has not reached the action manager
        // yet still leaves the agent "idle", and deciding again there fires the same command twice.
        if (this.pendingCommand || !this.agent.isIdle()) {
            await this.checkInterrupt(goalText);
            return;
        }

        const snapshot = this.snapshotFor(goalText);
        const plan = planGoal(queued.goal, snapshot, this.data);
        const focus = plan.steps.length > 0 ? focusFor(plan.steps[0], snapshot) : null;
        if (plan.unresolved.length > 0)
            this.onEvent({ type: 'unresolved', detail: { goal: goalText, items: plan.unresolved } });

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
        const planned = wanted && possible.has(wanted) ? wanted : null;
        const only = [...new Set([planned, ...SITUATIONAL].filter(id => id && possible.has(id)))];
        if (only.length === 0) return;

        const state = compressState(snapshot, { view: 'tactical' });
        if (focus) state.next = searching ? `find ${focus.target} first, then ${focus.text}` : focus.text;
        if (planned) state.plan_action = planned;

        const before = this.fingerprint(snapshot);
        const chosen = await chooseCommand(this.provider, ctx, state, {
            only: /** @type {string[]} */ (only),
            preset: planned && focus ? { [planned]: { target: focus.target, quantity: searching ? undefined : focus.quantity } } : undefined,
        });

        if (this.fingerprint(this.rawSnapshot()) !== before) {
            this.onEvent({ type: 'stale', detail: chosen.command });
            return;
        }
        if (chosen.confidence !== null && chosen.confidence < this.lowConfidence)
            this.onLowConfidence?.({ chosen, state, goal: goalText });

        this.lastDecisionAt = Date.now();
        this.onEvent({ type: 'decision', detail: { goal: goalText, ...chosen } });
        this.run(chosen.command, queued.id);
    }

    /**
     * Ask whether to abandon what the bot is doing. Cheap: one yes/no over a combat-shaped state.
     * @param {string} goalText
     */
    async checkInterrupt(goalText) {
        const running = this.agent.actions.currentActionLabel || this.pendingCommand;
        const settled = Math.max(this.commandStartedAt, this.lastInterruptAt) + this.settleMs;
        if (Date.now() < settled) return; // give it a moment to make progress before second-guessing it
        const snapshot = this.snapshotFor(goalText);
        const state = compressState(snapshot, { view: 'combat' });
        const result = await this.provider.decide({
            state,
            questions: [{ id: 'interrupt', type: 'noul', prompt: `The bot is busy with "${running}". Should it stop right now and do something else?` }],
        });
        const answer = result.answers.interrupt;
        this.lastDecisionAt = Date.now();
        if (answer.type !== 'noul' || !answer.value) return;
        this.lastInterruptAt = Date.now();
        this.onEvent({ type: 'interrupt', detail: { action: running, probability: answer.probability } });
        await this.agent.actions.stop();
        this.wake('interrupted');
    }

    /**
     * Fire a command and remember how it went. Deliberately not awaited by the caller: the loop has to keep
     * running while the bot works, or it could never decide to interrupt.
     * @param {string} command
     * @param {number} goalId
     */
    run(command, goalId) {
        const execute = this.execute ?? (async (/** @type {string} */ cmd) => {
            const { executeCommand } = await import('../agent/commands/index.js');
            return executeCommand(this.agent, cmd);
        });
        this.pendingCommand = command;
        this.commandStartedAt = Date.now();
        Promise.resolve(execute(command))
            .then(output => this.record(command, String(output ?? ''), goalId))
            .catch(error => this.record(command, `failed: ${error instanceof Error ? error.message : String(error)}`, goalId))
            .finally(() => {
                if (this.pendingCommand === command) this.pendingCommand = '';
                this.wake('command finished');
            });
    }

    /**
     * @param {string} command
     * @param {string} output
     * @param {number} goalId
     */
    record(command, output, goalId) {
        const ok = !FAILURE.test(output);
        this.recent.push({ cmd: command, ok, note: ok ? undefined : output.replace(/\s+/g, ' ').trim() });
        if (this.recent.length > this.recentActions) this.recent.shift();
        if (ok) this.goals.reportProgress(goalId);
        else this.goals.reportFailure(goalId);
        this.onEvent({ type: 'result', detail: { command, ok, output } });
    }

    /** @param {string} [goalText] */
    snapshotFor(goalText) {
        return takeSnapshot(this.agent.bot, {
            goal: goalText ?? null,
            recent: this.recent,
            action: this.agent.actions.currentActionLabel || this.pendingCommand
                ? { name: this.agent.actions.currentActionLabel || this.pendingCommand, elapsedMs: Date.now() - this.commandStartedAt }
                : null,
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
 *   "curriculum": "survival"                          // or omitted for no goals
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

    const goals = new GoalQueue();
    if (profile.curriculum !== 'none') loadCurriculum(goals);

    const loop = new TacticalLoop(agent, provider, goals, createGameData(agent.bot.registry), {
        ...profile.tactical,
        onEvent: event => console.log(`[tactical:${agent.name}]`, event.type, event.detail === undefined ? '' : JSON.stringify(event.detail)),
    });
    loop.start();
    return loop;
}
