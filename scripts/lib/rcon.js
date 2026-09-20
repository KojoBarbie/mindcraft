// @ts-check
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Run a console command on the dev server (docker-compose.dev.yml) through rcon-cli inside the container.
 * @param {string} command e.g. "time set day"
 * rcon-cli exits 0 even when Minecraft rejects the command; callers that depend on the effect must check
 * the reply text.
 * @returns {Promise<string>} the server's reply
 */
export async function rcon(command) {
    const { stdout } = await run(
        'docker',
        ['compose', '-f', 'docker-compose.dev.yml', 'exec', '-T', 'minecraft', 'rcon-cli', command],
        { cwd: new URL('../../', import.meta.url) },
    );
    return stdout.trim();
}
