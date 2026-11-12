# Broadcast daemon startup and recovery

## What is fixed in API/server release 1.0.33

- Render `hostname:port` input is converted to an HTTP origin. Other protocols,
  embedded credentials, paths, query strings and fragments are rejected.
- Leadership database operations have independent six-second client deadlines.
  The pinned leadership transaction also has a five-second PostgreSQL statement
  timeout, configured inside the transaction for pooler compatibility.
- An overall three-minute startup deadline exits a process that would otherwise
  keep its health socket open forever without starting the engine.
- `/healthz` and `/readyz` expose `startupPhase`. Health is process liveness;
  readiness remains HTTP 503 until engine startup finishes.
- Before readiness, broadcast REST/SSE/WebSocket paths return HTTP 503 with
  `BROADCAST_DAEMON_NOT_READY` and `Retry-After: 5`. An unstarted engine must not
  return an apparently valid OFF AIR snapshot.
- The first leadership contention records exact-key lock-owner metadata.
  New leader transactions identify their service in `pg_stat_activity`.
- Heartbeats cannot accumulate overlapping queries. Lost ownership still
  fails closed. Shutdown has a 15-second final deadline and destroys the
  dedicated leadership connection rather than returning an open transaction.
- A missing scratch leaf directory is recreated when its parent exists.
  A missing mount hierarchy is not silently replaced. Failed filesystem checks
  preserve the last measured disk constraint.

## Important production finding

On 2026-11-12, read-only checks against the same Neon endpoint/database named in
the supplied Render logs found a granted broadcast leadership lock whose owner
continued executing lock-inspection heartbeats between samples. The development
PG database was separately checked and was not that production owner.

This is **not evidence of an abandoned lock**. A Render service labeled Live can
still be unready, and the exact hosting instance behind the existing owner has
not been identified. Do not automatically terminate its PostgreSQL session,
change the lock key, disable leadership protection, or restart the database.
An active heartbeat is also not proof of audience media delivery.

## Read-only production checks

Run inside the daemon's Render Shell after this revision has been deployed:

```sh
node scripts/diagnose-broadcast-daemon.mjs
```

This prints local readiness and exact broadcast-lock session metadata only.
It never prints the database connection string, starts an engine, acquires a
leadership lock, or terminates another session.

The local readiness check alone is:

```sh
curl --max-time 10 -i http://127.0.0.1:9000/readyz
```

From the API service's Shell, use the hostname copied from the daemon's current
Connect → Internal panel:

```sh
curl --max-time 10 -i http://DAEMON_HOSTNAME:9000/readyz
```

Both must report HTTP 200 and `runtimeReady: true`. HTTP 503 is a working
connection to an unready runtime. Connection refusal is a different failure.

## Controlled production recovery gate

1. Confirm current Render service and deployment instances, including overlapping
   old instances and any other environment connected to the same production DB.
2. Identify the active leader using service logs and database activity metadata.
   Older releases used a generic application name, so that label alone does not
   identify the hosting service.
3. If an old instance is identified, arrange a controlled stop of that instance,
   acknowledging possible audience interruption. Do not terminate an unknown
   lock owner merely because it blocks a replacement.
4. Deploy the corrected release through the existing services; do not create a
   second Blueprint or change hosting plans as part of this fix.
5. Confirm leader acquisition, `orchestrator started`, local and API-to-daemon
   readiness, and current state through the public API.
6. Confirm actual audience playback and admin synchronization. A ready clock
   and a database lock alone do not prove media continuity.

Repository changes and development verification do not establish that the live
incident is resolved. Production deployment and controlled leader handoff remain
explicit release gates. No production session was terminated by this work.

## Verification performed

- API TypeScript check and production bundle build passed.
- Recovery suite: 17 passing tests, no skips. Includes actual PostgreSQL
  contention on a separate test key, connection-loss handoff, startup/query
  deadlines, readiness gates, and scratch directory recovery.
- Existing admin-continuity suite: 21 passing tests, no skips. Some readiness
  tests are shared between the two suites; these are not 38 distinct tests.
- Development API and daemon were restarted once after the final code changes.
  The daemon acquired leadership, started the orchestrator, and reported
  HTTP 200, `runtimeReady: true`, `startupPhase: ready`.
- Direct daemon state and API-proxied state returned HTTP 200 with the same
  current item, sequence and anchor. The item survived the restart; the restored
  anchor differed by one millisecond rather than restarting from zero.
- An actual WebSocket connection through the API received the daemon hello
  frame. This is transport verification, not audience media certification.
- The unchanged admin sign-in page rendered. Its screenshot contained two
  existing resource 404s; no claim of exhaustive asset verification is made.
- The development toolchain reports Node 20.20.0 versus the repository's Node
  22+ requirement. Render's supplied logs used Node 24.13.0; that runtime was not
  reproduced locally.
- A public production broadcast-health request did not respond within 12
  seconds. Production recovery remains unconfirmed.
- Outbound mail configuration/authentication warnings are separate from daemon
  startup and require valid operator-provided SMTP configuration.
