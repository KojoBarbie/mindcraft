// @ts-check
// Child process for scripts/lib/harness.js: runs Mindcraft with one agent on the "none" model.
import * as Mindcraft from '../../src/mindcraft/mindcraft.js';
import settings from '../../settings.js';

const [name, port, profileJson] = process.argv.slice(2);

/** @type {Record<string, unknown>} */
const overrides = {
    mindserver_port: Number(port),
    auto_open_ui: false,
    init_message: null,
    load_memory: false,
    render_bot_view: false,
    speak: false,
    // The harness reads results from the agent's open-chat output, so keep that stream predictable:
    only_chat_with: [],       // otherwise replies are whispered and never reach bot-output
    narrate_behavior: false,  // otherwise modes interleave lines like "Picking up item!"
    chat_ingame: false,       // results still reach bot-output; this only avoids spamming server chat
    profile: { name, model: 'none', ...JSON.parse(profileJson || '{}') },
};
Object.assign(settings, overrides);

// The agent is a child of this process and is restarted by Mindcraft if it dies abnormally,
// so stop it properly and wait for it before exiting; otherwise it is orphaned.
process.on('SIGTERM', async () => {
    const agentProcess = Mindcraft.getAgentProcess(name);
    const agent = agentProcess?.running ? agentProcess.process : null;
    if (agent) {
        const exited = new Promise(resolve => agent.once('exit', resolve));
        Mindcraft.stopAgent(name); // SIGINT: exits without triggering a restart
        const forceKill = setTimeout(() => agent.kill('SIGKILL'), 5_000);
        await exited;
        clearTimeout(forceKill);
    }
    process.exit(0);
});

await Mindcraft.init(false, Number(port), false);
process.send?.({ type: 'ready' });

const created = await Mindcraft.createAgent(settings);
if (!created.success) {
    process.send?.({ type: 'error', error: created.error });
    process.exit(1);
}
