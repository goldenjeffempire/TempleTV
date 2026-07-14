---
name: Artifact vite workflow PORT inheritance collision
description: Multiple artifact vite dev-server workflows can silently collide on the same port when they don't set their own PORT env var.
---

Several `[[workflows.workflow]]` entries for vite-based artifacts (tv, admin, mockup-sandbox) ran `pnpm --filter ... run dev` without exporting `PORT=` in their task `args`. Vite's `vite.config.ts` in each read `process.env.PORT ?? <its own default>`, but a container-level `PORT` env var (observed as 8080 in this repl) was already set and took priority over each app's own default, causing all three to race for port 8080 and fall back to 8081, drifting away from their configured `waitForPort`.

**Why:** `Start API` and `Broadcast Daemon` workflows already followed the correct pattern of explicitly setting `PORT=<value>` in their task args; the three artifact-preview workflows did not, and inherited whatever `PORT` happened to be set in the shell/container environment.

**How to apply:** whenever adding or debugging an artifact/vite/webview workflow that times out with `DIDNT_OPEN_A_PORT` while logs show it eventually landing on a nearby-but-wrong port ("Port X is in use, trying another one..."), check whether the task's shell command explicitly exports `PORT=<waitForPort>` — don't rely on the app's own fallback default matching the platform's `waitForPort`. Also check for cross-workflow port literal collisions (e.g. `artifacts/mobile/package.json`'s `expo start --port 18115` colliding with a separate `artifacts/admin: web` workflow also configured for 18115) — pick a distinct, currently-unused port instead of reusing an existing hardcoded value.

Separately: even after fixing the PORT mismatch, `artifacts/admin: web` and `artifacts/mockup-sandbox: ...` continued to report `FAILED`/`DIDNT_OPEN_A_PORT` across several restarts despite logs consistently showing `ready` on exactly the configured `waitForPort` with `--host 0.0.0.0`, and despite a manual out-of-band `vite --port <N> --host 0.0.0.0` run on the same box responding 200 to curl immediately. Per the `debug-workflow-ports-issues` skill, once code-side health is directly verified this many times, further restarts are a platform-side port-forwarding problem, not something to keep restart-looping.
