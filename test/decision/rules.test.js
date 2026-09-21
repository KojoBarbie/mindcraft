// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRulesProvider, validateAnswers } from '../../src/decision/index.js';

const provider = createRulesProvider();
/** @param {string[]} options */
const action = options => ({ id: 'action', type: /** @type {const} */ ('choice'), prompt: 'What next?', options });
const interrupt = { id: 'stop', type: /** @type {const} */ ('noul'), prompt: 'Stop now?' };

/** @param {unknown} state @param {import('../../src/decision/types.js').Question[]} questions */
async function ask(state, questions) {
    const { answers } = await provider.decide({ state, questions });
    validateAnswers(questions, answers);
    return answers;
}

test('it follows the plan when nothing is wrong', async () => {
    const state = { hp: 20, food: 20, plan_action: 'craft' };
    assert.equal((await ask(state, [action(['collect_blocks', 'craft', 'explore', 'wait'])])).action.value, 'craft');
});

test('danger comes first: fight while healthy, run when not', async () => {
    const choices = action(['collect_blocks', 'attack', 'flee', 'eat', 'wait']);
    const near = { zombie: { n: 1, d: 4 } };
    // a creeper at arm's length is an emergency at full health too, not only once the bar is low
    assert.equal((await ask({ hp: 20, mobs: near, plan_action: 'collect_blocks' }, [choices])).action.value, 'attack');
    assert.equal((await ask({ hp: 12, mobs: near, plan_action: 'collect_blocks' }, [choices])).action.value, 'attack');
    assert.equal((await ask({ hp: 5, mobs: near, plan_action: 'collect_blocks' }, [choices])).action.value, 'flee');
    // a mob across the field is not a reason to stop working
    assert.equal((await ask({ hp: 5, mobs: { zombie: { n: 1, d: 30 } }, plan_action: 'collect_blocks' }, [choices])).action.value, 'collect_blocks');
});

test('hunger is next, but only if eating is on offer', async () => {
    const hungry = { hp: 20, food: 6, plan_action: 'collect_blocks' };
    assert.equal((await ask(hungry, [action(['collect_blocks', 'eat', 'wait'])])).action.value, 'eat');
    assert.equal((await ask(hungry, [action(['collect_blocks', 'wait'])])).action.value, 'collect_blocks');
});

test('with no plan it keeps busy rather than standing still', async () => {
    assert.equal((await ask({ hp: 20, food: 20 }, [action(['wait', 'explore', 'collect_blocks'])])).action.value, 'collect_blocks');
    assert.equal((await ask({}, [action(['wait', 'explore'])])).action.value, 'explore');
    // a plan naming something not on offer must not stall the loop either
    assert.equal((await ask({ plan_action: 'smelt' }, [action(['wait'])])).action.value, 'wait');
});

test('it only interrupts what the bot is doing when something is actually wrong', async () => {
    const calm = await ask({ hp: 20, food: 20 }, [interrupt]);
    assert.equal(calm.stop.value, false);
    const cornered = await ask({ hp: 20, food: 20, mobs: { creeper: { n: 1, d: 3 } } }, [interrupt]);
    assert.equal(cornered.stop.value, true);
    const hungry = await ask({ hp: 20, food: 2 }, [interrupt]);
    assert.equal(hungry.stop.value, false); // there may be nothing to eat; the loop handles it when idle
});

test('unusable state does not throw; score questions get the middle of the range', async () => {
    const answers = await ask(null, [action(['wait']), { id: 'risk', type: 'score', prompt: 'How risky?', min: 0, max: 10 }]);
    assert.equal(answers.action.value, 'wait');
    assert.equal(answers.risk.value, 5);
});
