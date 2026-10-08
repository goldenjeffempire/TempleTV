# Viewer-count verification — 2026-10-08

## Status: development verified; production acceptance NOT COMPLETE

The user's installed-mobile + admin real-world acceptance requirement remains
a blocking release gate. No production deployment, Git push, Expo binary build,
or broadcast-daemon restart was performed for this work.

## Implemented

- PostgreSQL-backed opaque credentials and expiring presence leases shared
  across service instances. Only credential hashes are stored.
- Distinct authenticated-owner counting; anonymous installations reuse their
  capability across player transitions, login/logout, background/foreground,
  reconnects and API restarts.
- Atomic sequence-ordered renewal and leave tombstones. Delayed messages cannot
  undo a newer leave or reconnect.
- Foreground, active-player presence rather than counting admin/observer/sync
  connections. Ten-second mobile heartbeats; default 25-second lease expiry.
- Two-second reconciliation and coalesced event publication, including final
  zero and recovery. Startup database failures retain automatic retry.
- Playback snapshots, WebSocket count frames and admin statistics share one
  authority. New snapshots use the statistics freshness barrier.
- Unavailable/stale counts are unknown, not a fabricated zero. Zero is rendered
  when the ledger actually reports no viewers.
- Server principal assignment, canonical stream validation, random
  capabilities, rejection of invented credentials, parameterized SQL,
  per-capability heartbeat limits, and explicit store errors.
- Credentials/leases/peaks are durable. Five-minute sparkline samples remain
  process-local and are not a durable analytics history.

## Evidence

1. **16 unit/contract tests passed:** active-player classification, credential
   resumption and ordering, authenticated issuance, zero/unknown delivery,
   WebSocket cleanup and admin query/invalidation contracts.
2. **Live PostgreSQL integration passed:** 100 concurrent controlled clients,
   repeated heartbeats, authenticated multi-device deduplication, login/logout,
   delayed-message races, rapid concurrent exits/rejoins, two service instances,
   service-object restart recovery, expiry-to-zero publication, persisted peak
   and explicit store-outage handling. Latest 100-client issue/join duration:
   approximately 2.1 seconds in this development environment.
3. **Running-server protocol integration passed:** two actual vendored mobile
   BroadcastEngine WebSocket clients, HTTP playback state and authenticated
   admin statistics agreed through joins, duplicate/resume, ordering races,
   explicit departure and missing-heartbeat expiry. Observed convergence:
   22–207 ms in the initial run; the final run including real authenticated
   multi-device and login/logout transitions stayed within three seconds
   (maximum observed 2.561 seconds). This exercises the mobile
   transport code in Node, not React Native on an installed device.
4. **Authenticated browser retest passed without reloading admin:** controlled
   clients kept five-second heartbeats during active phases; admin UI, HTTP and
   fresh WebSocket snapshots followed `0 → 2 → 1 → 2 → 0`. Each phase converged
   within three seconds (measured 1.289–2.832 seconds). A transient raw snapshot
   discrepancy occurred during an in-flight transition, then converged.
5. Invalid credentials returned 401; unsupported stream returned 400;
   unauthenticated statistics returned 401. Excess heartbeats returned 429
   without blocking the other client behind the same IP.
6. API build and API/mobile/admin/TV type checks passed.
7. A controlled actual-API-restart probe was attempted. It observed prolonged
   API unavailability and reached its 90-second deadline before observing a
   successful rejoin. A subsequent running-server suite passed after the API
   returned. **Actual-process restart recovery is not signed off.**

These clients were controlled development protocol participants. They are not
evidence of real people watching real media. The browser pass did not prove
admin EventSource connectivity. Intermittent unrelated 502/503 resource errors
were observed; actual TV playback could not be established with the daemon
stopped.

## Blocking release gates

- Install a staging/release-equivalent Android build on real devices. Verify
  actual broadcast playback, hero/fullscreen transitions, pause, background,
  screen lock, force-close, Wi-Fi/cellular transitions and reconnects against
  the continuously open admin UI.
- Exercise actual API/daemon process restart, temporary database/network
  failures and a sustained target-concurrency load on isolated staging.
  Two service objects and 100 database clients are not a production capacity
  benchmark or proof of process-kill/device recovery.
- Strengthen anonymous enrollment against automated inflation. A public
  capability issuer and rate limits do **not** prove installation uniqueness
  or that a human is watching. Native app attestation/verified enrollment and
  an explicit web/TV guest policy are required for the requested stronger
  security guarantee. Do not trust a client-supplied platform/device label.
- Validate rollout compatibility for installed older clients: capability
  resumption and client sequence ordering require the updated app protocol.
  Do not assume a backend-only deployment gives older binaries those features.
- Validate admin EventSource reconnect/delivery directly, including reverse
  proxy behavior. Polling convergence alone is not SSE acceptance.
- Obtain deployment approval and native/staging evidence before production
  sign-off. No numbers should be inserted into production to simulate viewers.

## Repeatable development checks

Run sequentially, not simultaneously: the DB fixture uses its own stream but
aggregate admin statistics include all fixture streams while the test runs.
The HTTP test requires the private, temporary development account prepared for
the test runner; it refuses production mode and only targets loopback.

```sh
NODE_ENV=development RUN_VIEWER_DB_TESTS=1 \
  node --import tsx --test artifacts/api-server/tests/integration/viewer-presence-lifecycle.test.ts

NODE_ENV=development RUN_VIEWER_HTTP_TESTS=1 \
  node --import tsx --test artifacts/api-server/tests/integration/viewer-http-lifecycle.test.ts
```
