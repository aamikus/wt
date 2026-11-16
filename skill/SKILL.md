---
name: wt
description: Runs and inspects per-worktree dev environments with the wt CLI. Use when working in a git checkout or worktree and you need dependencies installed, a dev server running, a service's port or logs, or a restart. Use wt instead of running install or dev-server commands yourself.
---

# wt

wt runs each worktree's dev servers on its own ports in a session it owns. Never start dev servers yourself (`npm run dev`, `pnpm dev`, `next dev`, `expo start`) and never kill processes on wt's ports.

- `wt ls`: what runs, and on which ports. Use those ports, never framework defaults.
- `wt --help`: this repo's profiles.
- `wt up`: install dependencies. `wt up <profile>` (e.g. `wt up dev`): start servers.
- `wt logs <service>`: a server's recent output. `wt logs up`: setup and startup.
- `wt restart` after env changes; `wt down` to stop.

`wt up` returns at once and continues in the background. Poll `wt logs up` until the last line is `up: ready — …` (followed by one `<service>: http://localhost:<port>` line each) or `up: failed`.

Never pass `-f` to `wt logs` or run `wt attach`: both block forever. Run `wt clean` only when the user asks; it deletes worktrees and branches.
