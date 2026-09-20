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
                inventory[name] > 0 && name.endsWith(`_${goal.tool}`) && tierRank(name) >= tierRank(`${goal.tier}_${goal.tool}`) && tierRank(name) < 6);
        case 'have_food': {
            const foods = snapshot.foodItems ? new Set(snapshot.foodItems) : null;
            const total = Object.entries(inventory).reduce((sum, [name, n]) => sum + ((foods ? foods.has(name) : isFood(name)) ? n : 0), 0);
            return total >= goal.count;
        }
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
     * The goal to pursue now: the highest-priority pending one, earliest first among equals. Goals the
     * snapshot shows to be done are closed on the way, so progress made by any means counts.
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
        return true;
    }

    /** Progress resets the failure count: three failures in a row give up, not three over a whole session. @param {number} id */
    reportProgress(id) {
        const queued = this.goals.find(g => g.id === id);
        if (queued) queued.failures = 0;
    }

    /** @param {QueuedGoal} queued */
    blockedByFailedParent(queued) {
        for (let parent = queued.parent; parent !== null;) {
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

    /** @param {ReturnType<GoalQueue['toJSON']>} data */
    static fromJSON(data) {
        const queue = new GoalQueue({ maxFailures: data.maxFailures });
        queue.nextId = data.nextId;
        queue.goals = data.goals.map(g => ({ ...g }));
        return queue;
    }
}
