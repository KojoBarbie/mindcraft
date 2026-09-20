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
  PATH="/tmp/pyshim:$PATH" npm install
  ```
- Docker (for the local Minecraft server).

## Install

```bash
npm install
```

`postinstall` runs `patch-package`. All six patches in `patches/` must report ✔.

## Local Minecraft server

`docker-compose.dev.yml` starts Paper 1.21.6 in offline mode (no Microsoft account needed) with a fixed
seed, bound to `127.0.0.1:55916`, which is the default `port` in `settings.js`. RCON is enabled on the
container (password `dev`) and is not published to the host.

Starting the server requires accepting the [Minecraft EULA](https://www.minecraft.net/eula):

```bash
MC_EULA=true npm run dev:server   # start
npm run dev:server:logs           # follow logs
npm run dev:server:down           # stop (world is kept in ./server_data_dev)
```

Run a console command on the server (e.g. to op yourself or set the time):

```bash
docker compose -f docker-compose.dev.yml exec minecraft rcon-cli time set day
```

## Conventions for new code

- New code for the decision layer lives in `src/decision/`. Keep edits to existing upstream files minimal
  so that merging upstream stays cheap.
- Plain JavaScript (ESM), typed with `// @ts-check` and JSDoc. No TypeScript migration.
- Never commit `keys.json`.
