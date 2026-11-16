# wt

Per-worktree dev environments for coding agents, on macOS and Linux.

Agents work best in parallel, one git worktree each. Without help they collide on ports, skip `npm install` and the gitignored `.env` files, leave dev servers running in deleted directories, and can't see each other's server logs. wt gives every worktree its own environment:

- **Setup:** `wt up` copies the main checkout's `.env` files and installs dependencies.
- **Own ports:** `wt up dev` starts the dev server on the worktree's port (`:3001`, `:3002`, …) in a tmux session wt owns.
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

- **Profiles** are named sets of services; a worktree runs the union of the ones it was given. Every repo has `bare` (nothing), `code` (setup only) and `dev` (`code`, then the `dev` script with `PORT` set; Vite also gets `--port`).
- **Slots:** each worktree takes the lowest free slot `k` (1–20) and every service's port derives from it, such as `3000 + k`. The main checkout is slot 0.
- **Processes** run in a tmux session `wt-<name>`, in bash login shells with your `PATH` appended. Output goes to `~/.claude/wt/<name>/`, along with the rest of wt's state.
- **Idle:** a watcher stops the environment after `WT_IDLE_MINUTES` (240) without agent activity or an attached terminal; `wt up` brings it back.
- **Cleanup:** `wt clean` keeps worktrees where a `claude` or `codex` process runs, or where an unarchived Claude desktop session works. Removing a worktree through wt (`wt clean`, `wt remove`, the hooks) purges its environment.

wt runs worktrunk with its own bundled config (`worktrunk.toml`), so worktrees it creates go under `<repo>/.claude/worktrees/`.

## Repo profiles

A module at `~/.wt/profiles/<name>/index.ts` (gitignored) adds a repo's own services. See `RepoProfile` in `src/profile.ts`.

```ts
import { join } from 'node:path';
import { HOME } from '../../src/env.ts';
import { generic } from '../../src/generic.ts';
import type { RepoProfile } from '../../src/profile.ts';

export default {
  name: 'shop',
  repo: join(HOME, 'projects/shop'),
  profiles: { api: ['api'], web: ['api', 'web'] },
  describe: 'api, web (api and the storefront)',
  services: {
    api: { port: (k) => 8000 + k, reserves: true, command: (_w, p) => `PORT=${p.listen('api')} exec pnpm --dir api dev` },
    web: {
      port: (k) => 3000 + k,
      reserves: true,
      command: (_w, p) => `PORT=${p.listen('web')} API_URL=http://localhost:${p.addr('api')} exec pnpm --dir web dev`,
    },
  },
  logs: 'pane',
  setup: generic.setup,
  dev: () => undefined,
} satisfies RepoProfile;
```

Profiles can also run Turbo monorepos (`logs: 'turbo'` discovers `apps/*` dev scripts), share expensive backends from one base checkout (`base`, `share`), and run an Expo dev client on a per-worktree iOS simulator and Android emulator (`mobile`).

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

Environment variables, or `KEY=value` lines in `~/.claude/wt/config`: `WT_IDLE_MINUTES` (240, `0` disables), `WT_REPO` (the repo `wt clean` uses outside any checkout), `WT_HOME` (`~/.claude/wt`), `WT_PROFILES`, `WT_CORE` (`wtcore`), `WT_BUN`. `APP_ENV` and every `WT_*` variable reach the servers wt starts.

## Development

`bun install`, then `bun run check` and `bun test` (needs tmux and wtcore).

## License

MIT
