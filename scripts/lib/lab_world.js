// @ts-check
// The lab server's world (docker-compose.dev.yml, profile "lab"): save a freshly generated one and put it back
// before a trial, so no trial inherits another's holes, felled trees or spilt lava. Used by scripts/bench.js
// and scripts/demo.js --fresh-world.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rcon } from './rcon.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVICE = 'minecraft-lab';
const WORLDS = ['world', 'world_nether', 'world_the_end'];

/** The checkout the lab server runs from (its data sits next to its compose file); a worktree names it. */
function labRoot() {
    const root = process.env.MC_LAB_ROOT || ROOT;
    if (!isAbsolute(root)) throw new Error(`MC_LAB_ROOT must be an absolute path, not "${root}"`);
    return root;
}
const data = () => join(labRoot(), 'server_data_lab');
const pristine = () => join(labRoot(), 'server_data_lab_pristine');

/** @param {string[]} extra */
function compose(...extra) {
    execFileSync('docker', ['compose', '-f', join(labRoot(), 'docker-compose.dev.yml'), '--profile', 'lab', ...extra],
        { stdio: 'ignore', env: { ...process.env, COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME ?? 'mindcraft', MC_EULA: 'true' } });
}

async function waitForServer() {
    const previous = process.env.MC_DEV_SERVICE;
    process.env.MC_DEV_SERVICE = SERVICE;
    try {
        const deadline = Date.now() + 180_000;
        for (;;) {
            try {
                if (/players online/.test(await rcon('list'))) return;
            } catch { /* not up yet */ }
            if (Date.now() > deadline) throw new Error('the lab server did not come up within 3 minutes');
            await new Promise(resolve => setTimeout(resolve, 3_000));
        }
    } finally {
        if (previous === undefined) delete process.env.MC_DEV_SERVICE;
        else process.env.MC_DEV_SERVICE = previous;
    }
}

/** The world files are only touched once the server is known to be down: deleting a live world corrupts it. */
function stopServer() {
    compose('stop', SERVICE);
    const running = execFileSync('docker', ['compose', '-f', join(labRoot(), 'docker-compose.dev.yml'), '--profile', 'lab', 'ps', '-q', '--status', 'running', SERVICE],
        { encoding: 'utf8', env: { ...process.env, COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME ?? 'mindcraft' } }).trim();
    if (running) throw new Error('the lab server is still running after stop; not touching its world');
    if (!existsSync(join(data(), 'world'))) throw new Error(`no world at ${data()}: is MC_LAB_ROOT the checkout the lab server runs from?`);
}

export async function restoreLabWorld() {
    if (!existsSync(pristine())) throw new Error(`no pristine world at ${pristine()}: run node scripts/bench.js --make-pristine first`);
    stopServer();
    for (const w of WORLDS) {
        rmSync(join(data(), w), { recursive: true, force: true });
        cpSync(join(pristine(), w), join(data(), w), { recursive: true });
    }
    compose('up', '-d', SERVICE);
    await waitForServer();
}

export async function makePristineLabWorld() {
    stopServer();
    for (const w of WORLDS) rmSync(join(data(), w), { recursive: true, force: true });
    compose('up', '-d', SERVICE);
    await waitForServer();
    await rcon('save-all flush');
    stopServer();
    rmSync(pristine(), { recursive: true, force: true });
    for (const w of WORLDS) cpSync(join(data(), w), join(pristine(), w), { recursive: true });
    compose('up', '-d', SERVICE);
    await waitForServer();
}
