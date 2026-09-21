// @ts-check
// Helpers for integration tests that wait for the bot to get somewhere on its own.

/**
 * Ask the bot for its inventory, tolerating the agent restarting in between. Mindcraft restarts the agent
 * process when an action refuses to stop within 10 s (a pathfinder wedged on awkward terrain); a message sent
 * during the restart is lost. That is a question for the soak test (#13), not a reason to fail a test that
 * asks whether the bot eventually gets there.
 * @param {{send: (command: string, opts?: {timeoutMs?: number}) => Promise<string>}} harness
 * @returns {Promise<string | null>} null if the agent did not answer (probably restarting)
 */
export async function inventoryOf(harness) {
    try {
        return await harness.send('!inventory', { timeoutMs: 20_000 });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not picked up|reported nothing/.test(message)) return null;
        throw error;
    }
}

/**
 * @param {string | null} inventory
 * @param {string} item
 */
export function countOf(inventory, item) {
    return Number(new RegExp(`${item}: (\\d+)`).exec(inventory ?? '')?.[1] ?? 0);
}
