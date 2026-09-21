// @ts-check
// A camera for recording a bot at work: a second, invisible player (spectator mode) that keeps itself next to
// the bot and renders what it sees with prismarine-viewer, from behind and above the bot, like a follow camera.
// It runs in its own process, not in the agent: rendering takes CPU the agent's decisions need.
import { createRequire } from 'node:module';
import { rcon } from './rcon.js';

const require = createRequire(import.meta.url);
/** These are browser-first packages without type declarations. @param {string} id @returns {any} */
const load = id => require(id);

/**
 * @typedef {object} RigOptions
 * @property {string} target the bot to film
 * @property {string} [name] the camera's player name
 * @property {string} [host]
 * @property {number} [port]
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [distance] how far behind the bot, in blocks
 * @property {number} [height_] how far above
 */

/**
 * @param {RigOptions} options
 */
export async function createCameraRig(options) {
    const mineflayer = load('mineflayer');
    const THREE = load('three');
    /** @type {any} */ (globalThis).THREE ??= THREE; // prismarine-viewer's entity code expects the browser global
    const { Vec3 } = load('vec3');
    const { createCanvas } = load('node-canvas-webgl/lib/index.js');
    const { Viewer } = load('prismarine-viewer/viewer/lib/viewer.js');
    const { WorldView } = load('prismarine-viewer/viewer/lib/worldView.js');
    const { getBufferFromStream } = load('prismarine-viewer/viewer/lib/simpleUtils.js');
    const { Worker } = await import('node:worker_threads');
    /** @type {any} */ (globalThis).Worker ??= Worker; // the viewer meshes chunks in workers

    const name = options.name ?? 'camera';
    const width = options.width ?? 640;
    const height = options.height ?? 360;
    const distance = options.distance ?? 5;
    const above = options.height_ ?? 3;

    const bot = mineflayer.createBot({
        host: options.host ?? '127.0.0.1', port: options.port ?? Number(process.env.MC_PORT ?? 55916),
        username: name, version: '1.21.6', auth: 'offline',
    });
    await new Promise((resolve, reject) => {
        bot.once('spawn', () => resolve(undefined));
        bot.once('error', reject);
        bot.once('kicked', (/** @type {unknown} */ reason) => reject(new Error(`camera kicked: ${JSON.stringify(reason)}`)));
    });
    await rcon(`gamemode spectator ${name}`);
    await rcon(`tp ${name} ${options.target}`);
    await new Promise(resolve => setTimeout(resolve, 2000)); // chunks around the target arrive

    const canvas = createCanvas(width, height);
    const renderer = new THREE.WebGLRenderer({ canvas });
    const viewer = new Viewer(renderer);
    viewer.setVersion(bot.version);
    const eye = () => new Vec3(bot.entity.position.x, bot.entity.position.y + 1.6, bot.entity.position.z);
    const worldView = new WorldView(bot.world, 6, eye());
    viewer.listen(worldView);
    worldView.listenToBot(bot);
    await worldView.init(eye());

    /** Where the bot is, as the camera sees it; the camera's own position if the bot is not in view. */
    const targetEntity = () => bot.players[options.target]?.entity ?? null;

    let lastFollow = 0;
    return {
        bot,

        /**
         * Keep up with the bot: teleport next to it when it has moved away. Cheap enough to call every frame.
         */
        async follow() {
            const target = targetEntity();
            const far = !target || target.position.distanceTo(bot.entity.position) > 12;
            if (far && Date.now() - lastFollow > 1000) {
                lastFollow = Date.now();
                await rcon(`tp ${name} ${options.target}`).catch(() => '');
            }
        },

        /**
         * Render one frame from behind and above the bot, looking at it.
         * @returns {Promise<Buffer | null>} a JPEG, or null if the bot is not in view
         */
        async frame() {
            const target = targetEntity();
            if (!target) return null;
            const p = target.position;
            // behind the bot: mineflayer's yaw 0 faces -z, so "behind" is +sin/+cos of its yaw
            const cx = p.x + Math.sin(target.yaw) * distance;
            const cz = p.z + Math.cos(target.yaw) * distance;
            await worldView.updatePosition(new Vec3(p.x, p.y, p.z));
            viewer.camera.position.set(cx, p.y + above, cz);
            viewer.camera.lookAt(p.x, p.y + 1.2, p.z);
            viewer.update();
            renderer.render(viewer.scene, viewer.camera);
            return getBufferFromStream(canvas.createJPEGStream({ quality: 0.7, progressive: false }));
        },

        close() {
            bot.quit();
        },
    };
}
