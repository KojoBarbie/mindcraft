// @ts-check
// The default ladder for an agent with nothing better to do: a survival progression, as data. Each rung is a
// goal with an isDone(), so a bot dropped into any world state starts at the first rung it has not reached.
import { haveFood, haveItem, haveTool } from './goals.js';

/** @typedef {import('./goals.js').Goal} Goal */

/** @type {{goal: Goal, why: string}[]} */
export const SURVIVAL_CURRICULUM = [
    { goal: haveTool('wooden', 'pickaxe'), why: 'first tool; needed to mine stone' },
    { goal: haveTool('stone', 'pickaxe'), why: 'needed to mine iron' },
    { goal: haveTool('stone', 'sword'), why: 'to survive the first night' },
    { goal: haveTool('stone', 'axe'), why: 'faster wood' },
    { goal: haveItem('furnace'), why: 'to smelt iron and cook food' },
    { goal: haveFood(8), why: 'hunger stops health regeneration' },
    { goal: haveItem('torch', 16), why: 'light keeps mobs from spawning' },
    { goal: haveTool('iron', 'pickaxe'), why: 'needed to mine diamonds' },
    { goal: haveTool('iron', 'sword'), why: 'real damage' },
    { goal: haveItem('shield'), why: 'blocks most attacks' },
    { goal: haveItem('iron_chestplate'), why: 'armor' },
    { goal: haveItem('iron_helmet'), why: 'armor' },
    { goal: haveItem('iron_leggings'), why: 'armor' },
    { goal: haveItem('iron_boots'), why: 'armor' },
    { goal: haveTool('diamond', 'pickaxe'), why: 'end of the basic progression' },
];

/**
 * Fill a queue with the curriculum; earlier rungs get higher priority.
 * @param {import('./goals.js').GoalQueue} queue
 * @param {{goal: Goal}[]} [curriculum]
 */
export function loadCurriculum(queue, curriculum = SURVIVAL_CURRICULUM) {
    curriculum.forEach((rung, index) => queue.add(rung.goal, { priority: curriculum.length - index }));
    return queue;
}
