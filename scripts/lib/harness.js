// @ts-check
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const WORKER = fileURLToPath(new URL('./harness_worker.js', import.meta.url));

/**
 * The agent echoes `*<sender> used <command>*` before running a user command; that line is not the result.
 * @param {string} message
 */
export function isCommandEcho(message) {
    return /^\*.+ used .+\*\s*$/.test(message);
}

/**
 * @typedef {object} HarnessOptions
 * @property {string} [name] bot name (3-16 chars, [a-zA-Z0-9_])
 * @property {number} [mindserverPort]
 * @property {number} [spawnTimeoutMs]
 * @property {boolean} [verbose] forward the agent's stdout/stderr
 */

/**
 * Start Mindcraft with a single agent that uses the "none" model, in a child process, and return a handle
 * for sending it commands. Mindcraft is run in a child because its shutdown path calls process.exit().
 * @param {HarnessOptions} [options]
 */
export async function startHarness(options = {}) {
    const name = options.name ?? 'harness';
    const port = options.mindserverPort ?? 8099;
    const spawnTimeoutMs = options.spawnTimeoutMs ?? 60_000;

    const child = fork(WORKER, [name, String(port)], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        stdio: options.verbose ? 'inherit' : ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const childExit = new Promise((_, reject) => {
        child.once('exit', code => reject(new Error(`Mindcraft exited early (code ${code})`)));
    });
    childExit.catch(() => {}); // only relevant while something is awaiting it

    await Promise.race([
        new Promise(resolve => child.once('message', resolve)), // worker reports the MindServer is up
        childExit,
    ]);

    const socket = io(`http://localhost:${port}`);
    /** @type {((message: string) => void) | null} */
    let onOutput = null;
    socket.on('bot-output', (agentName, message) => {
        if (agentName === name && onOutput) onOutput(String(message));
    });

    await Promise.race([
        new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`${name} did not join the game within ${spawnTimeoutMs} ms`)),
                spawnTimeoutMs,
            );
            socket.on('agents-status', agents => {
                if (agents.some((/** @type {{name: string, in_game: boolean}} */ a) => a.name === name && a.in_game)) {
                    clearTimeout(timer);
                    resolve(undefined);
                }
            });
        }),
        childExit,
    ]);
    // The agent registers its chat handlers about a second after 'login'; give it time to finish spawning.
    await new Promise(resolve => setTimeout(resolve, 3000));

    let busy = false;

    return {
        name,

        /**
         * Send one `!command(args)` and resolve with the text the agent reports back.
         * @param {string} command
         * @param {{timeoutMs?: number}} [opts]
         * @returns {Promise<string>}
         */
        async send(command, opts = {}) {
            if (busy) throw new Error('send() calls must not overlap');
            busy = true;
            const timeoutMs = opts.timeoutMs ?? 120_000;
            try {
                return await Promise.race([
                    new Promise((resolve, reject) => {
                        const timer = setTimeout(
                            () => reject(new Error(`No result for ${command} within ${timeoutMs} ms`)),
                            timeoutMs,
                        );
                        onOutput = message => {
                            if (isCommandEcho(message)) return;
                            clearTimeout(timer);
                            resolve(message);
                        };
                        socket.emit('send-message', name, { from: 'harness_user', message: command });
                    }),
                    childExit,
                ]);
            } finally {
                onOutput = null;
                busy = false;
            }
        },

        async stop() {
            socket.close();
            if (child.exitCode !== null) return;
            const exited = new Promise(resolve => child.once('exit', resolve));
            child.kill('SIGTERM');
            await exited;
        },
    };
}
