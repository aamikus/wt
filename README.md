# wt

Per-worktree dev environments for coding agents on macOS and Linux.

Every linked Git worktree gets its own environment: dependencies installed, its own ports, its own tmux session running its dev servers and, for Expo apps on macOS, its own iOS simulator and Android emulator. Agents working in parallel worktrees never fight over port 3000, never reach another worktree's server, and never start servers by hand. Environments stop when nobody uses them and come back with the next `wt up`.

```
$ wt ls
  NAME          PROFILES  SETUP  SERVICES

shop
  fix-checkout  web       ok     api :8001 · web :3001
  pricing-page  web       ok     asleep since 14:02 (wakes on the next prompt or wt up)
  search-v2     code      ok     no services
```

## Why

Coding agents work best in parallel, one git worktree per task. Every worktree then needs the same things a human sets up by hand once per checkout, and agents get them wrong:

- **Ports collide.** Two worktrees both start on `:3000`; the second agent's server fails, or it tests against the first one's code without noticing.
- **Servers leak.** Agents start dev servers in their shell and leave them running after the task, in directories that are later deleted.
- **Setup is skipped.** A fresh worktree has no `node_modules` and none of the main checkout's gitignored `.env` files, so the first build or test fails.
- **Agents can't see output.** A server started in the background hides its logs from the next session.

wt makes the environment part of the worktree:

- **One command.** `wt up` installs dependencies and copies `.env` files; `wt up <profile>` starts the servers that profile needs, each on the worktree's own ports, in a tmux session the agent never has to manage.
- **Discoverable.** `wt ls` shows every worktree with its services and ports; `wt logs <service>` prints any server's output, so any session can pick up where another left off.
- **Self-cleaning.** Idle environments stop after a few hours and restart on demand; removing a worktree removes its servers, processes, simulators and build caches.
- **Agent-aware.** A bundled skill tells Claude Code and Codex to use wt instead of starting servers, and optional hooks set up each new worktree automatically.
- **Works anywhere, extends per repo.** Any Node repo works out of the box. A small TypeScript profile adds a monorepo's services, shared backends and mobile simulators.

## Install

```bash
git clone https://github.com/aamikus/wt ~/.wt && ~/.wt/install.sh
```

The installer:

- installs [Bun](https://bun.sh) and [tmux](https://github.com/tmux/tmux) if they are missing (tmux through Homebrew; on Linux without Homebrew it asks you to install it)
- downloads [worktrunk](https://github.com/max-sixty/worktrunk), which wt uses to create, remove and prune worktrees, as `wtcore`, since its own binary is also called `wt`
- links `wt` and `wtcore` into `~/.local/bin` (`WT_BIN_DIR` picks another directory)
- adds `eval "$(wt shell-init <shell>)"` to your bash, zsh or fish config, for `wt cd` and tab completion
- links the `wt` agent skill into `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) and `~/.codex/skills`, so agents use wt instead of starting servers

Open a new shell, `cd` into any worktree and run `wt up`. Update with `git -C ~/.wt pull`. Git and lsof must already be installed.

## How it works

### Profiles

A **profile** is a named set of services; a worktree runs the union of the profiles it has been given. Every repo has:

- `bare`: nothing
- `code`: setup only. By default, copy the main checkout's gitignored `.env*` files, then install with the lockfile's package manager (pnpm, yarn, bun or npm)
- `dev`: `code`, then the `dev` script with `PORT` set to the worktree's port (and `APP_ENV` when `wt up` gets one). Apps that ignore `PORT` need it passed in their dev script

A [repo profile](#repo-profiles) can define its own profiles and services. `wt --help` lists the ones for the current repo.

### Slots and ports

Each worktree takes the lowest free **slot** `k` (1–20) whose ports nothing else listens on; the main checkout is slot 0. A service's port is a function of the slot, such as `3000 + k`, so the third worktree serves `dev` on `:3003`. The slot survives restarts; if another process took one of its ports meanwhile, the worktree moves to a free slot.

### Processes

`wt up` runs in the background. Each worktree has a tmux session named after it:

| window       | runs                                                                            |
| ------------ | ------------------------------------------------------------------------------- |
| `up`         | setup, dependency builds, starting runs and devices                             |
| `dev`        | the profile's dev command (one Turbo run in a monorepo, else the `dev` script) |
| `app-<name>` | a service with its own command, such as a discovered Next or Vite app          |
| `share`      | the proxy for shared services                                                  |
| `idle`       | the idle watcher                                                                |

Commands run in a bash login shell with the `PATH` of the shell that called wt, so the node and package managers you use in your terminal are the ones your servers use. A crashed run stays on screen. Pane output goes to `~/.claude/wt/<name>/<window>.log`; in a Turbo repo, per-task output comes from Turbo's log file. `wt attach` opens the session and `ctrl-b d` leaves it running.

### Idle

A watcher in each session samples activity every minute: Claude sessions in the worktree, agent CPU, Metro bundles and input on the worktree's simulator or emulator. After `WT_IDLE_MINUTES` (default 240) without any, it stops the environment and marks it asleep. The next `wt up`, or the next prompt when the [hooks](#claude-code-hooks-optional) are set up, brings it back.

### Shared services

A repo profile can declare a **base checkout**: a locked worktree on the default branch that runs expensive backend services once for every worktree. Each worktree gets a small proxy on its own ports that forwards to the base until the worktree changes that service or a package it depends on (from `git diff` against the merge-base and Turbo's package graph). From then on it runs its own instance, and the proxy switches over once that instance passes its health check. The base moves forward when a worktree needs newer code and stops when no worktree shares it.

### Cleanup

`wt clean` reports, and with `--yes` removes, the current repo's merged worktrees and branches, orphaned directories under `.claude/worktrees`, environments whose worktree is gone, stale Xcode DerivedData and old cached dev clients. A worktree stays while a `claude` or `codex` process runs in it, or while a Claude desktop session that is not archived sits in it or wrote its branch. Removing a worktree through wt purges its environment: the tmux session, processes left in its directory, its simulator, emulator and DerivedData.

### State

Everything wt knows lives in `~/.claude/wt/<name>/`, one file per key (`slot`, `profiles`, `setup`, `active`, logs). `wt ls --json` prints it all.

## Commands

`<name>` defaults to the worktree containing the current directory. A selector is a path, branch, environment name or unambiguous directory name.

| command                        | does                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `wt up [<profile>...]`         | add profiles and start what they need; with none, restore the last ones (or `code`)   |
| `wt up <service>...`           | start a discovered app, or run a shared service from the worktree instead of the base |
| `wt down`                      | stop the tmux session, simulator and emulator                                          |
| `wt ls [--json]`               | every worktree of every repo wt has run in, with its environment                       |
| `wt attach [<service>]`        | attach to the session, on a service's window                                           |
| `wt logs <service> [-f]`       | print or follow a service's output; also `all`, `up`, `share`, `dev`                   |
| `wt restart`                   | restart the worktree's runs                                                            |
| `wt path` / `wt cd`            | print / cd into the worktree's directory                                               |
| `wt clean [<name>...] [--yes]` | report or remove merged worktrees, branches and leftovers (`wt clean --help`)          |
| `wt shell-init [<shell>]`      | print the shell integration for bash, zsh or fish                                      |
| `wt open`                      | reopen the app on the worktree's simulator and emulator                                |
| `wt build [ios\|android]`      | build and cache the dev client for the worktree's native fingerprint                   |
| `wt grid`                      | an iTerm2 window with one pane attached to each running worktree (macOS, up to 4)      |
| `wt switch`, `list`, `remove`, `merge`, `step`, `config` | worktrunk's own commands                                     |

## Repo profiles

A repo profile is a TypeScript module at `profiles/<name>/index.ts` in the wt checkout (`~/.wt/profiles/`). The directory is gitignored, so private profiles stay out of the repo. Its default export is a `RepoProfile` (see `src/profile.ts`). A two-service repo:

```ts
import { join } from 'node:path';
import { HOME } from '../../src/env.ts';
import { generic } from '../../src/generic.ts';
import type { RepoProfile } from '../../src/profile.ts';

const shop: RepoProfile = {
  name: 'shop',
  // the main checkout
  repo: join(HOME, 'projects/shop'),
  profiles: { api: ['api'], web: ['api', 'web'] },
  describe: 'api, web (api and the storefront)',
  services: {
    api: {
      port: (k) => 8000 + k,
      reserves: true,
      command: (_w, ports) => `PORT=${ports.listen('api')} exec pnpm --dir api dev`,
    },
    web: {
      port: (k) => 3000 + k,
      reserves: true,
      command: (_w, ports) => `PORT=${ports.listen('web')} API_URL=http://localhost:${ports.addr('api')} exec pnpm --dir web dev`,
    },
  },
  logs: 'pane',
  setup: generic.setup,
  dev: () => undefined,
};

export default shop;
```

- `ports.listen(s)` is where a service binds; `ports.addr(s)` is where its clients reach it. They differ only for a shared service behind the proxy.
- `reserves: true` makes the port part of every slot's reservation, so a slot whose port is taken is skipped.
- `command` gives a service its own `app-<name>` window. Services without one run together in the `dev` window through the profile's `dev(w, services, ports, pkgs)`, which returns one shell command.
- `logs: 'turbo'` reads per-task output from Turbo's `--log-file` and discovers every `apps/*/package.json` with a `dev` script as a service; Next and Vite apps get ports in `10000 + 1000·k + offset`. `'pane'` logs each window's output.
- `share: '/health'` on a service plus `base: '<path>'` on the profile makes the service shared from a base checkout.
- `device: 'sim' | 'emu'` plus a `mobile` block (app id, scheme, Xcode workspace, simulator and AVD models, builder checkout, prebuild commands) runs an Expo dev client per worktree on macOS: a simulator cloned from a template and an AVD named after the worktree, with the dev client built once per native fingerprint and cached. `mobile.login` can sign the app in on each new device.

## Claude Code hooks (optional)

With these hooks in `~/.claude/settings.json`, Claude Code creates worktrees through wt, installs dependencies when a worktree's first session starts, tells each session which ports its servers use, wakes a sleeping environment on the next prompt, and purges the environment when it removes the worktree:

```json
{
  "hooks": {
    "WorktreeCreate": [{ "hooks": [{ "type": "command", "command": "wt hook create" }] }],
    "WorktreeRemove": [{ "hooks": [{ "type": "command", "command": "wt hook remove" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "wt hook session-start" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "wt hook prompt" }] }]
  }
}
```

`wt hook create` branches new worktrees from the freshly fetched remote default branch, under `<repo>/.claude/worktrees/`. `wt hook remove` refuses uncommitted work and keeps unmerged branches.

## Configuration

Environment variables, or `KEY=value` lines in `~/.claude/wt/config`:

| variable          | default                       | meaning                                                         |
| ----------------- | ----------------------------- | --------------------------------------------------------------- |
| `WT_IDLE_MINUTES` | `240`                         | idle time before an environment stops; `0` turns it off         |
| `WT_REPO`         | the first repo profile's repo | the repo `wt clean` and `wt --help` use outside any checkout    |
| `WT_HOME`         | `~/.claude/wt`                | state, logs and the config file                                 |
| `WT_PROFILES`     | `<checkout>/profiles`         | repo profiles                                                   |
| `WT_CORE`         | `wtcore`                      | the worktrunk binary                                            |
| `WT_BUN`          | `~/.bun/bin/bun`, else `bun`  | the Bun binary                                                  |

`PATH`, `APP_ENV` and every `WT_*` variable are passed into the tmux windows wt starts, so a repo profile can read its own settings from them.

## Development

```bash
bun install
bun run check   # tsc
bun test        # needs tmux and wtcore
```

## License

MIT
