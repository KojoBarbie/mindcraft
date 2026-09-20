// @ts-check
// Run Mindcraft commands on the dev server without any LLM or API key.
//   node scripts/run_command.js '!collectBlocks("oak_log", 3)' '!inventory'
import { startHarness } from './lib/harness.js';

const commands = process.argv.slice(2);
if (commands.length === 0) {
    console.error(`Usage: node scripts/run_command.js '!command(args)' ['!command(args)' ...]`);
    process.exit(2);
}

const harness = await startHarness({ verbose: process.env.HARNESS_VERBOSE === '1' });
let failed = false;
try {
    for (const command of commands) {
        console.log(`> ${command}`);
        console.log(await harness.send(command));
    }
} catch (error) {
    failed = true;
    console.error(error instanceof Error ? error.message : error);
} finally {
    await harness.stop();
}
process.exit(failed ? 1 : 0);
