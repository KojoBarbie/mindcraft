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

### The tactical loop

`tactical_loop.js` is what ties the layers together, and the only part that touches `src/agent`. It starts
itself from `agent.js` when a profile sets `decision_model`, and does nothing otherwise:

```json
{ "name": "andy", "model": "none", "decision_model": "rules", "tactical": { "periodMs": 1500 } }
```

Each tick it takes a snapshot, asks the `GoalQueue` what the current goal is, plans it, and offers the model
the planned action plus whatever the situation allows (eat, flee, attack, explore, wait). Picking the planned
action costs one question: the planner already knows the target and amount. When the planned target is out of
sight the loop offers `search_for_block` / `search_for_entity` instead — `!moveAway` is just as happy to walk
into a cave.

Two rules keep it responsive. Commands are fired without being awaited, so the loop keeps ticking while the
bot digs and can decide to interrupt; and a decision is dropped if the bot's position, health or current
action changed while the model was thinking. While something is running the only question asked is "should
this stop?", over a combat-shaped state.

`"decision_model": "rules"` needs no API key at all: `providers/rules.js` answers from a handful of thresholds
(flee when hurt and cornered, eat when hungry, otherwise follow the plan). It is the baseline a real model has
to beat, and it is what the integration test uses to get itself a wooden pickaxe.

### Guard rails (`guard.js`)

What keeps an autonomous bot from being a liability — Mindcraft's own self-prompting loop has none of this, and
the upstream tracker has a report of it spending $100 in a day on one stuck task:

- **Stall**: progress means *beating the best so far for this goal* — more of some item than ever, or an
  8-block cell not visited yet. Being merely different does not count: wobbling across a cell border, pacing
  between two spots, using items up or regenerating health are not progress. Every `stallAfter` fruitless
  decisions the planned action is withheld once ("shake"); after `failAfter` the goal is given up.
- **Repeats**: the same command `repeatLimit` times within `repeatWindowMs` *without progress* is banned for
  `banForMs`. Progress clears the count, so collecting one log at a time is fine. Waiting, fighting and
  fleeing are exempt. A banned planned command is dropped before the model is asked, not after.
- **Budgets**: decisions, tokens (input + output) and estimated USD, per rolling hour and day. Every provider
  call made by the loop is charged — the "should this stop?" question, retries and failed calls included.
  When a budget is used up the loop stops calling the provider until the window frees up; the reflex modes
  keep the bot alive meanwhile. A USD cap needs a price (`inputUsdPerMillion` / `outputUsdPerMillion`) and is
  refused without one; use `maxDecisionsPerDay` if the price is unknown.

A goal can be given up three ways, each catching a different failure:

| Rule | Counts | Catches |
|---|---|---|
| `GoalQueue` three strikes | commands that report failure | a target that keeps failing ("no path") |
| `tactical.stuckGoalMs` (60 s) | time with no plan at all | an unobtainable item (a nether star) |
| `guard.failAfter` (12) | decisions that achieved nothing | commands that "succeed" while nothing happens |

For scale: a bot deciding every 1.5 s around the clock makes ~57,600 decisions a day. At ~300 input tokens
each that is ~$0.73/day on Jev; a $1/day cap would cut a busy bot off late in the day.

```json
{ "decision_model": "jev",
  "guard": { "maxUsdPerDay": 2, "inputUsdPerMillion": 0.042, "stallAfter": 6, "failAfter": 12 },
  "goals": [{ "type": "have_item", "item": "torch", "count": 16 }] }
```

`goals` replaces the default survival curriculum with an explicit list, in priority order.

### Surviving a restart (`persistence.js`)

The loop saves its state to `bots/<name>/decision_state.json` (at most every 10 s, before each command it
fires, and on exit; written aside and renamed, so never half-written): the goal queue with its failures, the
guard's spend windows, bans and per-goal progress, and the recent actions. A restarted agent picks it up:

| How the agent ended | On the next start |
|---|---|
| SIGINT (Mindcraft stopping the agent) | carry on |
| `cleanKill` for a wedge (`Got stuck…`, `…refused stop…`, `Infinite action loop…`), under 90 s ago | a crash: `restarts` + 1, and the command running then (or ended in the 20 s before) is banned for 5 min |
| anything else (kick, lost connection, restart from the UI, or a wedge long ago) | carry on |

Budgets and bans always carry over. The goal queue, the guard's per-goal progress and the stuck timers (minus
the time spent down) carry over only while the profile's `goals`/`curriculum` are unchanged (a fingerprint is
saved alongside); edit them and the queue is rebuilt. A goal given up is tried again after
`tactical.retryFailedAfterMs` (30 min). Spend is kept one entry per minute, so the file stays small; delete it
to start afresh.

### Telemetry (`telemetry.js`, `npm run stats`)

Every provider call and the loop's notable events go to `bots/<name>/decisions.jsonl`, one JSON object per line
(moved to `.jsonl.1` past 20 MB; `"telemetry": false` in the profile turns it off). A call line has the provider,
the questions' shapes and answers with confidence, latency, tokens, attempts and an estimated cost (the guard's
price if set, else a default per provider: jev 0.042/0, openai as gpt-5-nano 0.05/0.40 USD per Mtok in/out).

```
npm run stats                      # every bots/*/decisions.jsonl
npm run stats -- path/to/a.jsonl   # specific files
```

prints the period, decisions per hour, p50/p95 latency, tokens and USD per hour, the stale rate (answers thrown
away because the world moved on), the low-confidence rate (< 0.6), results, interrupts, goals given up, crashes
and deaths. The MindServer dashboard shows the current goal, the last decision and today's spend per agent.

One run for scale (Jev, fresh world to a wooden pickaxe, 2.5 min): 53 calls of which 36 were the "stop now?"
check while an action ran, p50 467 ms / p95 931 ms, $0.03/h.

### Chat models as decision providers (`providers/openai.js`)

Any OpenAI-compatible endpoint (OpenAI, Ollama, Groq, vLLM) can answer the same typed questions: the questions
become a strict JSON schema, so a choice can only be one of the offered options.

```json
"decision_model": "openai"                                             // gpt-5-nano, OPENAI_API_KEY
"decision_model": { "provider": "openai", "model": "gpt-5-mini" }
"decision_model": { "provider": "ollama", "model": "qwen3:4b" }        // local, no key
"decision_model": ["jev", "openai", "rules"]                           // fallback order
```

Two things measured the hard way: gpt-5 models default to `reasoning_effort: "minimal"` here, because at the
API's default effort a two-word answer takes ~1300 reasoning tokens and ~10 s; and `max_completion_tokens`
counts reasoning, so a small cap returns an empty answer. The confidence a chat model reports is its own
estimate (gpt-5-nano says ~0.65 about answers it gets right every time), not a calibrated probability.

`node scripts/try_provider.js <spec> [runs]` asks a real provider a real question and prints latency and tokens.

### Jev (`providers/jev.js`)

TypeSafe's decision model, through the Vercel AI Gateway's `POST /v1/evaluate` (key: `AI_GATEWAY_API_KEY`, or
`VERCEL_API_KEY`; either must be an AI Gateway key, not a Vercel REST API token). It answers each question with a calibrated probability and writes no text:

Option hints (`ChoiceQuestion.hints`) go into Jev's per-option criteria, where it reads what each option means.

```json
"decision_model": ["jev", "openai", "rules"],
"guard": { "maxUsdPerDay": 2, "inputUsdPerMillion": 0.042 }
```

Measured from Japan (2026-09-21): ~410 ms p50 for a decision, with occasional 2-4 s spikes; the model itself
takes ~130 ms and the rest is the gateway, which processes in the US. Each request carries ~300 input tokens of
fixed overhead, and the tactical loop's action question runs to ~450-550 tokens (~$0.00002 per decision).
Confidence is meaningful: when the bot kept failing to craft, Jev's confidence in repeating it fell from 1.0
to 0.5. TypeSafe is in early access and sometimes answers `system_overloaded`; that is retried.

### Known problems underneath the decision layer (Mindcraft / mineflayer on 1.21.6)

Found by running the bot for real; they affect any Mindcraft bot, not just this fork.

- **Reflex modes kill the process.** `unstuck` (src/agent/modes.js) arms a 10 s timer while freeing the bot and
  exits the process if it is still stuck; `ActionManager.stop()` does the same for an action that will not stop
  (a pathfinder wedged on a cliff). Mindcraft then restarts the agent. The tactical loop therefore never
  interrupts a `mode:*` action, only commands it fired itself. The decision state survives a restart (see above).
- **x/z become NaN.** Occasionally the bot's position turns NaN on two axes while y and velocity are fine;
  the next movement packet gets it kicked ("Invalid move player packet received"). `patches/mineflayer+4.33.0.patch`
  refuses to send non-finite movement packets and restores only the broken axes. The source is not found yet.
- **allow-flight.** The dev server allows flight because tests edit terrain under bots. A customer server that
  does not may kick a bot left briefly standing on nothing.
- **World wear.** Dozens of test runs dig up the spawn area and tests turn flaky. Reset with
  `npm run dev:server:down && rm -rf server_data_dev && MC_EULA=true npm run dev:server`.
