# wt

Per-worktree dev environments for coding agents, on macOS and Linux.

Agents work best in parallel, one git worktree each. Without help they collide on ports, skip `npm install` and the gitignored `.env` files, leave dev servers running in deleted directories, and can't see each other's server logs. wt gives every worktree its own environment:

- **Setup:** `wt up` copies the main checkout's `.env` files and installs dependencies.
- **Own ports:** `wt up <service>` starts a workspace app's dev server on the worktree's own port, in a tmux session wt owns. No config needed.
- **Visible:** `wt ls` lists every worktree with its services and ports; `wt logs <service>` prints any server's output.
- **Self-cleaning:** idle environments stop after 4 hours, and removing a worktree removes its servers, processes and caches.
- **Agent-aware:** a bundled skill tells Claude Code and Codex to use wt instead of starting servers.

```
$ wt ls
  NAME          PROFILES  SETUP  SERVICES

shop
  fix-checkout  web       ok     api :8001 · web :3001
  search-v2     code      ok     no services
```

## Install

```bash
git clone https://github.com/aamikus/wt ~/.wt && ~/.wt/install.sh
```

The installer adds Bun, tmux and [worktrunk](https://github.com/max-sixty/worktrunk) (as `wtcore`) if missing, links `wt` into `~/.local/bin`, adds `eval "$(wt shell-init)"` to your bash, zsh or fish config, and links the agent skill into `~/.claude/skills` and `~/.codex/skills`. It needs git 2.43+ and lsof. Update with `git -C ~/.wt pull`.

## Commands

Commands act on the worktree containing the current directory, or on a named one (path, branch or directory name).

| command                        | does                                                                    |
| ------------------------------ | ----------------------------------------------------------------------- |
| `wt up [<profile>...]`         | add profiles and start what they need; no profile: restore, or `code`   |
| `wt down`                      | stop the worktree's servers                                             |
| `wt ls [--json]`               | every worktree wt knows, with its services and ports                    |
| `wt logs <service> [-f]`       | print or follow a service's output; `wt logs up` shows setup            |
| `wt restart`                   | restart the worktree's servers                                          |
| `wt attach [<service>]`        | open the worktree's tmux session                                        |
| `wt cd` / `wt path`            | cd into / print the worktree's directory                                |
| `wt clean [<name>...] [--yes]` | report, or remove, merged worktrees and branches and their leftovers    |

## How it works

- **Services** are a repo's dev servers. wt finds every workspace package with a `dev` script (pnpm, npm, yarn and bun workspaces, else `apps/*`) and runs it with the lockfile's package manager in a tmux session `wt-<name>`. A repo config adds more.
- **Profiles** are named sets of services, and a worktree runs the union of the ones it was given. Every repo has `bare` (nothing) and `code` (setup only), and each service is a profile of its own; a repo without a config also has `dev`, its root `dev` script.
- **Ports:** each worktree takes the lowest free slot `k` (1–20). A service gets `PORT` (Next and Vite also `--port`) on its configured port plus `k`, or else on a port from the slot's own block. The main checkout is slot 0.
- **Setup:** `wt up` copies the main checkout's gitignored `.env` files and installs dependencies once per worktree.
- **Idle:** a watcher stops the environment after `WT_IDLE_MINUTES` (240) without agent activity or an attached terminal; `wt up` brings it back.
- **Cleanup:** `wt clean` keeps worktrees where a `claude` or `codex` process runs, or where an unarchived Claude desktop session works. Removing a worktree through wt (`wt clean`, `wt remove`, the hooks) purges its environment.

State and logs live in `~/.local/state/wt/<name>/`. wt runs worktrunk with its own bundled config (`worktrunk.toml`), so worktrees it creates go under `<repo>/.claude/worktrees/`.

## Repo config

`~/.config/wt/repos/<name>.toml` describes a repo when discovery isn't enough. It is one self-contained file: matched by the repo's git remote, it works wherever a teammate cloned the repo, so sharing a setup means sending the file.

```toml
remote = "acme/shop"                # the origin remote; or repo = "~/path" for the checkout
base = true                         # share services that have a health check (below)
setup = ["pnpm db:migrate"]         # after copying .env files and installing

[profiles]
web = ["api", "web"]

[services.api]
package = "@shop/api"               # default: the workspace package named like the service
port = 8000                         # default: a port from the slot's block
health = "/health"
files."apps/api/.env.local" = { PORT = "{port}" }

[services.web]
env = { API_URL = "{api.url}" }     # where this worktree reaches its api
setup = "pnpm -F @shop/web codegen" # once per worktree, before web first starts
```

- **Ports reach a service** as `PORT` in its environment, unless `env` or `files` name `{port}` themselves. `{<service>.port}` and `{<service>.url}` point at another service of the same worktree, `{config}` at the config's folder.
- **`files`** sets keys in env files for apps that ignore their process environment: a missing or wt-written file is written whole, any other file only gets those keys replaced.
- **`command`** replaces the inferred `dev` script. `setup` entries and `command` are bash, so multi-line `'''` strings keep a repo's scripts in the file. `copy` (default `["**/.env*"]`) and `install = false` change setup.
- In a **Turbo repo**, configured services without a web server run together in one `turbo run dev`, so shared packages' watchers run once.
- **`[mobile]`** runs an Expo dev client per worktree on its own iOS simulator and Android emulator (macOS); see `Mobile` in `src/profile.ts`. Its `login` script gets the device and `sim` or `emu` and can open a sign-in link with `wt _open-url "$1" <url>`.

### Shared services

A heavy backend shouldn't run once per worktree. With `base = true`, wt keeps a checkout of the default branch at `<repo>/.claude/worktrees/.wt-base` and runs every service that has a `health` path there, once. Each worktree's port for that service is a small proxy to the base. When the worktree changes the service or a package it depends on (its `git diff` against the merge-base, through Turbo's package graph), wt starts the worktree's own instance and the proxy switches to it once its health check passes. `wt up api` starts one right away. The base follows the default branch and stops when no worktree uses it.

## Claude Code hooks (optional)

These hooks in `~/.claude/settings.json` let wt create Claude's worktrees from the fresh remote default branch, set them up on the first session, report ports to each session, wake idle environments on the next prompt, and purge environments on removal:

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

## Configuration

Environment variables, or `KEY=value` lines in `~/.config/wt/config`: `WT_IDLE_MINUTES` (240, `0` disables), `WT_REPO` (the repo `wt clean` uses outside any checkout), `WT_HOME` (state, `~/.local/state/wt`), `WT_CONFIG` (`~/.config/wt`), `WT_CORE` (`wtcore`), `WT_BUN`. `APP_ENV` and every `WT_*` variable reach the commands wt runs.

## Development

`bun install`, then `bun run check` and `bun test` (needs tmux and wtcore).

## License

MIT
