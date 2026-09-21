// @ts-check
// Typed goals. Every goal can tell from a snapshot whether it is done, which is what lets the agent chain
// tasks on its own: finish one, move to the next, without anyone (or any model) declaring success.
import { tierRank } from './gamedata.js';

/** @typedef {import('./snapshot.js').Snapshot} Snapshot */

/**
 * @typedef {{type: 'have_item', item: string, count: number}} HaveItem
 * @typedef {{type: 'have_tool', tool: 'pickaxe' | 'axe' | 'sword' | 'shovel' | 'hoe', tier: 'wooden' | 'stone' | 'iron' | 'diamond'}} HaveTool
 *   satisfied by that tier or better
 * @typedef {{type: 'have_food', count: number}} HaveFood at least this many edible items in total
 * @typedef {HaveItem | HaveTool | HaveFood} Goal
 */

// Edible, but not something to count on (or to be fed): the same list Mindcraft's auto-eat refuses.
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken']);

/**
 * The one definition of "food" for goals, shared by isDone() and the planner so they cannot disagree.
 * @param {Snapshot} snapshot
 * @param {(item: string) => boolean} isFood fallback when the snapshot does not list its food items
 * @returns {(item: string) => boolean}
 */
export function goodFood(snapshot, isFood) {
    const listed = snapshot.foodItems ? new Set(snapshot.foodItems) : null;
    return item => !BAD_FOOD.has(item) && (listed ? listed.has(item) : isFood(item));
}

/** @param {string} item @param {number} [count] @returns {HaveItem} */
export const haveItem = (item, count = 1) => ({ type: 'have_item', item, count });
/** @param {HaveTool['tier']} tier @param {HaveTool['tool']} tool @returns {HaveTool} */
export const haveTool = (tier, tool) => ({ type: 'have_tool', tool, tier });
/** @param {number} count @returns {HaveFood} */
export const haveFood = count => ({ type: 'have_food', count });

/**
 * @param {Goal} goal
 * @param {Snapshot} snapshot
 * @param {(item: string) => boolean} isFood
 */
export function isDone(goal, snapshot, isFood) {
    const inventory = snapshot.inventory;
    switch (goal.type) {
        case 'have_item':
            return (inventory[goal.item] ?? 0) >= goal.count;
        case 'have_tool':
            return Object.keys(inventory).some(name =>
                inventory[name] > 0 && name.endsWith(`_${goal.tool}`) && tierRank(name) >= tierRank(`${goal.tier}_${goal.tool}`));
        case 'have_food': {
            const good = goodFood(snapshot, isFood);
            return Object.entries(inventory).reduce((sum, [name, n]) => sum + (good(name) ? n : 0), 0) >= goal.count;
        }
        default:
            return false; // a goal type this version does not know (e.g. restored from a newer save)
    }
}

/**
 * Short English for logs and for the model's state.
 * @param {Goal} goal
 */
export function describeGoal(goal) {
    switch (goal.type) {
        case 'have_item': return `have ${goal.count} ${goal.item}`;
        case 'have_tool': return `have ${goal.tier}_${goal.tool} or better`;
        case 'have_food': return `have ${goal.count} food`;
    }
}

/**
 * @typedef {object} QueuedGoal
 * @property {number} id
 * @property {Goal} goal
 * @property {number} priority higher first
 * @property {number | null} parent id of the goal this one serves
 * @property {'pending' | 'done' | 'failed'} status
 * @property {number} failures
 * @property {number} [failedAt] when it was given up, so it can be tried again later
 */

/** What the agent is working towards, in order. Plain data throughout, so it can be saved and restored. */
export class GoalQueue {
    /** @param {{maxFailures?: number}} [options] */
    constructor(options = {}) {
        this.maxFailures = options.maxFailures ?? 3;
        /** @type {QueuedGoal[]} */
        this.goals = [];
        this.nextId = 1;
    }

    /**
     * @param {Goal} goal
     * @param {{priority?: number, parent?: number | null}} [options]
     * @returns {number} id
     */
    add(goal, options = {}) {
        const id = this.nextId++;
        this.goals.push({ id, goal, priority: options.priority ?? 0, parent: options.parent ?? null, status: 'pending', failures: 0 });
        return id;
    }

    /**
     * The goal to pursue now: the highest-priority pending one, earliest first among equals. Note that this
     * also updates the queue: goals the snapshot shows to be done are closed on the way, so progress made by
     * any means (a player handing over a pickaxe) counts.
     * @param {Snapshot} snapshot
     * @param {(item: string) => boolean} isFood
     * @returns {QueuedGoal | null}
     */
    current(snapshot, isFood) {
        for (const queued of this.goals)
            if (queued.status === 'pending' && isDone(queued.goal, snapshot, isFood)) queued.status = 'done';
        const pending = this.goals.filter(queued => queued.status === 'pending' && !this.blockedByFailedParent(queued));
        pending.sort((a, b) => b.priority - a.priority || a.id - b.id);
        return pending[0] ?? null;
    }

    /**
     * Count a failed attempt. After `maxFailures` the goal is given up, and so are the goals that serve it:
     * the agent moves on instead of grinding at something it cannot do.
     * @param {number} id
     * @returns {boolean} true if the goal has now been given up
     */
    reportFailure(id) {
        const queued = this.goals.find(g => g.id === id);
        if (!queued || queued.status !== 'pending') return false;
        queued.failures++;
        if (queued.failures < this.maxFailures) return false;
        queued.status = 'failed';
        queued.failedAt = Date.now();
        return true;
    }

    /**
     * Give a goal up at once, whatever its failure count: the loop guard has seen it go nowhere for long enough.
     * The goals that serve it go with it, as with reportFailure().
     * @param {number} id
     * @returns {boolean} true if it was pending
     */
    giveUp(id) {
        const queued = this.goals.find(g => g.id === id);
        if (!queued || queued.status !== 'pending') return false;
        queued.status = 'failed';
        queued.failedAt = Date.now();
        return true;
    }

    /**
     * Put goals given up at least `afterMs` ago back in the queue with a clean record. What made a goal
     * impossible is often temporary (night, a mob, a bad spot), and a goal once failed would otherwise stay
     * failed for as long as the saved state lives.
     * @param {number} now
     * @param {number} afterMs
     * @returns {number} how many came back
     */
    reviveFailed(now, afterMs) {
        let revived = 0;
        for (const queued of this.goals) {
            if (queued.status !== 'failed' || now - (queued.failedAt ?? now) < afterMs) continue;
            queued.status = 'pending';
            queued.failures = 0;
            delete queued.failedAt;
            revived++;
        }
        return revived;
    }

    /**
     * Death drops the inventory, so tools and food held are gone. Put those goals back in the queue; current()
     * marks any that still hold as done again straight away. Without this a soak run that had made every stone
     * tool died once and went on to "16 torches" with nothing in its hands.
     *
     * Only tools and food: a have_item goal is often met by something since placed or used (a furnace, torches),
     * and reopening it would have the bot make it all over again after every death.
     * @returns {number} how many were reopened
     */
    reopenDone() {
        let reopened = 0;
        for (const queued of this.goals) {
            if (queued.status !== 'done' || (queued.goal.type !== 'have_tool' && queued.goal.type !== 'have_food')) continue;
            queued.status = 'pending';
            queued.failures = 0;
            reopened++;
        }
        return reopened;
    }

    /**
     * Move a goal up or down the queue.
     * @param {number} id
     * @param {number} priority
     */
    setPriority(id, priority) {
        const queued = this.goals.find(g => g.id === id);
        if (queued && Number.isFinite(priority)) queued.priority = priority;
    }

    /** Progress resets the failure count: three failures in a row give up, not three over a whole session. @param {number} id */
    reportProgress(id) {
        const queued = this.goals.find(g => g.id === id);
        if (queued) queued.failures = 0;
    }

    /** @param {QueuedGoal} queued */
    blockedByFailedParent(queued) {
        const seen = new Set();
        for (let parent = queued.parent; parent !== null;) {
            if (seen.has(parent)) return false; // a cycle; fromJSON() removes them, this is the backstop
            seen.add(parent);
            const p = this.goals.find(g => g.id === parent);
            if (!p) return false;
            if (p.status === 'failed') return true;
            parent = p.parent;
        }
        return false;
    }

    toJSON() {
        return { maxFailures: this.maxFailures, nextId: this.nextId, goals: this.goals };
    }

    /**
     * Restore a saved queue. The file may be old, hand-edited or half-written, so nothing in it is trusted:
     * malformed entries are dropped, unknown goal types are kept but marked failed, parent links that point
     * nowhere or in a circle are cut, and ids are never reused.
     * @param {unknown} data
     */
    static fromJSON(data) {
        const raw = /** @type {{maxFailures?: unknown, nextId?: unknown, goals?: unknown}} */ (data ?? {});
        const queue = new GoalQueue({ maxFailures: Number.isInteger(raw.maxFailures) && Number(raw.maxFailures) > 0 ? Number(raw.maxFailures) : undefined });
        const known = ['have_item', 'have_tool', 'have_food'];
        for (const entry of Array.isArray(raw.goals) ? raw.goals : []) {
            const g = /** @type {Partial<QueuedGoal>} */ (entry ?? {});
            if (!Number.isInteger(g.id) || !g.goal || typeof g.goal.type !== 'string' || queue.goals.some(q => q.id === g.id)) continue;
            const status = !known.includes(g.goal.type) ? 'failed' : g.status === 'done' || g.status === 'failed' ? g.status : 'pending';
            queue.goals.push({
                id: /** @type {number} */ (g.id), goal: g.goal, status,
                priority: Number.isFinite(g.priority) ? Number(g.priority) : 0,
                parent: Number.isInteger(g.parent) ? /** @type {number} */ (g.parent) : null,
                failures: Number.isInteger(g.failures) && Number(g.failures) >= 0 ? Number(g.failures) : 0,
                // a failed goal saved before failedAt existed waits a full cooldown from now
                ...(status === 'failed' ? { failedAt: Number.isFinite(g.failedAt) ? Number(g.failedAt) : Date.now() } : {}),
            });
        }
        for (const queued of queue.goals) {
            const seen = new Set([queued.id]);
            for (let parent = queued.parent; parent !== null;) {
                const p = queue.goals.find(q => q.id === parent);
                if (!p || seen.has(parent)) { queued.parent = null; break; }
                seen.add(parent);
                parent = p.parent;
            }
        }
        queue.nextId = Math.max(Number.isInteger(raw.nextId) ? Number(raw.nextId) : 1, ...queue.goals.map(q => q.id + 1));
        return queue;
    }
}
