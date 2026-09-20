// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens } from '../../src/decision/tokens.js';

test('counts letters per 4, digits per 3, and other symbols per 2', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('hp'), 1);
    assert.equal(estimateTokens('cobblestone'), 3);      // 11 letters
    assert.equal(estimateTokens('1234'), 2);
    assert.equal(estimateTokens('{"hp":20}'), 5);         // {" hp ": 20 }
    assert.equal(estimateTokens('"},{"'), 3);             // a run of 5 symbols
    assert.equal(estimateTokens('iron_ore'), 3);          // iron _ ore
});

test('non-ASCII text is counted pessimistically, not as cheap punctuation', () => {
    assert.equal(estimateTokens('鉄のツルハシ'), 12);
    assert.equal(estimateTokens('a😀b'), 4);
    assert.ok(estimateTokens('{"goal":"鉄のツルハシを作る"}') > estimateTokens('{"goal":"make iron pickaxe"}'));
});

test('objects are measured as their JSON; whitespace is free', () => {
    assert.equal(estimateTokens({ hp: 20 }), estimateTokens('{"hp":20}'));
    assert.equal(estimateTokens('a  b\n c'), 3);
    assert.equal(estimateTokens(undefined), 0);
});
