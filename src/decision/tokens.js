// @ts-check

/**
 * Rough token count for budgeting, with no tokenizer dependency. It deliberately errs on the high side for the
 * compact JSON we send (short snake_case keys, small integers, lots of punctuation): a budget check that passes
 * here should pass on a real tokenizer. The provider's reported `inputTokens` is the ground truth; use this
 * before a request is made, and to catch regressions in tests.
 *
 * Rules: a run of ASCII letters costs one token per 4 characters, a run of digits one per 3, a run of ASCII
 * punctuation one per 2 (tokenizers merge JSON punctuation such as `":` and `","`), and every non-ASCII
 * character 2 (CJK and emoji tokenize badly; player names and server messages can contain them).
 * @param {string | unknown} value a string, or anything JSON-serialisable
 * @returns {number}
 */
export function estimateTokens(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
    let tokens = 0;
    for (const match of text.matchAll(/[A-Za-z]+|\d+|[!-/:-@[-`{-~]+|[^\s!-~]/gu)) {
        const piece = match[0];
        if (/^[A-Za-z]/.test(piece)) tokens += Math.ceil(piece.length / 4);
        else if (/^\d/.test(piece)) tokens += Math.ceil(piece.length / 3);
        else if (/^[!-~]/.test(piece)) tokens += Math.ceil(piece.length / 2);
        else tokens += 2;
    }
    return tokens;
}
