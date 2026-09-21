// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcdata from 'minecraft-data';
import { GoalQueue, LoopGuard, TacticalLoop, createGameData, createRulesProvider, haveItem, haveTool, resilient } from '../../src/decision/index.js';

const registry = mcdata('1.21.6');
const data = createGameData(registry);
const tick = () => new Promise(resolve => setImmediate(resolve));
/** @param {number} ms */
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** @param {number} x @param {number} y @param {number} z */
function vec(x, y, z) {
    return { x, y, z, distanceTo: (/** @type {{x: number, y: number, z: number}} */ o) => Math.hypot(x - o.x, y - o.y, z - o.z) };
}

/**
 * A stand-in for a Mindcraft agent: a real event emitter, a bot with the surface the decision layer reads,
 * and a record of every command the loop fires.
 * @param {{inventory?: Record<string, number>, world?: string[], mobs?: string[], hp?: number, food?: number, players?: string[]}} [setup]
 */
function fakeAgent(setup = {}) {
    const bot = Object.assign(new EventEmitter(), {
        entity: { position: vec(0.5, 64, 0.5), isInWater: false },
        entities: Object.fromEntries((setup.mobs ?? []).map((name, i) => [i, { type: 'hostile', kind: 'Hostile mobs', name, position: vec(3.5, 64, 0.5) }])),
        players: Object.fromEntries((setup.players ?? []).map(name => [name, {}])),
        health: setup.hp ?? 20, food: setup.food ?? 20, oxygenLevel: 20, isRaining: false,
        time: { timeOfDay: 1000 }, game: { dimension: 'overworld' }, heldItem: null, registry,
        inventory: {
            items: () => Object.entries(setup.inventory ?? {}).filter(([, n]) => n > 0).map(([name, count]) => ({ name, count })),
            slots: {},
        },
        /** @param {{matching: number | number[], maxDistance: number, count: number}} query */
        findBlocks(query) {
            const ids = [query.matching].flat();
            return (setup.world ?? [])
                .filter(name => registry.blocksByName[name] && ids.includes(registry.blocksByName[name].id))
                .slice(0, query.count)
                .map((_, i) => vec(2 + i, 64, 0));
        },
        /** @param {{x: number}} position */
        blockAt: position => ({ name: (setup.world ?? [])[position.x - 2] ?? 'air' }),
        /** @returns {any[]} */
        recipesFor: () => [{}],
    });
    /** @type {string[]} */
    const commands = [];
    const agent = {
        name: 'tester', bot, commands,
        actions: { currentActionLabel: '', executing: false, stop: () => { agent.actions.executing = false; return Promise.resolve(); } },
        isIdle: () => !agent.actions.executing,
    };
    return agent;
}

/**
 * @param {ReturnType<typeof fakeAgent>} agent
 * @param {Partial<import('../../src/decision/tactical_loop.js').TacticalLoopOptions>} [options]
 * @param {import('../../src/decision/goals.js').Goal[]} [goals]
 */
function loopFor(agent, options = {}, goals = [haveTool('wooden', 'pickaxe')]) {
    const queue = new GoalQueue();
    for (const goal of goals) queue.add(goal);
    /** @type {{type: string, detail?: any}[]} */
    const events = [];
    const loop = new TacticalLoop(agent, resilient([createRulesProvider()]), queue, data, {
        periodMs: 20, minGapMs: 0,
        execute: command => { agent.commands.push(command); return Promise.resolve('ok'); },
        onEvent: event => events.push(event),
        ...options,
    });
    return { loop, queue, events };
}

test('one tick turns a goal into a command the catalog would allow', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    const { loop, events } = loopFor(agent);
    await loop.decide();
    await tick();
    assert.deepEqual(agent.commands, ['!collectBlocks("oak_log", 3)']);
    const decision = events.find(event => event.type === 'decision');
    assert.equal(decision?.detail.goal, 'have wooden_pickaxe or better');
    assert.equal(decision?.detail.decisions, 1); // the planner supplies target and quantity, so only one question
});

test('the plan advances as the inventory fills: logs, then planks, then the pickaxe', async () => {
    /** @type {Record<string, number>} */
    const inventory = {};
    const agent = fakeAgent({ world: ['oak_log'], inventory });
    const { loop } = loopFor(agent);
    /** @param {Record<string, number>} gained */
    const after = async gained => {
        Object.assign(inventory, gained);
        await loop.decide();
        await tick();
    };
    await after({});
    await after({ oak_log: 3 });
    await after({ oak_planks: 12, oak_log: 0 });
    await after({ crafting_table: 1, oak_planks: 8 });
    assert.deepEqual(agent.commands, [
        '!collectBlocks("oak_log", 3)', '!craftRecipe("oak_planks", 3)', '!craftRecipe("crafting_table", 1)', '!craftRecipe("stick", 1)',
    ]);
    // and once it is done, the goal closes and the loop moves on instead of repeating
    Object.assign(inventory, { wooden_pickaxe: 1 });
    await loop.decide();
    await tick();
    assert.ok(!agent.commands.at(-1)?.includes('wooden_pickaxe'));
});

test('a target that is out of sight is searched for, not wandered towards', async () => {
    const agent = fakeAgent({ world: [], inventory: { stone_pickaxe: 1, crafting_table: 1, stick: 2, coal: 1, furnace: 1 } });
    const { loop } = loopFor(agent, {}, [haveItem('iron_ingot')]);
    await loop.decide();
    await tick();
    // !moveAway would do just as well at walking into a cave; searchForBlock goes to the ore
    assert.deepEqual(agent.commands, ['!searchForBlock("iron_ore", 64)']);
});

test('an animal that is out of sight is searched for too', async () => {
    const agent = fakeAgent({ world: [] });
    const { loop } = loopFor(agent, {}, [haveItem('leather', 2)]);
    await loop.decide();
    await tick();
    assert.deepEqual(agent.commands, ['!searchForEntity("cow", 64)']);
});

test('while an action is running the loop only asks whether to stop', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    agent.actions.executing = true;
    agent.actions.currentActionLabel = 'action:collectBlocks';
    const { loop, events } = loopFor(agent, { settleMs: 0 });
    loop.pendingCommand = '!collectBlocks("oak_log", 3)';
    await loop.decide();
    assert.deepEqual(agent.commands, []);
    assert.equal(events.some(event => event.type === 'interrupt'), false);

    // now it is in danger: the same question comes back yes, and the action is stopped
    Object.assign(agent.bot, { health: 5, entities: { 0: { type: 'hostile', kind: 'Hostile mobs', name: 'zombie', position: vec(2.5, 64, 0.5) } } });
    await loop.decide();
    assert.ok(events.some(event => event.type === 'interrupt'));
    assert.equal(agent.actions.executing, false);
});

test('reflex modes are never interrupted, only commands this loop fired', async () => {
    // Mindcraft's unstuck mode kills the whole process if it is stopped while the bot is still stuck
    const agent = fakeAgent({ world: ['oak_log'], hp: 3, mobs: ['zombie'] }); // an emergency, if it were asked
    agent.actions.executing = true;
    agent.actions.currentActionLabel = 'mode:unstuck';
    let asked = 0;
    const provider = { decide: (/** @type {any} */ request) => { asked++; return resilient([createRulesProvider()]).decide(request); } };
    const queue = new GoalQueue();
    queue.add(haveTool('wooden', 'pickaxe'));
    const loop = new TacticalLoop(agent, provider, queue, data, { settleMs: 0 });
    loop.pendingCommand = '!collectBlocks("oak_log", 3)'; // even with a command of ours pending underneath
    loop.commandStartedAt = Date.now() - 60_000;
    await loop.decide();
    assert.equal(asked, 0);
    assert.equal(agent.actions.executing, true);

    // the same emergency during our own command is a different story
    agent.actions.currentActionLabel = 'action:collectBlocks';
    await loop.decide();
    assert.equal(asked, 1);
    assert.equal(agent.actions.executing, false);
});

test('the interrupt question carries the goal and asks about emergencies only', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    agent.actions.executing = true;
    agent.actions.currentActionLabel = 'action:collectBlocks';
    /** @type {any[]} */
    const requests = [];
    const provider = { decide: (/** @type {any} */ request) => { requests.push(request); return resilient([createRulesProvider()]).decide(request); } };
    const queue = new GoalQueue();
    queue.add(haveTool('wooden', 'pickaxe'));
    const loop = new TacticalLoop(agent, provider, queue, data, { settleMs: 0 });
    loop.pendingCommand = '!collectBlocks("oak_log", 3)';
    await loop.decide();
    assert.equal(requests[0].state.goal, 'have wooden_pickaxe or better');
    assert.match(requests[0].questions[0].prompt, /emergency/);
    assert.match(requests[0].questions[0].prompt, /safe to carry on/);
});

test('hunger alone never aborts an action: there may be nothing to eat', async () => {
    const agent = fakeAgent({ world: ['oak_log'], food: 3 });
    agent.actions.executing = true;
    agent.actions.currentActionLabel = 'action:collectBlocks';
    const { loop, events } = loopFor(agent, { settleMs: 0 });
    loop.pendingCommand = '!collectBlocks("oak_log", 3)';
    await loop.decide();
    assert.equal(events.some(event => event.type === 'interrupt'), false);
    assert.equal(agent.actions.executing, true);
});

test('a freshly started action is left alone, and an interrupted one is not hounded', async () => {
    const agent = fakeAgent({ world: ['oak_log'], hp: 4, mobs: ['zombie'] });
    const { loop, events } = loopFor(agent, { settleMs: 5000 });
    await loop.decide();            // fires a command; nothing is running yet
    await tick();
    agent.actions.executing = true; // the action manager picks it up
    agent.actions.currentActionLabel = 'action:flee';
    loop.pendingCommand = '!moveAway(24)'; // and it is still ours, running
    await loop.decide();            // within settleMs of starting: not questioned
    assert.equal(events.some(event => event.type === 'interrupt'), false);

    loop.commandStartedAt = Date.now() - 6000;
    await loop.decide();
    assert.equal(events.filter(event => event.type === 'interrupt').length, 1);
    agent.actions.executing = true;
    loop.pendingCommand = '!moveAway(24)';
    await loop.decide();            // still in danger, but it just interrupted: leave it be
    assert.equal(events.filter(event => event.type === 'interrupt').length, 1);
});

test('an answer about a world that has moved on is thrown away', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    const slow = {
        decide: (/** @type {any} */ request) => {
            agent.bot.entity.position = vec(40.5, 64, 0.5); // the bot walked off while we were thinking
            return resilient([createRulesProvider()]).decide(request);
        },
    };
    const queue = new GoalQueue();
    queue.add(haveTool('wooden', 'pickaxe'));
    /** @type {{type: string}[]} */
    const events = [];
    const loop = new TacticalLoop(agent, slow, queue, data, {
        execute: command => { agent.commands.push(command); return Promise.resolve('ok'); },
        onEvent: event => events.push(event),
    });
    await loop.decide();
    assert.deepEqual(agent.commands, []);
    assert.ok(events.some(event => event.type === 'stale'));
});

test('a shaky decision is handed to whoever is listening, and still carried out', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    const unsure = { decide: (/** @type {any} */ request) => Promise.resolve({
        answers: Object.fromEntries(request.questions.map((/** @type {any} */ q) => [q.id, { type: 'choice', value: q.options[0], confidence: 0.2 }])),
        inputTokens: null, provider: 'unsure', latencyMs: 1, attempts: 1,
    }) };
    const queue = new GoalQueue();
    queue.add(haveTool('wooden', 'pickaxe'));
    /** @type {any[]} */
    const flagged = [];
    const loop = new TacticalLoop(agent, /** @type {any} */ (unsure), queue, data, {
        lowConfidence: 0.5,
        execute: command => { agent.commands.push(command); return Promise.resolve('ok'); },
        onLowConfidence: info => flagged.push(info),
    });
    await loop.decide();
    await tick();
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].goal, 'have wooden_pickaxe or better');
    assert.equal(agent.commands.length, 1);
});

test('failures are remembered, shown to the model, and counted against the goal', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    const { loop, queue } = loopFor(agent, { execute: () => Promise.resolve('Failed to collect oak_log: Timeout: Took to long to decide path to goal!') });
    await loop.decide();
    await tick();
    assert.deepEqual(loop.recent, [{ cmd: '!collectBlocks("oak_log", 3)', ok: false, note: 'Failed to collect oak_log: Timeout: Took to long to decide path to goal!' }]);
    assert.equal(queue.goals[0].failures, 1);

    loop.execute = () => Promise.resolve('Collected 3 oak_log.');
    await loop.decide();
    await tick();
    assert.equal(queue.goals[0].failures, 0); // progress wipes the slate
    assert.equal(loop.recent.at(-1)?.ok, true);
});

test('commands are not awaited, so the loop can still decide to interrupt', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    let finish = () => {};
    const { loop } = loopFor(agent, { execute: () => new Promise(resolve => { finish = () => resolve('ok'); }) });
    await loop.decide();
    assert.equal(loop.pendingCommand, '!collectBlocks("oak_log", 3)'); // decide() returned while it runs
    finish();
    await tick();
    assert.equal(loop.pendingCommand, '');
});

test('a command already in flight is never fired twice, even before the agent looks busy', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    let finish = () => {};
    // the real agent only reports itself busy once the action manager has picked the command up, a few
    // milliseconds after executeCommand is called; until then isIdle() is still true
    const { loop, events } = loopFor(agent, {
        execute: command => new Promise(resolve => { agent.commands.push(command); finish = () => resolve('ok'); }),
    });
    await loop.decide();
    await loop.decide();
    await loop.decide();
    assert.deepEqual(agent.commands, ['!collectBlocks("oak_log", 3)']);
    assert.equal(events.filter(event => event.type === 'decision').length, 1);

    finish();
    await tick();
    await loop.decide();
    assert.equal(agent.commands.length, 2);
});

test('with nobody online the loop can be told to sit still', async () => {
    const agent = fakeAgent({ world: ['oak_log'], players: ['tester'] });
    const { loop, events } = loopFor(agent, { pauseWhenAlone: true });
    await loop.decide();
    assert.deepEqual(agent.commands, []);
    assert.equal(events.at(-1)?.detail, 'nobody online');

    agent.bot.players.tomo = {};
    await loop.decide();
    await tick();
    assert.equal(agent.commands.length, 1);
});

test('when every goal is met the loop stops deciding instead of flailing', async () => {
    const agent = fakeAgent({ inventory: { oak_log: 9 } });
    const { loop, events } = loopFor(agent, {}, [haveItem('oak_log', 3)]);
    await loop.decide();
    assert.deepEqual(agent.commands, []);
    assert.equal(events.at(-1)?.detail, 'no goals left');
});

test('start/stop: ticks run on a timer and on events, and stop leaves no timers behind', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    // In this fake world nothing ever changes, so a real guard would (rightly) ban the repeated command and
    // give the goal up. This test is about timing only.
    const lenient = new LoopGuard({ repeatLimit: 1e9, stallAfter: 1e9, failAfter: 1e9 });
    const { loop } = loopFor(agent, { periodMs: 15, guard: lenient });
    loop.start();
    try {
        await wait(60);
        const onTimer = agent.commands.length;
        assert.ok(onTimer >= 2, `only ${onTimer} ticks`);

        agent.bot.emit('idle'); // an action finished: decide at once rather than waiting out the period
        await wait(5);
        assert.ok(agent.commands.length > onTimer);
    } finally {
        await loop.stop();
    }
    const afterStop = agent.commands.length;
    await wait(50);
    assert.equal(agent.commands.length, afterStop);
    assert.equal(agent.bot.listenerCount('idle'), 0);
});

test('a success is not read as a failure just because the reply mentions "not found"', async () => {
    // skills.goToPosition says this on its way to succeeding; three of them used to bury a goal for good
    const agent = fakeAgent({ world: [], inventory: { stone_pickaxe: 1, crafting_table: 1, stick: 2, coal: 1, furnace: 1 } });
    const { loop, queue, events } = loopFor(agent, {
        execute: command => {
            agent.commands.push(command);
            agent.bot.entity.position = vec(40.5, 64, 0.5); // it walked somewhere: that is the progress
            return Promise.resolve('Action output:\nPath not found, but attempting to navigate anyway.\nFound iron_ore.');
        },
    }, [haveItem('iron_ingot')]);
    await loop.decide();
    await tick();
    assert.equal(events.at(-1)?.detail.ok, true);
    assert.equal(queue.goals[0].failures, 0);
    assert.equal(loop.recent.at(-1)?.ok, true);
});

test('a real failure is still a failure, and the reason reaches the model', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    const { loop, queue } = loopFor(agent, { execute: () => Promise.resolve('Failed to collect oak_log: no path.') });
    await loop.decide();
    await tick();
    assert.equal(queue.goals[0].failures, 1);
    assert.deepEqual(loop.recent.at(-1), { cmd: '!collectBlocks("oak_log", 3)', ok: false, note: 'Failed to collect oak_log: no path.' });
});

test('an action this loop cut short counts neither way', async () => {
    const agent = fakeAgent({ world: ['oak_log'], hp: 4, mobs: ['zombie'] });
    const { loop, queue } = loopFor(agent, { settleMs: 0, execute: () => Promise.resolve('') });
    await loop.decide();                    // fires a command
    await tick();
    const after = queue.goals[0].failures;
    agent.actions.executing = true;
    loop.pendingCommand = '!collectBlocks("oak_log", 3)';
    loop.commandStartedAt = Date.now() - 10_000;
    await loop.decide();                    // danger: interrupts it
    loop.record('!collectBlocks("oak_log", 3)', '', queue.goals[0].id, { inventory: {}, pos: agent.bot.entity.position, hp: 4, food: 20 });
    assert.equal(queue.goals[0].failures, after); // not counted against the goal...
    assert.equal(loop.recent.at(-1)?.ok, true);   // ...and not shown to the model as a failure either
});

test('a goal with no workable plan is given up on eventually, not wandered at for ever', async () => {
    const agent = fakeAgent({ world: [] });
    const { loop, queue, events } = loopFor(agent, { stuckGoalMs: 50 }, [haveItem('nether_star')]);
    await loop.decide();
    await tick();
    assert.equal(queue.goals[0].failures, 0); // the first look is free: the missing thing may turn up
    assert.ok(events.some(event => event.type === 'unresolved'));
    await wait(60);
    await loop.decide();
    assert.equal(queue.goals[0].failures, 1);
    assert.ok(events.some(event => event.type === 'stuck'));
});

test('a command that never returns does not wedge the loop for ever', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    let stopped = 0;
    const { loop, events } = loopFor(agent, {
        commandTimeoutMs: 40,
        execute: command => { agent.commands.push(command); return new Promise(() => {}); },
    });
    agent.actions.stop = () => { stopped++; return Promise.resolve(); };
    loop.start();
    try {
        await wait(200);
    } finally {
        await loop.stop();
    }
    assert.ok(events.some(event => event.type === 'command timeout'));
    assert.ok(stopped >= 1);
    assert.ok(agent.commands.length >= 2, 'the loop went on to decide again');
});

test('stopping the action manager cannot hang the loop', async () => {
    const agent = fakeAgent({ world: ['oak_log'], hp: 4, mobs: ['zombie'] });
    agent.actions.executing = true;
    agent.actions.currentActionLabel = 'action:collectBlocks';
    agent.actions.stop = () => new Promise(() => {}); // ActionManager spins until the code yields
    const { loop } = loopFor(agent, { settleMs: 0 });
    loop.pendingCommand = '!collectBlocks("oak_log", 3)';
    const started = Date.now();
    await loop.decide();
    assert.ok(Date.now() - started < 8000, 'decide() waited on a stop that never finished');
});

test('nothing is decided while the bot is dead', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    const { loop } = loopFor(agent, { periodMs: 100_000 });
    loop.start();
    agent.bot.emit('death');
    await loop.decide();
    assert.deepEqual(agent.commands, []);

    agent.bot.emit('respawn');
    await loop.decide();
    await tick();
    assert.ok(agent.commands.length >= 1);
    await loop.stop();
    assert.equal(agent.bot.listenerCount('death'), 0);
    assert.equal(agent.bot.listenerCount('idle'), 0);
});

test('a command that lands after the loop was stopped is not recorded against the goal', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    let finish = (/** @type {string} */ _output) => {};
    const { loop, queue } = loopFor(agent, {
        execute: command => new Promise(resolve => { agent.commands.push(command); finish = resolve; }),
    });
    loop.start();
    await loop.decide();
    await loop.stop();
    finish('Failed to collect oak_log: no path.');
    await tick();
    assert.equal(queue.goals[0].failures, 0);
    assert.deepEqual(loop.recent, []);
});

test('guard: a spent budget stops every provider call, the interrupt question included', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    let calls = 0;
    const counting = { decide: (/** @type {any} */ request) => { calls++; return resilient([createRulesProvider()]).decide(request); } };
    const queue = new GoalQueue();
    queue.add(haveTool('wooden', 'pickaxe'));
    /** @type {{type: string, detail?: any}[]} */
    const events = [];
    const loop = new TacticalLoop(agent, counting, queue, data, {
        guard: new LoopGuard({ maxDecisionsPerHour: 2 }), settleMs: 0,
        execute: command => { agent.commands.push(command); return Promise.resolve('Collected 3 oak_log.'); },
        onEvent: event => events.push(event),
    });
    await loop.decide();
    await tick();
    await loop.decide();
    await tick();
    const spent = calls;
    await loop.decide();                // the idle path is refused...
    agent.actions.executing = true;
    agent.actions.currentActionLabel = 'action:collectBlocks';
    await loop.decide();                // ...and so is the "should this stop?" path
    assert.equal(calls, spent);
    const paused = events.filter(event => event.type === 'paused');
    assert.equal(paused.length, 2);
    assert.match(paused[0].detail.reason, /decisions budget/);
    assert.ok(loop.heldUntil > Date.now()); // and the loop will not spin while it waits
});

test('guard: commands that keep "succeeding" with nothing changing make the loop give the goal up and move on', async () => {
    // the #810 failure: every command reports success, the world never changes, the bill keeps growing
    const agent = fakeAgent({ world: ['oak_log'] });
    const { loop, queue, events } = loopFor(agent, {
        guard: new LoopGuard({ stallAfter: 2, failAfter: 4, repeatLimit: 1e9 }),
        execute: command => { agent.commands.push(command); return Promise.resolve('Collected 3 oak_log.'); },
    }, [haveTool('wooden', 'pickaxe'), haveItem('oak_log', 1)]);
    for (let i = 0; i < 8; i++) {
        await loop.decide();
        await tick();
    }
    assert.equal(queue.goals[0].status, 'failed');
    assert.ok(events.some(event => event.type === 'shake'));
    assert.ok(events.some(event => event.type === 'gave up'));
    assert.ok(events.filter(event => event.type === 'decision').at(-1)?.detail.goal.includes('oak_log'), 'moved on to the next goal');
});

test('guard: while shaking, the planned action is not on offer', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    const { loop, events } = loopFor(agent, { guard: new LoopGuard({ stallAfter: 1, failAfter: 99, repeatLimit: 1e9 }) });
    await loop.decide();
    await tick();
    assert.equal(agent.commands[0], '!collectBlocks("oak_log", 3)');
    await loop.decide();
    await tick();
    assert.ok(events.some(event => event.type === 'shake'));
    assert.notEqual(agent.commands[1], '!collectBlocks("oak_log", 3)');
});

test('guard: a command repeated to no effect is banned and not fired again', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    const { loop, events } = loopFor(agent, { guard: new LoopGuard({ repeatLimit: 2, stallAfter: 99, failAfter: 99 }) });
    for (let i = 0; i < 4; i++) {
        await loop.decide();
        await tick();
    }
    const collects = agent.commands.filter(command => command === '!collectBlocks("oak_log", 3)').length;
    assert.equal(collects, 2);
    assert.ok(events.some(event => event.type === 'banned'));
});

test('guard: a banned planned command costs no paid call, and every call made is charged', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    /** @type {string[][]} */
    const offered = [];
    const provider = {
        decide: (/** @type {any} */ request) => {
            offered.push(request.questions[0].options ?? []);
            return resilient([createRulesProvider()]).decide(request);
        },
    };
    const guard = new LoopGuard({ repeatLimit: 2, stallAfter: 99, failAfter: 99 });
    const queue = new GoalQueue();
    queue.add(haveTool('wooden', 'pickaxe'));
    const loop = new TacticalLoop(agent, provider, queue, data, {
        guard, execute: command => { agent.commands.push(command); return Promise.resolve('ok'); },
    });
    for (let i = 0; i < 3; i++) {
        await loop.decide();
        await tick();
    }
    // the first two rounds offered the planned collect; once it was banned it was no longer offered at all
    assert.ok(offered[0].includes('collect_blocks') && offered[1].includes('collect_blocks'));
    assert.ok(!offered.at(-1)?.includes('collect_blocks'), JSON.stringify(offered.at(-1)));
    assert.equal(guard.usage().decisions.hour, offered.length); // each call was charged exactly once
});

test('a provider that throws does not kill the loop', async () => {
    const agent = fakeAgent({ world: ['oak_log'] });
    const broken = { decide: () => Promise.reject(new Error('boom')) };
    const queue = new GoalQueue();
    queue.add(haveTool('wooden', 'pickaxe'));
    /** @type {{type: string}[]} */
    const events = [];
    const loop = new TacticalLoop(agent, /** @type {any} */ (broken), queue, data, { periodMs: 10, minGapMs: 0, onEvent: e => events.push(e) });
    loop.start();
    await wait(40);
    await loop.stop();
    assert.ok(events.filter(event => event.type === 'error').length >= 2); // kept ticking
});

test('crash blame: a command that was interrupted moments before a wedge kill is the one banned', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { exitInfo, loadJSON } = await import('../../src/decision/index.js');
    const statePath = join(mkdtempSync(join(tmpdir(), 'loop-')), 'state.json');
    const agent = fakeAgent({ world: ['oak_log'] });
    const { loop } = loopFor(agent, { statePath });
    await loop.decide();
    await tick(); await tick();
    assert.equal(loop.pendingCommand, '', 'the command has come back, as it does when unstuck interrupts it');
    // ...and then unstuck gives up and Mindcraft kills the process
    loop.persist(true, { exit: exitInfo("Got stuck and couldn't get unstuck") });

    const guard = new LoopGuard();
    const { loop: again } = loopFor(fakeAgent(), { guard });
    again.restoreState(loadJSON(statePath));
    assert.deepEqual(guard.bannedNow(), [agent.commands[0]]);
});
