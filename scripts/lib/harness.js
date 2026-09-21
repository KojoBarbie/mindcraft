// @ts-check
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { createResultCollector } from './result_collector.js';

const WORKER = fileURLToPath(new URL('./harness_worker.js', import.meta.url));
const SENDER = 'harness_user';

/**
 * @typedef {object} HarnessOptions
 * @property {string} [name] bot name (3-16 chars, [a-zA-Z0-9_])
 * @property {number} [mindserverPort]
 * @property {number} [spawnTimeoutMs]
 * @property {boolean} [verbose] forward the agent's stdout
 * @property {Record<string, unknown>} [profile] extra profile fields, e.g. {decision_model: 'rules'} to run the
 *   tactical loop (src/decision/tactical_loop.js) instead of a bare command runner
 */

/**
 * Reject after `ms`, and always clear the timer so a settled race does not keep the event loop alive.
 * @template T
 * @param {Promise<T>[]} contenders
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
async function raceWithTimeout(contenders, ms, message) {
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    try {
        return await Promise.race([...contenders, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Start Mindcraft with a single agent that uses the "none" model, in a child process, and return a handle
 * for sending it commands. Mindcraft is run in a child because its shutdown path calls process.exit().
 * @param {HarnessOptions} [options]
 */
export async function startHarness(options = {}) {
    const name = options.name ?? 'harness';
    const port = options.mindserverPort ?? 8099;
    const spawnTimeoutMs = options.spawnTimeoutMs ?? 60_000;

    const child = fork(WORKER, [name, String(port), JSON.stringify(options.profile ?? {})], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        stdio: ['ignore', options.verbose ? 'inherit' : 'ignore', 'inherit', 'ipc'],
    });
    const hasExited = () => child.exitCode !== null || child.signalCode !== null;

    /** @type {Promise<never>} */
    const childFailed = new Promise((_, reject) => {
        child.once('exit', (code, signal) => reject(new Error(`Mindcraft exited (code ${code}, signal ${signal})`)));
        child.on('message', message => {
            const m = /** @type {{type?: string, error?: string}} */ (message);
            if (m?.type === 'error') reject(new Error(`Mindcraft failed to start the agent: ${m.error}`));
        });
    });
    childFailed.catch(() => {}); // only relevant while something is racing against it

    const socket = io(`http://localhost:${port}`, { autoConnect: false });
    /** @type {((message: string) => void) | null} */
    let onOutput = null;
    socket.on('bot-output', (agentName, message) => {
        if (agentName === name && onOutput) onOutput(String(message));
    });

    async function stop() {
        socket.close();
        if (hasExited()) return;
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM'); // the worker stops its agent before exiting
        const forceKill = setTimeout(() => child.kill('SIGKILL'), 10_000);
        await exited;
        clearTimeout(forceKill);
    }

    /**
     * @param {string} command
     * @param {number} timeoutMs
     * @returns {Promise<string>}
     */
    async function exchange(command, timeoutMs) {
        const collector = createResultCollector(SENDER);
        try {
            return await raceWithTimeout([
                new Promise(resolve => {
                    onOutput = message => {
                        if (collector.push(message)) resolve(/** @type {string} */ (collector.result));
                    };
                    socket.emit('send-message', name, { from: SENDER, message: command });
                }),
                childFailed,
            ], timeoutMs, collector.sawEcho
                ? `${command} ran but reported nothing within ${timeoutMs} ms (commands must return text)`
                : `${command} was not picked up within ${timeoutMs} ms`);
        } finally {
            onOutput = null;
        }
    }

    try {
        await raceWithTimeout([
            new Promise(resolve => child.once('message', m => {
                if (/** @type {{type?: string}} */ (m)?.type === 'ready') resolve(undefined);
            })),
            childFailed,
        ], 30_000, 'MindServer did not start within 30 s');

        socket.connect();
        await raceWithTimeout([
            new Promise(resolve => {
                socket.on('agents-status', agents => {
                    const found = agents.some((/** @type {{name: string, in_game: boolean}} */ a) => a.name === name && a.in_game);
                    if (found) resolve(undefined);
                });
            }),
            childFailed,
        ], spawnTimeoutMs, `${name} did not join the game within ${spawnTimeoutMs} ms`);

        // 'in_game' is set on login, before the agent has spawned and registered its message handler.
        // Probe with a harmless query until one gets through instead of sleeping for a fixed time.
        const deadline = Date.now() + spawnTimeoutMs;
        for (;;) {
            try {
                await exchange('!stats', 2_000);
                break;
            } catch (error) {
                if (hasExited() || Date.now() > deadline) throw error;
            }
        }
    } catch (error) {
        await stop();
        throw error;
    }

    let busy = false;

    return {
        name,

        /**
         * Send one `!command(args)` and resolve with the text the agent reports back.
         * The command must report something: the agent stays silent for commands that return nothing.
         * @param {string} command
         * @param {{timeoutMs?: number}} [opts]
         * @returns {Promise<string>}
         */
        async send(command, opts = {}) {
            if (busy) throw new Error('send() calls must not overlap');
            busy = true;
            try {
                return await exchange(command, opts.timeoutMs ?? 120_000);
            } finally {
                busy = false;
            }
        },

        stop,
    };
}
