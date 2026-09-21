// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, describeCommand, renderPage } from '../../scripts/lib/demo_page.js';

test('commands read as what the bot does', () => {
    assert.equal(describeCommand('!collectBlocks("oak_log", 3)'), 'oak_log ×3 を集める');
    assert.equal(describeCommand('!craftRecipe("stone_pickaxe", 1)'), 'stone_pickaxe ×1 を作る');
    assert.equal(describeCommand('!shelter()'), '穴を掘って籠もる');
    assert.equal(describeCommand('!moveAway(32)'), '歩いて探索する');
    assert.equal(describeCommand('not a command'), 'not a command');
});

test('the timeline: request first, then the strategist, decisions, results and the night, in time order', () => {
    const entries = buildTimeline({
        request: '石のツルハシを作って', startedAt: 0, requestedAt: 1000,
        telemetry: [
            { t: 5000, kind: 'event', type: 'decision', detail: { command: '!collectBlocks("oak_log", 3)', confidence: 0.91, latencyMs: 410, decisions: 1, provider: 'jev', goal: 'have 3 oak_log' } },
            { t: 3000, kind: 'strategy', model: 'openai:gpt-5-mini', latencyMs: 9000, accepted: ['have stone_pickaxe or better'], reply: '作ります' },
            { t: 9000, kind: 'event', type: 'result', detail: { command: '!collectBlocks("oak_log", 3)', ok: true, inconclusive: false, output: 'Action output: Collected 3 oak_log.' } },
            { t: 9500, kind: 'call', purpose: 'decide' }, // calls are not shown
            { t: 10000, kind: 'event', type: 'sheltered' },
        ],
    });
    assert.deepEqual(entries.map(e => e.kind), ['request', 'strategy', 'decision', 'ok', 'night']);
    assert.match(entries[1].detail ?? '', /have stone_pickaxe/);
    assert.match(entries[1].detail ?? '', /返答「作ります」/);
    assert.match(entries[2].meta ?? '', /確信度 91%/);
    assert.equal(entries[3].detail, 'Collected 3 oak_log.');
});

test('the page escapes the request and embeds the footage data', () => {
    const html = renderPage({
        request: '<script>alert(1)</script>', startedAt: 0, requestedAt: 0, doneAt: null, fps: 2,
        frames: [{ t: 0, health: 20, food: 20, goal: null, inventory: {}, timeOfDay: 1000 }], sheets: ['sheet-00.jpg'],
        timeline: [{ t: 0, kind: 'request', title: 'x', detail: '</script><script>alert(2)</script>' }], usage: [], telemetry: [],
    });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(!html.includes('alert(2)</script>'), 'event text cannot close the data script');
    assert.match(html, /<title>ボットの行動記録<\/title>/);
    assert.match(html, /"sheets":\["sheet-00\.jpg"\]/);
});
