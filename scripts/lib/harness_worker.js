// @ts-check
// Child process for scripts/lib/harness.js: runs Mindcraft with one agent on the "none" model.
import * as Mindcraft from '../../src/mindcraft/mindcraft.js';
import settings from '../../settings.js';

const [name, port] = process.argv.slice(2);

/** @type {Record<string, unknown>} */
const overrides = {
    mindserver_port: Number(port),
    auto_open_ui: false,
    init_message: null,
    load_memory: false,
    render_bot_view: false,
    speak: false,
    profile: { name, model: 'none' },
};
Object.assign(settings, overrides);

// agents are child processes of this one; take them down with us
process.on('SIGTERM', () => {
    Mindcraft.stopAgent(name);
    process.exit(0);
});

await Mindcraft.init(false, Number(port), false);
process.send?.('ready');
await Mindcraft.createAgent(settings);
