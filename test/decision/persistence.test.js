// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mcdata from 'minecraft-data';
import {
    GoalQueue, LoopGuard, TacticalLoop, createGameData, createRulesProvider, fingerprint, haveItem, haveTool, loadJSON, resilient, saveJSON,
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

test('saved moments before the start means a crash: the command that was running is banned, restarts counted', () => {
    const path = join(dir(), 'state.json');
    const { loop } = loopWith({ statePath: path });
    loop.pendingCommand = '!goToPlayer("cliff", 1)';
    loop.persist(true);

    const guard = new LoopGuard();
    const { loop: again, events } = loopWith({ guard });
    again.restoreState(loadJSON(path));
    assert.equal(again.restarts, 1);
    assert.ok(guard.bannedNow().includes('!goToPlayer("cliff", 1)'));
    assert.equal(events.at(-1)?.type, 'restored after restart');
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
