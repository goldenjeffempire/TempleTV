---
name: Production supervisor for VM deployment
description: Replit Reserved VM deployments publish one process tree; scripts/prod-supervisor.mjs runs daemon+API as two supervised child processes inside it to isolate broadcast continuity from API crashes/restarts.
---

## Rule
`.replit [deployment].run` invokes `node scripts/prod-supervisor.mjs` (not `dist/index.mjs` directly). The supervisor spawns the broadcast daemon (`RUN_MODE=broadcast`, loopback `127.0.0.1:9000`) and the API (`RUN_MODE=all`, public port, `BROADCAST_DAEMON_URL` pointed at the daemon) as independent child processes, restarting either one independently on crash with backoff, and draining API-then-daemon on SIGTERM.

**Why:** a Replit VM deployment is one publishable process tree — you cannot run the daemon as a second, separately-published always-on service the way `render.yaml` once anticipated (see `broadcast-daemon-architecture.md`). Before this, `RUN_MODE=all` in a single process meant any API crash/OOM/unhandled-exception also killed the live 24/7 broadcast. The supervisor is the closest available approximation to true decoupling on this platform: it isolates the daemon from every failure *except* a genuine full redeploy (new container), and DB checkpoint/hydrate makes even that sub-second (see `broadcast-continuity-fixes.md`).

## How to apply
- Never edit `.replit [deployment].run` back to a bare `node dist/index.mjs` — that reintroduces the single-point-of-failure this fixes.
- If you change per-process memory/heap tuning for prod, edit the `daemonEnv`/`apiEnv`/`daemonArgs`/`apiArgs` objects in `scripts/prod-supervisor.mjs`, not `.replit`.
- The script is deliberately dependency-free (Node built-ins only) so it never needs `pnpm install`/build to run — safe to invoke as the very first thing in the deploy run command.
- Reserved VM deployments only support ONE externally-routed port (`docs`: exposing more than one causes the publish to fail) — the daemon's port must stay loopback-only and never get an `externalPort` mapping in `.replit`.
- This same script/pattern can be reused for `render.yaml` if the user ever wants daemon isolation there too — Render's constraint is no free *worker service* tier, but running two OS processes inside one existing web service costs nothing extra.
