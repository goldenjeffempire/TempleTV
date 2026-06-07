---
name: Broadcast-v2 dead-air fallback bugs sprint 54
description: Two bugs in the dead-air fallback path of broadcast-orchestrator.ts that permanently disabled recovery after a manual operator stop-override.
---

## Bug 1 — `escalateDeadAir()` hardcoded `kind: "hls"` for fallback URL

**The rule:** `escalateDeadAir()` infers fallback kind from URL pattern — same logic as `applyDeadAirFallback()`.

**Why:** `BROADCAST_DEADAIR_FALLBACK_URL` can be an RTMP URL. The `startOverride()` call in `escalateDeadAir()` previously had `kind: "hls"` hardcoded. An RTMP fallback URL would create an override with the wrong kind, causing the fallback stream to fail silently.

**How to apply:** Any new code path that starts a fallback override must infer `kind` from the URL:
```ts
const fallbackKind: "hls" | "rtmp" = /\.m3u8(\?|$)/i.test(fallbackUrl) ? "hls" : "rtmp";
```

**Fix location:** `broadcast-orchestrator.ts` → `escalateDeadAir()`.

---

## Bug 2 — `stopOverride()` never reset dead-air fallback flags

**The rule:** `stopOverride()` must reset all four dead-air fallback state fields:
- `fallbackOverrideActive = false`
- `deadAirFallbackActive = false`
- `deadAirFallbackOverrideId = null`
- `deadAirDetectedAtMs = null`

**Why:** When an operator manually stops an active fallback override (via REST `POST /override/stop`), both `escalateDeadAir()` and `applyDeadAirFallback()` checked their respective `!this.fallbackOverrideActive` / `!this.deadAirFallbackActive` guards — which remained `true` forever. On the next dead-air event, neither path could activate the fallback override. The broadcast would go off-air with no automated recovery until a process restart.

Also reset `deadAirDetectedAtMs` so the detection threshold restarts from zero rather than triggering immediately on the next timer tick.

**How to apply:** `stopOverride()` is the single exit point for all override terminations. Always reset ALL dead-air fallback state here, not just in the individual recovery cleanup paths.

**Fix location:** `broadcast-orchestrator.ts` → `stopOverride()` — resets added after `this.queueCheckpoint = null`.

---

## Comprehensive audit scope (sprint 54)

All remaining unread files in the broadcast-v2 + transcoder stack were fully audited and confirmed clean:

- `broadcast-fanout.ts` — Redis Pub/Sub fanout, leader election, reader/writer role transitions ✅
- `worker-supervisor.ts` — circuit breaker, backoff, auto-reset timer, stopAll ✅
- `sse.gateway.ts` — per-IP limit, sseCounter drain, aborted sentinel, frameQueue buffer ✅
- `universal-source-resolver.ts` — SSRF allowlist, kind classifier, failover selection ✅
- `orphan-cleanup.ts` — 6-step sweep (event log, orphan refs, stale sessions, notif retention, push tokens, storage parts) ✅ (minor theoretical stop-during-sweep race — non-critical)
- `transcoder.dispatcher.ts` — runOnce, stuck-job watchdog, storage circuit breaker, HLS integrity check, partial-success recovery, auto-retry sweep ✅
- `rest.routes.ts` (1477 lines) — all REST endpoints: health, state, rehydrate, skip, override start/stop, force-failover, reload, report-stall (with cooldown), checkpoint, natural-end, play-now, source-health, clear-bad-urls, prepare-hls, diagnostics, analytics, sync-library, queue-sync-status, transcode-remote, reprobe, remediation-report ✅
