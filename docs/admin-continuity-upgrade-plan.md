# Temple TV admin modernization and broadcast continuity

## Non-negotiable boundary

The administration browser is a remote controller and observer, never a broadcast
worker. Closing it, logging out, losing its network, or crashing its UI must not
send playback lifecycle mutations or stop server sequencing.

## Initial architectural audit

- The existing Fastify broadcast daemon already owns the queue, wall-clock
  sequencing, checkpoint persistence and independent supervised workers.
- The API proxies broadcast snapshots/SSE/WebSockets to that daemon. Admin
  authentication is not the daemon's lifetime or leadership mechanism.
- PostgreSQL runtime/checkpoint state and the daemon's singleton advisory lock
  already protect restart recovery and concurrent daemon ownership.
- Admin preview disables stall reporting but the shared web-player session still
  emits natural-end mutations. Make monitoring sessions explicitly read-only.
- Admin SSE already has exponential backoff, health probes, reconnect
  invalidation and visibility/network recovery. Preserve these mechanisms.
- Render already separates the daemon (starter private service), API (free web
  service) and static admin. Its daemon currently rebuilds on every main commit.
  Limit daemon deploy triggers to runtime dependencies, not admin/mobile changes.
- Uploaded media is still served by the API process. A media/API process failure
  is not an administrative-browser failure and can affect uncached playback.
  Do not imply that daemon isolation alone eliminates this dependency.
- Blueprint plans are configuration evidence, not proof of the actual account's
  running plans. Production service access is needed to verify deployed parity.

## Implementation order

1. **Runtime boundary:** isolate read-only monitoring sessions from viewer
   lifecycle signals; preserve autonomous server timers, durable recovery and
   mobile contracts. Add regression tests.
2. **Operational visibility:** real authenticated administrator connection counts,
   last synchronization time, daemon/current/next/uptime health and recovery
   information. Unknown/unreachable must not appear as healthy or as zero.
3. **Admin modernization:** improve shared responsive design, navigation, login,
   dashboard and broadcast controls without removing existing routes or actions.
   Disconnected controls must not imply that an on-air broadcast has stopped.
4. **Validation:** production builds, focused automated integration tests and one
   browser failure-simulation pass. Exercise closing, offline, refresh, logout,
   reconnect and server recovery only against development/test services.

## Safety and release gates

- No live-service restart, production fault injection, production database
  mutation, paid-plan change, external deployment or main-branch push is
  authorized merely by implementing this upgrade.
- Do not replace the existing database/media storage.
- Database leadership loss must fail closed rather than permit two authoritative
  daemons. Temporary non-leadership query failures must not stop the in-memory
  broadcast clock.
- Free-tier API sleep/resource limits, shared media delivery and full-service
  replacements can still interrupt delivery. Always-on infrastructure and
  production failover acceptance require an operator decision.
- Publish exact test evidence and explicitly mark unexecuted production/native
  scenarios. Never label fixture-based tests as production verification.
