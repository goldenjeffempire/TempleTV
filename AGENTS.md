# AGENTS.md

## Cursor Cloud specific instructions

Temple TV is a pnpm + TurboRepo monorepo. The deployable web stack for development is:
`@workspace/api-server` (Fastify API), `@workspace/admin` (Vite dashboard), `@workspace/tv`
(Vite Smart-TV app). `@workspace/mobile` is Expo/React Native and cannot run in a browser.
Standard commands live in the root `README.md`, each package's `README.md`, and root
`package.json` scripts — prefer those instead of duplicating here.

### Toolchain / environment gotchas
- Node is pinned to `24.13.0` (`.nvmrc`). The VM has an `/exec-daemon/node` (v22) hard-prepended
  to `PATH` that wins over `nvm use`. Node 24 is made default by a line in `~/.bashrc` that
  prepends `/home/ubuntu/.nvm/versions/node/v24.13.0/bin` to `PATH`. New interactive shells get
  Node 24 + pnpm 10.26.1 automatically; if a non-interactive context resolves the wrong node,
  prepend that bin dir manually.
- A global `NODE_OPTIONS` caps the V8 heap at ~412 MB. `~/.bashrc` appends
  `--max-old-space-size=8192` so builds/typechecks don't OOM. A full first-time `pnpm install`
  needs the larger heap; incremental installs (node_modules already present) do not.
- `pnpm-lock.yaml` is currently out of sync with the root `package.json` (root declares
  `expo`/`react`/`react-native` not yet in the lockfile), so `--frozen-lockfile` fails. Use a
  normal (`--no-frozen-lockfile`) install.

### Database (required for the API)
- PostgreSQL 16 is installed system-wide but does NOT auto-start. Start it with:
  `sudo pg_ctlcluster 16 main start`
- Dev DB/role (matches `docker-compose.dev.yml`): database `templetv_dev`, user `templetv`,
  password `templetv_dev` on `127.0.0.1:5432`. If missing, recreate the role/db with
  `sudo -u postgres`.
- `@workspace/db` and the API throw at boot if `DATABASE_URL` is unset. Apply schema (idempotent,
  no migration files) with `pnpm --filter @workspace/db run push`. Re-run after any schema change.

### Running the services (dev)
- Dev env vars are kept in the untracked `/workspace/.dev-env.sh` (DATABASE_URL, JWT secrets,
  `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`, `TRANSCODER_DISABLE=1`, `YOUTUBE_SYNC_DISABLE=true`,
  etc.). `source .dev-env.sh` before starting the API. There is NO dotenv auto-loading — env must
  be exported in the process environment.
- API: `pnpm --filter @workspace/api-server run build` then `pnpm --filter @workspace/api-server run start`.
  Listens on `PORT` (use `8080` in dev — the admin Vite dev server hardcodes a proxy of `/api` →
  `http://localhost:8080`). Health check: `GET /api/healthz` → `{"status":"ok"}`.
  Default `RUN_MODE=all` runs the broadcast engine in-process; no separate daemon needed in dev.
- Admin: `PORT=3000 pnpm --filter @workspace/admin run dev` → http://localhost:3000
- TV: `PORT=4200 pnpm --filter @workspace/tv run dev` → http://localhost:4200
- Seeded admin login (from `SEED_ADMIN_*`): `admin@templetv.org.ng` / `Temple124@`.

### Lint / test caveats
- Lint: `pnpm run lint` (eslint over `artifacts/{api-server,admin,tv}/src` and `lib`). The repo
  currently has pre-existing lint errors in `lib/player-core` (unused vars / prefer-const in
  tests) — these are not environment issues.
- Automated tests are stubbed out: `pnpm test` (and the per-package `test` scripts) just echo
  "vitest not available" and do nothing. Validate behavior via the running services instead.

### Known non-obvious behavior
- The admin Playlists page (and some other list views) do not always re-fetch after a create —
  the UI can still show "0 playlists" while a green "Playlist created" toast appears and the row
  is correctly persisted in Postgres. Verify writes against the DB when the list looks stale.
