// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mealToHeal } from '../../src/decision/tactical_loop.js';

const isFood = (/** @type {string} */ name) => ['bread', 'porkchop', 'cooked_beef', 'rotten_flesh'].includes(name);

test('hurt and not full: eats the best food at hand', () => {
    assert.equal(mealToHeal({ hp: 5, food: 14, inventory: { porkchop: 5, cooked_beef: 1 } }, isFood), 'cooked_beef');
    assert.equal(mealToHeal({ hp: 5, food: 14, inventory: { porkchop: 5 } }, isFood), 'porkchop');
});

test('not when healthy, full, or with only bad food', () => {
    assert.equal(mealToHeal({ hp: 18, food: 10, inventory: { bread: 3 } }, isFood), null);
    assert.equal(mealToHeal({ hp: 5, food: 20, inventory: { bread: 3 } }, isFood), null);
    assert.equal(mealToHeal({ hp: 5, food: 10, inventory: { rotten_flesh: 3 } }, isFood), null);
});
