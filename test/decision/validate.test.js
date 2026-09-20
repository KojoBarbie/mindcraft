// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAnswers, validateQuestions, DecisionError } from '../../src/decision/index.js';

/** @type {import('../../src/decision/types.js').Question[]} */
const questions = [
    { id: 'skill', type: 'choice', prompt: 'What next?', options: ['mine', 'craft'] },
    { id: 'risk', type: 'score', prompt: 'How risky?', min: 0, max: 10 },
    { id: 'flee', type: 'noul', prompt: 'Flee now?' },
];
const goodAnswers = () => /** @type {Record<string, import('../../src/decision/types.js').Answer>} */ ({
    skill: { type: 'choice', value: 'mine', confidence: 0.8, distribution: { mine: 0.8, craft: 0.2 } },
    risk: { type: 'score', value: 3.5, confidence: null },
    flee: { type: 'noul', value: false, probability: 0.1, confidence: 0.9 },
});

test('well-formed questions and answers pass', () => {
    validateQuestions(questions);
    validateAnswers(questions, goodAnswers());
});

test('malformed questions are rejected', () => {
    const bad = [
        [],
        [{ id: '', type: 'noul', prompt: 'x' }],
        [{ id: 'a', type: 'noul', prompt: 'x' }, { id: 'a', type: 'noul', prompt: 'y' }],
        [{ id: 'a', type: 'choice', prompt: 'x', options: [] }],
        [{ id: 'a', type: 'choice', prompt: 'x', options: ['m', 'm'] }],
        [{ id: 'a', type: 'score', prompt: 'x', min: 5, max: 5 }],
        [{ id: 'a', type: 'essay', prompt: 'x' }],
        [{ id: 'a', type: 'noul', prompt: '' }],
    ];
    for (const qs of bad)
        assert.throws(() => validateQuestions(/** @type {any} */ (qs)), DecisionError, JSON.stringify(qs));
});

test('a choice that was not offered is rejected', () => {
    const answers = goodAnswers();
    answers.skill = { type: 'choice', value: 'fly', confidence: 0.9 };
    assert.throws(() => validateAnswers(questions, answers), /not one of the options/);
});

test('missing, mistyped, out-of-range and contradictory answers are rejected', () => {
    /** @type {[string, (a: Record<string, any>) => void][]} */
    const mutations = [
        ['missing', a => { delete a.flee; }],
        ['wrong type', a => { a.risk = { type: 'noul', value: true, probability: 1, confidence: 1 }; }],
        ['out of range', a => { a.risk.value = 11; }],
        ['NaN score', a => { a.risk.value = NaN; }],
        ['bad confidence', a => { a.skill.confidence = 1.5; }],
        ['bad distribution key', a => { a.skill.distribution = { fly: 1 }; }],
        ['contradiction', a => { a.flee = { type: 'noul', value: true, probability: 0.1, confidence: 0.9 }; }],
    ];
    for (const [label, mutate] of mutations) {
        const answers = goodAnswers();
        mutate(answers);
        assert.throws(() => validateAnswers(questions, answers), DecisionError, label);
    }
});

test('validation errors are not retryable', () => {
    try {
        validateAnswers(questions, {});
        assert.fail('should have thrown');
    } catch (error) {
        assert.ok(error instanceof DecisionError);
        assert.equal(error.retryable, false);
    }
});
