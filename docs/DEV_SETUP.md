# Development setup (this fork)

This fork pins the toolchain so a clean clone installs and runs the same way every time.
Upstream ignores `package-lock.json` and uses `mineflayer: ^4.33.0`, so a fresh install pulls a newer
mineflayer and `patches/mineflayer+4.33.0.patch` fails to apply. Here mineflayer is pinned to `4.33.0`
and the lockfile is committed.

## Requirements

- Node **22** (pinned with [Volta](https://volta.sh) in `package.json`). If another Node manager comes
  first in your `PATH`, put Volta first: `export PATH="$HOME/.volta/bin:$PATH"`.
- A `python` command. The `gl` native module calls `python` during its build; macOS only ships `python3`.
  A throwaway shim is enough:
  ```bash
  mkdir -p /tmp/pyshim && ln -sf "$(command -v python3)" /tmp/pyshim/python
  PATH="/tmp/pyshim:$PATH" npm ci
  ```
- Docker (for the local Minecraft server).

## Install

```bash
npm ci
```

Use `npm ci`, not `npm install`, so the committed lockfile is what gets installed. Packages that have a
patch in `patches/` are pinned to exact versions in `package.json`; `protodef` and `minecraft-data` are held
by the lockfile. `npm run reinstall` wipes `node_modules` and runs `npm ci` (it keeps the lockfile).

`postinstall` runs `patch-package`. All six patches in `patches/` must report ✔.

## Local Minecraft server

`docker-compose.dev.yml` starts Paper 1.21.6 in offline mode (no Microsoft account needed) with a fixed
seed, bound to `127.0.0.1:55916`, which is the default `port` in `settings.js`. RCON is enabled on the
container (password `dev`) and is not published to the host.

Starting the server requires accepting the [Minecraft EULA](https://www.minecraft.net/eula). Only the start
command needs `MC_EULA=true`; without it the container exits with an EULA error.

```bash
MC_EULA=true npm run dev:server   # start
npm run dev:server:logs           # follow logs
npm run dev:server:down           # stop (world is kept in ./server_data_dev)
```

Run a console command on the server (e.g. to op yourself or set the time):

```bash
docker compose -f docker-compose.dev.yml exec minecraft rcon-cli time set day
```

## Tests, lint, typecheck

```bash
npm test            # node --test, files under test/**/*.test.js
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit; only files that start with // @ts-check are checked
```

Lint and typecheck only cover the code this fork adds (`src/decision`, `test`, `scripts`). Upstream code has
a few hundred ESLint errors; fixing them here would make every upstream merge conflict.

Unit tests must not import modules that load native dependencies (`canvas`, `gl`, `prismarine-viewer`): CI
installs with `--ignore-scripts`, so those are not built there. Anything that needs a live bot belongs in an
integration test against the dev server, not in `npm test`.

## Driving the bot without an LLM

`"model": "none"` (`src/models/none.js`) is a model that generates nothing, so an agent can start with no API
key. `scripts/lib/harness.js` starts Mindcraft with such an agent and sends it `!commands` through the
MindServer; a command typed by a user goes straight to `executeCommand` without touching the model.

```bash
node scripts/run_command.js '!stats' '!collectBlocks("oak_log", 3)'   # HARNESS_VERBOSE=1 to see agent logs
npm run test:integration   # needs the dev server running; not part of CI
```

`scripts/lib/rcon.js` runs server console commands (give, fill, time set, ...) so integration tests can set up
the world instead of depending on the terrain.

## Conventions for new code

- New code for the decision layer lives in `src/decision/`. Keep edits to existing upstream files minimal
  so that merging upstream stays cheap.
- Plain JavaScript (ESM), typed with `// @ts-check` and JSDoc. No TypeScript migration.
- Never commit `keys.json`.

## Decision layer (`src/decision/`)

Separate from the chat models in `src/models/`. A decision provider answers typed questions about a state
(`choice` / `score` / `noul` = yes-no probability) and never writes free text; see `src/decision/types.js`.
Providers stay thin. `resilient()` adds answer validation, a per-attempt timeout and an overall deadline,
retries with backoff for retryable errors (429 / 5xx / timeouts / network; `Retry-After` is honoured), fallback
to the next provider in the chain, and cancellation through `request.signal`. Errors marked `fatal` (malformed
questions, a cancelled request, a broken mock policy) are rethrown at once instead of falling back.

A profile selects providers with `decision_model` (a name, an object with options, or an array in fallback
order) and tunes the wrapper with `decision_options`. `"decision_model": "mock"` needs no API key: it
answers at random from a seed, or from a `policy` function when constructed in code.

### Choosing a command

`catalog.js` lists the actions a model may pick, each mapped onto an existing Mindcraft `!command`. An action
is offered only when it is possible and has a valid target (`knowledge.js` answers "can this block be
harvested with what I carry", "what can I craft or smelt right now" from the game's registry and recipe book),
so impossible moves are never options. `chooseCommand()` asks in stages (action, then target, then quantity),
skips any stage with a single option, and returns a ready `!command(args)` string plus the weakest stage's
confidence. `buildCommand()` refuses any selection the catalog would not have offered.

The dev server runs with Paper's connection throttle disabled (`dev/server-patches/bukkit.json`). With the
default 4 s throttle, the second of two bots connecting back to back is kicked, which looks like "the agent
never joined".

### Goals and the planner

`goals.js` defines typed goals (`have_item`, `have_tool` = that tier or better, `have_food`), each with an
`isDone(snapshot)`, and a `GoalQueue` (priority, parent/child, give up after repeated failure, JSON round trip).
`planner.js` works backwards from a goal to ordered `collect` / `craft` / `smelt` / `hunt` steps with no model:
it counts what the bot holds and what crafting leaves over, prefers materials that are in the inventory or in
sight (a savanna spawn has acacia, not oak), asks for the cheapest tool that can harvest a block, and lists
anything it cannot resolve. Plans are cheap (well under a millisecond), so they are recomputed from the current
snapshot on every decision rather than stored; the first step is what to do now, and `focusFor(step)` turns it
into the catalog's action and target. `gamedata.js` adapts minecraft-data for the planner; being pure JS, it lets
the planner be unit-tested against the real 1.21.6 recipes and drops. `curriculum.js` is the default ladder
(wood, stone, furnace, food, iron, armor, diamond).
