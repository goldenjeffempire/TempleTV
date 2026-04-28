# Temple TV — Enterprise Streaming Platform Roadmap

Status: April 28 2026.
Author: handoff from the OOM mitigation work in `docs/oom-diagnosis-2026-04-28.md`
and the cache hardening shipped in commit after `0b6901b`.

This document is the honest, ordered, effort-bounded roadmap for the
"world-class enterprise streaming platform" wishlist. It is split into
phases by **what unblocks the next phase**, not by feature popularity. Each
item lists scope, effort estimate, prerequisites the operator must
provision, and the production guardrails that should be in place before
shipping.

The principle behind the ordering: the platform must be **observably
stable** before it can be **architecturally upgraded**. Shipping dual-
player prebuffer on top of a service that OOM-restarts every 15 min is
how you ship a slower bug.

---

## Phase 0 — Stop the bleeding (in flight; partially shipped)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 0.1 | YouTube scraper unbounded `response.text()` → `boundedText()` + `freshString()` | DONE (commit `0b6901b`) | Eliminates the v8 substring-sharing leak that pinned 1 MB HTML pages per `videoId` lookup. |
| 0.2 | L1 `MemoryCache` capped (LRU eviction, default 1024 entries) | DONE (this commit) | Eliminates the unbounded keyspace growth class. |
| 0.3 | `PgCache.set` deduplicate `JSON.stringify` (was called twice per write) | DONE (this commit) | Cuts ~52 MiB/min of broadcast-snapshot allocation churn. |
| 0.4 | Operator removes Render dashboard `RUN_MODE=all` override on `temple-tv-api` | OPERATOR ACTION | Confirmed in latest boot log: `runMode: "api"` now active — done. |
| 0.5 | `MEMORY_RESTART_RSS_MB` deliberately stays at `0` | INTENTIONAL | See `render.yaml` comment block: graceful self-restart caused the 2026-04-27 LB-race restart loop. OOM-killer is INSTANT (no socket window for the LB to race against), graceful drain is NOT — keep it disabled. |

**Exit criteria for Phase 0:** 24 h of production uptime with zero
OOM-kills, RSS p95 < 1.5 GiB, `arrayBuffersMb` flat over 8 h windows.

---

## Phase 1 — Multi-instance enablement (1–2 days, blocks horizontal scaling)

Prerequisite: provision **managed Redis**. Render Key Value, Upstash, or
Aiven all work. Set `REDIS_URL` on the `temple-tv-shared-secrets`
environment-variable group in the Render dashboard. No code change is
needed — every consumer already sniffs `REDIS_URL` and self-enables:
`liveEventsBus.ts:407`, `cache.ts:203`, `rateStore.ts:111`.

| # | Item | Effort | Notes |
|---|------|--------|-------|
| 1.1 | Provision managed Redis | OPS, 30 min | Frankfurt region to keep it in the same AZ as `temple-tv-api`. Standard plan with persistence is fine; we use it for pub/sub + ephemeral cache, not durable state. |
| 1.2 | Set `REDIS_URL` on `temple-tv-shared-secrets` | OPS, 5 min | Bus arms automatically on the next deploy or instance restart. Boot log will switch from `[liveEventsBus] REDIS_URL not set — bus DISABLED` to `[liveEventsBus] bus ARMED — cross-instance SSE fanout active`. |
| 1.3 | Bump `numInstances: 1` → `numInstances: 2` on `temple-tv-api` | OPS, 5 min | Only safe AFTER 1.2 — otherwise SSE fanout is per-pod and admin actions on instance A don't reach SSE clients on instance B. |
| 1.4 | Verify cross-instance fanout via `/api/admin/sse-bus` | DEV, 30 min | Already exists (Round 19). Confirm `health: "ok"` and non-zero `published`/`received` after admin actions. |

**Exit criteria for Phase 1:** ≥2 instances serving, admin actions on
either instance fan out to SSE clients on both within 100 ms p95.

---

## Phase 2 — Observability foundation (2–3 days, blocks safe perf work)

You can't tell whether a perf change helped if you don't have p50/p95/p99
on the broadcast endpoints. Today the only signal is the access log.

| # | Item | Effort | Notes |
|---|------|--------|-------|
| 2.1 | Per-route latency histogram (p50/p95/p99) emitted to Sentry breadcrumbs | DEV, ½ day | The `requestMetrics` middleware already exists; widen it to record per-path-pattern histograms. |
| 2.2 | Cache hit/miss/cold-build counters per cache key, exposed on `/api/admin/ops/status` | DEV, ½ day | Already partially in place; surface the broadcast-build path counter that's recorded by `recordBroadcastBuildLatency`. |
| 2.3 | Memory-class breakdown panel in Mission Control | DEV, ½ day | Already have the snapshot data; render the time-series. |
| 2.4 | Optional: external metrics backend (Grafana Cloud Free, Datadog free tier) | OPS + DEV, 1 day | Only if internal Mission Control is insufficient. |

**Exit criteria for Phase 2:** any deploy can be evaluated against a
known baseline within 5 minutes of going live.

---

## Phase 3 — Broadcast latency optimisation (3–5 days)

The "<50 ms broadcast APIs" goal is achievable but the path matters.

| # | Item | Effort | Notes |
|---|------|--------|-------|
| 3.1 | Inline DB indices audit (`scheduleTable`, `broadcastQueueTable`, `videosTable`, `liveOverridesTable`, `cacheEntriesTable`) | DEV, ½ day | Most are present; need `cacheEntriesTable.expiresAt` for the GC scan, and a partial index on `liveOverridesTable WHERE endsAt IS NULL OR endsAt > NOW()`. |
| 3.2 | Move broadcast cache from PG to Redis when 1.2 is done | DEV, ½ day | Already implemented (`distributedCache()` prefers Redis). Becomes effective the moment `REDIS_URL` is set. Cuts cold-build latency from ~50–80 ms (PG round-trip) to ~2–5 ms (Redis local). |
| 3.3 | Pre-compute the broadcast snapshot in the transition ticker, write directly to Redis | DEV, 1 day | Today the snapshot is built lazily on first miss. Pre-computing on every transition removes the cold-build path entirely from the request critical path. Combined with 3.2 this gets `/api/broadcast/current` to <10 ms p95 server-side. |
| 3.4 | Conditional GET / `If-None-Match` on `/api/broadcast/current` | DEV, ½ day | Cuts payload bytes to ~250 (304 response) for clients that haven't seen a transition since their last poll — the common case. |

**Exit criteria for Phase 3:** `/api/broadcast/current` p95 < 50 ms,
p99 < 100 ms, 304 ratio > 70 % during steady state.

---

## Phase 4 — Real-time replaces polling (1 week)

The platform already has SSE end-to-end (`liveEvents.ts`,
`broadcastLiveEvent`). What's missing is the *consumers* using it.

| # | Item | Effort | Notes |
|---|------|--------|-------|
| 4.1 | Mobile + TV players: subscribe to `broadcast-current-updated` SSE event, drop the polling loop | DEV, 2 days | Conditional fallback to polling when SSE is unsupported (older Tizen WebViews). |
| 4.2 | Admin: switch `useBroadcastCurrent` from `refetchInterval: 5000` to SSE-driven invalidation | DEV, 1 day | React Query already supports `invalidateQueries` from outside hooks. |
| 4.3 | Stream-health emitter: emit per-pod, fanout via Redis bus when 1.2 is done | DEV, 1 day | Today the per-second emit is local-only (correct), but admin Mission Control aggregates across pods — needs the bus. |

**Exit criteria for Phase 4:** zero `/api/broadcast/current` polling
calls when an SSE connection is active. Visible as a 5-10× drop in
request rate on the access log.

---

## Phase 5 — Dual-player prebuffer + seamless transitions (2 weeks)

The "zero black-screen" goal requires player rewrites on TV, mobile, and
web.

| # | Item | Effort | Notes |
|---|------|--------|-------|
| 5.1 | Define dual-player contract: primary + standby `<video>` elements, swap on `transitionTo` event | DEV, 2 days | Spec the event shape, prebuffer window (default 8 s), swap timing (1 s before primary `endedAt`). |
| 5.2 | Implement on TV (Vite SPA) | DEV, 3 days | Tizen WebView is the constraint — needs careful HW-decoder handoff testing. |
| 5.3 | Implement on mobile (Expo Web + React Native bridge) | DEV, 3 days | iOS Safari has historically had buggy mid-playback `src` swaps; dual-element architecture sidesteps this. |
| 5.4 | Implement on web (admin preview) | DEV, 1 day | Lower priority — admin staff can tolerate the 1 s gap. |
| 5.5 | Server-side: emit `prebuffer-next` SSE event 10 s before each transition with the next item's HLS URL | DEV, 1 day | Already have the transition ticker; just add the lookahead. |

**Exit criteria for Phase 5:** transition gap measured <250 ms p95
(currently 1.5–3 s).

---

## Phase 6 — CDN delivery (1–2 weeks, mostly ops + signed-URL changes)

| # | Item | Effort | Notes |
|---|------|--------|-------|
| 6.1 | Provision CloudFront distribution in front of S3 origin | OPS, 1 day | Origin Access Identity, signed-URL compatibility, 24 h cache TTL on `.ts` segments, 5 s on `.m3u8` manifests. |
| 6.2 | Switch `s3Storage.ts` signed URLs to CloudFront signed URLs | DEV, 2 days | Different signing algorithm (RSA private key vs. AWS sig v4) — modest refactor. |
| 6.3 | CORS + range-request validation on edge | OPS, 1 day | HLS players send `Range:` requests; verify edge respects them. |

**Exit criteria for Phase 6:** segment fetch latency p95 measured at
≤80 ms from each of NA, EU, AS, AF probe locations.

---

## Phase 7 — WebSocket migration (only if needed, 1 week)

SSE is sufficient for current scale. WebSockets become attractive only
when:

- you need bidirectional realtime (chat, viewer reactions, polls)
- you need sub-50 ms client→server latency for player telemetry
- the SSE fanout cost on the bus exceeds the per-connection WS cost

If none of those apply, **don't migrate**. SSE has lower operational
overhead, survives proxies and corporate firewalls better than WS, and
auto-reconnects natively in browsers.

---

## Phase 8 — Operational hardening (continuous)

| # | Item | Effort | Notes |
|---|------|--------|-------|
| 8.1 | Synthetic monitoring (Pingdom / Better Uptime / UptimeRobot) hitting `/api/healthz`, `/api/broadcast/current`, the TV SPA root | OPS, ½ day | 1 min cadence, multi-region. |
| 8.2 | PagerDuty/OpsGenie integration for the existing `sendOpsAlert()` path | OPS + DEV, 1 day | Already wired through Sentry; add the on-call routing. |
| 8.3 | Disaster recovery runbook (DB restore, S3 cross-region replication, deploy rollback) | DOCS, 1 day | One-pager per scenario. |
| 8.4 | Quarterly load test with k6 or Artillery | DEV, ½ day per cycle | Establishes baselines so regressions are measurable. |

---

## What is intentionally NOT on this roadmap

- **Custom video-codec / HLS-manifest rewriter.** ffmpeg's HLS muxer is
  already enterprise-grade. Custom would burn weeks for marginal gains.
- **Microservices split** (separate broadcast-engine service, separate
  scheduler service, etc). The `RUN_MODE=api` / `RUN_MODE=worker` split
  already isolates the heavy workload (transcoding) from the latency-
  sensitive workload (HTTP). Further splits add operational cost without
  proportional benefit at this scale.
- **gRPC between services.** Internal traffic is already low-volume,
  HTTP+JSON is fine. Cost of gRPC tooling > benefit until traffic is 100×.
- **Full Kubernetes migration.** Render's managed platform handles
  deploys, health checks, TLS, autoscale primitives. K8s is multiple
  full-time-engineer-years of operational overhead for no win at this
  scale.
- **Replacing PostgreSQL with anything else.** Neon Postgres at the
  current write rate has 10× headroom. Rewriting onto MongoDB / Cassandra
  / DynamoDB would be a year of regressions for zero user-facing benefit.

---

## How to use this document

1. Phases are ordered by dependency, not difficulty. Don't ship phase 5
   before phase 2 — you'll have no way to measure whether the new
   architecture helped.
2. Effort estimates assume one focused engineer, no concurrent work.
   Multi-engineer teams may parallelise across phases that don't share
   files (e.g., Phase 3 DB work + Phase 4 mobile player work).
3. Every phase has explicit exit criteria. Don't move on without them
   — that's how you accumulate the kind of technical debt that produced
   the April 28 OOM in the first place.
