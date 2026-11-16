---
name: wt
description: Runs and inspects per-worktree dev environments with the wt CLI. Use when working in a git checkout or worktree and you need dependencies installed, a dev server or app running, the port a service listens on, its logs, or a restart. Use wt instead of running install or dev-server commands yourself.
---

# wt

wt gives every git worktree its own environment: installed dependencies, its own ports and a tmux session that runs its dev servers. Parallel worktrees never collide on ports, so never start dev servers yourself (`npm run dev`, `pnpm dev`, `next dev`, `expo start` and the like) and never kill processes on wt's ports.

## Commands

All commands act on the worktree containing the current directory.

| goal                                  | command                                       |
| ------------------------------------- | --------------------------------------------- |
| see what runs and on which ports      | `wt ls`                                       |
| list this repo's profiles             | `wt --help`                                   |
| install dependencies only             | `wt up` (gives the `code` profile)            |
| start a profile's servers             | `wt up <profile>`, e.g. `wt up dev`           |
| read a service's recent output        | `wt logs <service>`                           |
| read the setup and startup log        | `wt logs up`                                  |
| restart the servers after env changes | `wt restart`                                  |
| stop everything                       | `wt down`                                     |

## Starting servers

`wt up` returns immediately when its output is not a terminal; setup and startup continue in the background. Poll `wt logs up` until its last line is `up: ready — …` or `up: failed, see above`. On success it prints one `<service>: http://localhost:<port>` line per service; use those ports, never framework defaults like 3000 or 8081.

Profiles add up: `wt up web` then `wt up ios` runs both. An unknown profile name fails with the list of valid ones.

## Rules

- Never pass `-f` to `wt logs` or run `wt attach`: both follow forever.
- When a server misbehaves, read `wt logs <service>` before changing code, then `wt restart`.
- `wt clean` removes worktrees and branches; run it only when the user asks.
- An environment idle for hours stops by itself and shows as asleep in `wt ls`; `wt up` brings it back.
