// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mcdata from 'minecraft-data';
import {
    GoalQueue, LoopGuard, TacticalLoop, exitInfo, createGameData, createRulesProvider, fingerprint, haveItem, haveTool, loadJSON, resilient, saveJSON,
} from '../../src/decision/index.js';

const data = createGameData(mcdata('1.21.6'));
const dir = () => mkdtempSync(join(tmpdir(), 'decision-state-'));

/** A loop whose only job here is to be saved and restored; it never touches a bot. */
function loopWith(/** @type {{guard?: LoopGuard, statePath?: string, goals?: GoalQueue}} */ options = {}) {
    const goals = options.goals ?? new GoalQueue();
    /** @type {{type: string, detail?: any}[]} */
    const events = [];
    const loop = new TacticalLoop(/** @type {any} */ ({ name: 't', bot: {}, actions: {} }), resilient([createRulesProvider()]), goals, data, {
        guard: options.guard ?? new LoopGuard(), statePath: options.statePath, onEvent: e => events.push(e),
    });
    return { loop, goals, events };
}

test('saveJSON writes aside and renames, leaving no temporary file; loadJSON reads it back', () => {
    const path = join(dir(), 'nested', 'state.json');
    saveJSON(path, { a: 1 });
    saveJSON(path, { a: 2 });
    assert.deepEqual(loadJSON(path), { a: 2 });
    assert.deepEqual(readdirSync(join(path, '..')), ['state.json']);
});

test('a missing or corrupt file loads as null, and restoring null changes nothing', () => {
    const d = dir();
    assert.equal(loadJSON(join(d, 'nope.json')), null);
    writeFileSync(join(d, 'bad.json'), '{"version": 1, "goa');
    assert.equal(loadJSON(join(d, 'bad.json')), null);
    const { loop } = loopWith();
    loop.restoreState(null);
    loop.restoreState({ version: 999, loop: { restarts: 5 } });
    assert.equal(loop.restarts, 0);
});

test('fingerprint: same content, same print; different goals, different print', () => {
    assert.equal(fingerprint({ goals: ['a'] }), fingerprint({ goals: ['a'] }));
    assert.notEqual(fingerprint({ goals: ['a'] }), fingerprint({ goals: ['b'] }));
});

test('a round trip keeps goals (failed ones included), spend, bans and the recent history', () => {
    const path = join(dir(), 'state.json');
    let clock = 1_000_000_000;
    const guard = new LoopGuard({ now: () => clock });
    const goals = new GoalQueue();
    goals.add(haveTool('wooden', 'pickaxe'));
    goals.add(haveItem('bread', 1));
    goals.giveUp(goals.toJSON().goals[0].id);
    const { loop } = loopWith({ guard, goals, statePath: path });
    guard.recordSpend({ decisions: 1, inputTokens: 1000, outputTokens: 10 });
    guard.ban('!collectBlocks("oak_log", 4)', 60_000);
    loop.recent = [{ cmd: '!craftRecipe("oak_planks", 1)', ok: false, note: 'no logs' }];
    loop.persist(true);

    clock += 10 * 60_000; // ten minutes later: a plain resume, not a crash
    const saved = loadJSON(path);
    saved.savedAt -= 10 * 60_000; // the loop stamps saves with the wall clock
    const guard2 = new LoopGuard({ now: () => clock });
    const { loop: loop2, events } = loopWith({ guard: guard2, goals: GoalQueue.fromJSON(saved.goals) });
    loop2.restoreState(saved, { recentMs: 90_000 });
    const restoredGoals = loop2.goals.toJSON();
    assert.deepEqual(restoredGoals, goals.toJSON());
    assert.equal(guard2.usage().tokens.day, guard.usage().tokens.day);
    assert.equal(guard2.usage().decisions.day, 1);
    assert.equal(loop2.recent.length, 1);
    assert.equal(loop2.restarts, 0);
    assert.equal(events.at(-1)?.type, 'restored');
});

test('killed for a wedged action moments ago: the command that was running is banned, restarts counted', () => {
    const path = join(dir(), 'state.json');
    const { loop } = loopWith({ statePath: path });
    loop.pendingCommand = '!goToPlayer("cliff", 1)';
    loop.persist(true, { exit: exitInfo('Code execution refused stop after 10 seconds. Killing process.') });

    const guard = new LoopGuard();
    const { loop: again, events } = loopWith({ guard });
    again.restoreState(loadJSON(path));
    assert.equal(again.restarts, 1);
    assert.ok(guard.bannedNow().includes('!goToPlayer("cliff", 1)'));
    assert.equal(events.at(-1)?.type, 'restored after crash');
});

test('spend older than a day is dropped; spend within the hour still counts against the hourly budget', () => {
    let clock = 5 * 86_400_000;
    const guard = new LoopGuard({ now: () => clock, maxDecisionsPerHour: 2 });
    guard.recordSpend({ decisions: 2 });
    const saved = guard.toJSON();
    const fresh = new LoopGuard({ now: () => clock + 60_000, maxDecisionsPerHour: 2 });
    fresh.restore(saved);
    assert.ok(fresh.overBudget(), 'two decisions a minute ago still fill an hourly budget of two');
    const later = new LoopGuard({ now: () => clock + 2 * 86_400_000 });
    later.restore(saved);
    assert.equal(later.usage().decisions.day, 0);
});

test('persist is throttled unless forced, and a save that fails is reported, not thrown', () => {
    const d = dir();
    const { loop, events } = loopWith({ statePath: join(d, 'state.json') });
    loop.persist(true);
    const first = loadJSON(join(d, 'state.json')).savedAt;
    loop.recent = [{ cmd: 'x', ok: true }];
    loop.persist();
    assert.equal(loadJSON(join(d, 'state.json')).savedAt, first);
    assert.equal(loadJSON(join(d, 'state.json')).loop.recent.length, 0);

    writeFileSync(join(d, 'file'), '');
    const { loop: broken, events: brokenEvents } = loopWith({ statePath: join(d, 'file', 'state.json') });
    assert.doesNotThrow(() => broken.persist(true));
    assert.ok(brokenEvents.some(e => e.type === 'error' && /could not save/.test(e.detail)));
    assert.equal(events.filter(e => e.type === 'error').length, 0);
});

test('a clean shutdown is not a crash: nothing is banned and no restart is counted', () => {
    const path = join(dir(), 'state.json');
    const { loop } = loopWith({ statePath: path });
    loop.pendingCommand = '!collectBlocks("dirt", 2)';
    loop.persist(true, { clean: true });
    const guard = new LoopGuard();
    const { loop: again } = loopWith({ guard });
    again.restoreState(loadJSON(path));
    assert.equal(again.restarts, 0);
    assert.deepEqual(guard.bannedNow(), []);
});

test('exitInfo: only Mindcraft\'s wedge messages count as a crash', () => {
    for (const reason of ["Got stuck and couldn't get unstuck", 'Code execution refused stop after 10 seconds. Killing process.', 'Infinite action loop detected, shutting down.'])
        assert.equal(exitInfo(reason).wedged, true, reason);
    for (const reason of ['Killing agent process...', 'Disconnected from MindServer. Killing agent process.', 'kicked: Invalid move player packet received', 'Safely restarting to update inventory.'])
        assert.equal(exitInfo(reason).wedged, false, reason);
});

test('a kick or a restart from the UI is a resume, not a crash: nothing banned', () => {
    const path = join(dir(), 'state.json');
    const { loop } = loopWith({ statePath: path });
    loop.pendingCommand = '!collectBlocks("dirt", 2)';
    loop.persist(true, { exit: exitInfo('Disconnected from MindServer. Killing agent process.') });
    const guard = new LoopGuard();
    const { loop: again, events } = loopWith({ guard });
    again.restoreState(loadJSON(path));
    assert.equal(again.restarts, 0);
    assert.deepEqual(guard.bannedNow(), []);
    assert.equal(events.at(-1)?.detail.exit, 'Disconnected from MindServer. Killing agent process.');
});

test('the guard keeps its per-goal progress across a restart; stuck timers do not count the downtime', () => {
    const path = join(dir(), 'state.json');
    const { loop } = loopWith({ statePath: path });
    loop.guardGoalId = 7;
    loop.stuckSince.set(7, Date.now() - 1000);
    loop.persist(true);
    const saved = loadJSON(path);
    saved.savedAt -= 60_000; // down for a minute

    const { loop: same } = loopWith();
    same.restoreState(saved);
    assert.equal(same.guardGoalId, 7);
    const since = /** @type {number} */ (same.stuckSince.get(7));
    assert.ok(Date.now() - since < 5_000, 'the minute spent down was not counted as being stuck');

    const { loop: rebuilt } = loopWith();
    rebuilt.restoreState(saved, { goalsRestored: false });
    assert.equal(rebuilt.guardGoalId, null);
    assert.equal(rebuilt.stuckSince.size, 0, 'ids of a rebuilt queue point at other goals');
});

test('spend is saved one entry per minute, not one per call', () => {
    let clock = 1_000_000;
    const guard = new LoopGuard({ now: () => clock });
    for (let i = 0; i < 100; i++) {
        guard.recordSpend({ decisions: 1, inputTokens: 400 });
        clock += 500;
    }
    const saved = guard.toJSON();
    assert.equal(saved.spent.decisions.length, 1);
    assert.equal(saved.spent.decisions[0].amount, 100);
    assert.equal(guard.usage().tokens.hour, 40_000);
});

test('a goal given up is tried again after a while, with a clean record', () => {
    const goals = new GoalQueue();
    const id = goals.add(haveItem('bread', 1));
    goals.giveUp(id);
    assert.equal(goals.reviveFailed(Date.now() + 60_000, 30 * 60_000), 0);
    assert.equal(goals.reviveFailed(Date.now() + 31 * 60_000, 30 * 60_000), 1);
    assert.equal(goals.toJSON().goals[0].status, 'pending');
    assert.equal(goals.toJSON().goals[0].failures, 0);

    // saved before failedAt existed: waits a full cooldown from the load
    const old = GoalQueue.fromJSON({ goals: [{ id: 1, goal: { type: 'have_item', item: 'bread', count: 1 }, status: 'failed', failures: 3 }] });
    assert.equal(old.reviveFailed(Date.now() + 60_000, 30 * 60_000), 0);
});
