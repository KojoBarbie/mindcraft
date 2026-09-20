// @ts-check

/**
 * The agent echoes `*<sender> used <command>*` right before it runs a user command.
 * @param {string} message
 * @param {string} sender
 */
export function isCommandEcho(message, sender) {
    return message.trim().startsWith(`*${sender} used `) && message.trim().endsWith('*');
}

/**
 * Pairs a sent command with its result on the shared `bot-output` stream.
 *
 * `bot-output` carries everything the agent says (mode narration, greetings, ...), not only command results.
 * The echo line marks the point where our command started executing, so anything before it is unrelated and
 * the first message after it is the result. Narration is disabled by the harness, so nothing else is expected
 * in between.
 * @param {string} sender name the command was sent under
 */
export function createResultCollector(sender) {
    let sawEcho = false;
    /** @type {string | null} */
    let result = null;
    return {
        /**
         * Feed one bot-output message.
         * @param {string} message
         * @returns {boolean} true once the result has been captured
         */
        push(message) {
            if (result !== null) return true;
            if (!sawEcho) {
                sawEcho = isCommandEcho(message, sender);
                return false;
            }
            result = message;
            return true;
        },
        get sawEcho() { return sawEcho; },
        get result() { return result; },
    };
}
