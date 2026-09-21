// @ts-check
// Ask a real decision provider a real question a few times and show what came back and how long it took.
// Costs money for paid providers (a fraction of a cent). Keys come from keys.json.
//   node scripts/try_provider.js openai            # gpt-5-nano, minimal reasoning
//   node scripts/try_provider.js '{"provider":"openai","model":"gpt-5-mini"}' 5
//   node scripts/try_provider.js jev
import { createDecisionProvider } from '../src/decision/index.js';

const spec = process.argv[2] ?? 'openai';
const runs = Number(process.argv[3] ?? 3);
const provider = createDecisionProvider(spec.startsWith('{') ? JSON.parse(spec) : spec);

const state = { hp: 20, food: 17, time: 'day', pos: [10, 64, -4], inv: { oak_log: 3 }, blocks: { oak_log: 3, stone: 12 },
    goal: 'have wooden_pickaxe or better', next: 'craft 4 oak_planks', plan_action: 'craft' };
/** @type {import('../src/decision/types.js').Question[]} */
const questions = [
    { id: 'action', type: 'choice', prompt: 'Pick the single best next action for the bot, given its goal.', options: ['craft', 'collect_blocks', 'explore', 'wait'] },
    { id: 'danger', type: 'noul', prompt: 'Is the bot in immediate danger?' },
];

console.log(`provider: ${provider.name}`);
/** @type {number[]} */
const times = [];
for (let i = 0; i < runs; i++) {
    const started = performance.now();
    try {
        const { answers, inputTokens } = await provider.decide({ state, questions });
        const ms = performance.now() - started;
        times.push(ms);
        const action = /** @type {any} */ (answers.action);
        const danger = /** @type {any} */ (answers.danger);
        console.log(`${String(i + 1).padStart(2)}  ${ms.toFixed(0).padStart(5)} ms  action=${action.value} (confidence ${action.confidence})  danger=${danger.probability}  input tokens=${inputTokens}`);
    } catch (error) {
        console.log(`${String(i + 1).padStart(2)}  error: ${error instanceof Error ? error.message : String(error)}`);
    }
}
if (times.length > 0) {
    times.sort((a, b) => a - b);
    console.log(`p50 ${times[Math.floor(times.length / 2)].toFixed(0)} ms, fastest ${times[0].toFixed(0)} ms, slowest ${times.at(-1)?.toFixed(0)} ms`);
}
