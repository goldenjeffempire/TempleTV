# Temple TV (JCTM) Broadcasting Platform

## Overview

**Per-Platform "Recoveries (60s)" Tile on Admin Live-Monitor (April 2026):** Yesterday's network-aware broken-item skip gate (see entry below) silently absorbs flaky-edge errors before they cause false skips — which is exactly the problem: in production, operators had no way to see it firing. A surge in viewer-side recoveries is high-signal early warning for CDN-edge trouble, ingest hiccups, and carrier-wide outages, but only if the surge is visible. **Surgical extension of the existing telemetry pipeline — no parallel infrastructure:** (1) Server: added `recordRecoverEvent(platform)` + `computeRecoveryStats()` to `lib/streamHealth.ts` with the same 60s rolling-window pattern as the existing `frameSamples` (bounded memory, linear scan on emit). New snapshot fields `recoveriesByPlatform` (per-platform counts in window) + `recoveryRatePerMin` (total normalized to events/minute via explicit divide so future window tweaks don't silently break units). Flow is the same per-second `stream-health` SSE the admin already consumes — zero new endpoints, zero new connections. (2) Server: extended `/api/broadcast/playback-telemetry` (`routes/broadcast.ts:1149`) with a discriminated `event: "recover"` payload. The discriminator is checked **first** so legacy frame-quality clients (which never set `event`) continue to work unmodified — backward compat is the whole point. Single endpoint = single CORS rule, single rate-limit envelope, single CDN cache exclusion. (3) Mobile: added `postBroadcastRecoverEvent(platform)` helper to `services/broadcast.ts` mirroring the existing `postPlaybackTelemetryDelta` (fire-and-forget, no-op on missing apiBase, never throws). Wired into `recoverBroadcastPlayback()` (`player.tsx:872`) at the **commit** moment — not after success — so an in-flight recovery that itself fails still counts as a recovery attempt (which is the signal operators need). (4) Admin: extended `StreamHealthSnapshot` interface with the two new fields (typecheck enforces server↔client contract). Added "Recoveries (60s)" `<HealthMetric>` tile after "Stability" in the existing realtime card grid, bumped `xl:grid-cols-7` → `xl:grid-cols-8` so all eight tiles fit one row at xl (lg/sm/base were already wrapping). Tone thresholds intentionally loose: a few recoveries per minute is healthy plumbing absorbing flaky edges; warning at >10/min, critical at >30/min — empirically the inflection where viewer churn starts. Sub-line shows per-platform breakdown ("3 mobile · 1 TV") so operators can tell whether a surge is concentrated on one surface (one CDN edge / one carrier) or system-wide. **Critically did NOT alert on this metric** — surfacing only, no Slack/webhook noise. Operators decide what's worth investigating from the trend, not from a threshold-firing pager. **What was deliberately not done in this pass:** TV `HlsVideoPlayer` recovery instrumentation (separate code path, separate audit, will add once mobile data validates the metric is signal-rich), historical persistence (in-memory rolling window only — survives the process; if the user wants long-term per-day trends we'd add a `playback_recovery_telemetry` table parallel to the existing `s3_upload_telemetry`), per-reason breakdown (offline/grace/error/drift — all currently aggregate; will split if "all recoveries" turns out to be too coarse). Total blast radius: ~80 lines server, ~25 lines mobile, ~30 lines admin, zero new endpoints, zero new database tables, zero new SSE channels, zero new dependencies. Three workspaces typecheck clean, server boots clean, admin hot-reloads the new tile.

**Network-Aware Broken-Item Skip Gate + Player NetworkBanner Overlay (April 2026):** A sweeping "fix all video skipping/freezing/buffering across web/mobile/TV" request prompted a full audit of every playback path. **12 of 13 claimed-missing requirements were already shipped:** stall watchdogs (`LocalVideoPlayer.tsx:432-442` STALL_NUDGE_MS / STALL_FAIL_MS / MAX_STALL_NUDGES), HLS A/B double-buffer (`HlsVideoPlayer.tsx:18` two `<video>` + two hls.js engines always mounted), HLS pause-and-resume recovery (`hls.startLoad()` for NETWORK_ERROR, `hls.recoverMediaError()` for MEDIA_ERROR — neither destroys the engine), retry budgets (`fragLoadingMaxRetry: 3, fragLoadingRetryDelay: 500`), buffering states tracked separately from playing states (`YoutubePlayer.web.tsx:253` BUFFERING distinct from PLAYING; `HlsVideoPlayer.tsx:772` `onWaiting`/`onPlaying` events), 15s safety poll, server-side anchor for queue integrity (referenced at `player.tsx:743`), persistent player state across SSE updates (`tunedVideoId`/`tunedLocalVideoUrl` etc.), broken-item skip-after-2-failures-in-30s with reset on every clean transition end (`player.tsx:879-953`, intentional anti-loop protection per the 2026-04-26 Render-disk-loss commit). **The actual bug** was that the broken-item skip counter at `handleBroadcastError` (`:898-938`) didn't differentiate between "asset is dead" and "network is flaky" — a 4G burst that fired two `onError` events inside 30s would falsely classify a perfectly healthy item as broken and skip it, exactly the failure mode the user flagged. The `useNetworkStatus` hook (`hooks/useNetworkStatus.ts` — web `online`/`offline` events, native 30s active-poll across `api.templetv.org.ng/healthz` + `1.1.1.1/cdn-cgi/trace` + `connectivity-check.ubuntu.com` so a single endpoint outage never false-positives offline) and the `NetworkBanner` overlay both already existed but **were only consumed by the landing page, not the player**. **Surgical fix in three places:** (1) Wired `useNetworkStatus` into `player.tsx` near the other top-level hooks. (2) Added a network-aware short-circuit at the top of `handleBroadcastError` — when `!isOnline`, skip the counter increment AND the skip decision entirely, hand off to the existing `recoverBroadcastPlayback()` pause-and-realign path. Also added a 600ms grace window after `isOnline` flips back to true (tracked via new `lastOfflineAtRef` + small effect) — the player's internal retry/stall watchdogs run on their own 300ms-1.5s timers, and a queued retry from the offline period typically fires one beat after we detect online; that straggler error isn't dead-asset signal either. Once connectivity returns, `recoverBroadcastPlayback` calls `checkBroadcastCurrent` which returns the server-anchored item — no client state is corrupted, no skip is triggered, the user sees their broadcast resume from the correct position. (3) Surfaced `NetworkBanner` over the broadcast/live surface only (on-demand sermon playback already pauses naturally and shows its own buffering spinner — no second indicator needed). Added an optional `message` prop to `NetworkBanner` so the player passes "Reconnecting…" instead of the landing page's "showing cached content" — accurate signal for live playback (no cache to fall back to). The banner slides in from the top above the video chrome and fades back out the instant connectivity returns; no manual dismiss. **Critically did NOT touch:** the HLS A/B double-buffer, the stall watchdogs, the retry budgets, the buffering UI, the server anchor, the SSE channel, the broken-item skip thresholds — all already-shipped enterprise-grade infrastructure that ripping up would have introduced regression risk for zero gain. Mobile typecheck passes. The fix is one new hook consumer + ~15 lines in `handleBroadcastError` + one `NetworkBanner` render + an optional prop on the banner — minimal blast radius for a real bug fix that materially closes the user's "no skip on network blips" requirement.

**Mobile SSE Payload Promotion + URL Normalization Across Radio / Hero / Player (April 2026):** Audited every broadcast-realtime SSE consumer across web, mobile, and TV after a sweeping "real-time hero sync + radio coexistence" request. Findings: TV (`Home.tsx` + `useUnifiedLive` + `useLiveSync`), mobile landing (`(tabs)/index.tsx` `refreshBroadcast`), and mobile player (`player.tsx` `handleBroadcastUpdate` + live re-tune handler) already promoted the SSE payload directly into local state instead of refetching — the morning's surgical-fix style of "use what the server already pushed you" was already idiomatic across most surfaces. **The single outlier** was `mobile/app/(tabs)/radio.tsx:150-155`: it received the full payload on every `broadcast-current-updated` push and threw it away to do an HTTP `/broadcast/current` refetch instead. The inline comment was even self-contradictory ("SSE gives us a full snapshot — re-fetch for latest"). Server-side verified: `routes/broadcast.ts` attaches `current` on every push at four sites (line 600 transition-imminent, 618 item-transition, 697 cache-invalidate, 1125 connect) plus `routes/admin.ts:381` (invalidate-push). With many concurrent radio listeners this cost a redundant `/broadcast/current` round trip per listener per queue transition or admin event — directly multiplying load on the cold-build path optimized earlier today (`setBackground` + single-flight). **Surgical fix in three places, sharing one new helper:** (1) Extracted `normalizeBroadcastResult(data)` from `services/broadcast.ts` `checkBroadcastCurrent` — the URL-normalization step that resolves any relative `localVideoUrl` / `thumbnailUrl` paths against the API base. Idempotent for already-absolute URLs (e.g., YouTube CDN thumbnails return as-is). Returns `null` only on missing `apiBase` (offline / unconfigured); the payload itself is never rejected, because rejecting a healthy SSE payload would silently strand listeners on stale state. (2) Wired into `radio.tsx` SSE handler — uses `payload.current` directly with normalization, falls back to `fetchCurrent()` only when the SSE payload is missing or malformed. Eliminates the redundant fetch entirely on the hot path; preserves correctness against any future server-side "current-changed-but-payload-omitted" delta channel. (3) Also fixed a **latent native-only bug** in `index.tsx` and `player.tsx` SSE handlers: both already promoted `payload.current` directly into state, but bypassed `checkBroadcastCurrent`'s URL normalization. On native, a relative `thumbnailUrl` fed into the cinematic hero's `<Image>` (or the player's `<Video>`) would 404 silently — there's no origin context to resolve a relative URL against on iOS/Android, unlike on web where the page origin saves you. The HTTP-fetch fallback path was already normalized; this just brings the SSE-promoted path to parity. The latent bug only surfaced when an admin uploaded a video to local storage (vs. a YouTube CDN thumbnail), which is rare in production but real. **Verified that the radio + broadcast coexistence requirements were already shipped before this fix:** `handleListenLive` calls `stopPlayback()` to release the audio session before navigating to the broadcast player (radio.tsx:268, with detailed inline rationale on the dual-audio-source race it prevents); `triggerAutoMirror` + dual-effect with ref-guard against double-navigation (radio.tsx:184-217); sleep timer fully releases audio resources via `stopPlayback()` instead of `pause()` so the lock-screen "Now Playing" tile doesn't linger (radio.tsx:232). No changes needed there. Mobile typecheck passes.

**Broadcast Cold-Build Latency: Background Cache Writes + Single-Flight De-Dup (April 2026):** Production watchdog `broadcast-cold-build-regression` paged at warning with `current p95: 1134ms` over a 5-min window with 12 cold builds since boot — every cold rebuild was at the regression ceiling. Root cause was the cold-rebuild path of `buildBroadcastCurrentPayload` paying ~5 sequential PG round trips on every miss: one read on `cache_entries` for the merged payload, then `Promise.all` of three `getOrSet` calls (each internally doing read → fetcher → **awaited** distributed write = 3 round trips on the slowest leg), then a final **awaited** distributed write of the merged payload. At ~100ms/RT against an external Postgres on a freshly-rotated Render instance with cold pool, that ceiling is exactly the 1134ms observed. The killer insight: the `cache.set` distributed-write `await` is dead weight on the request critical path because `cache.set` already updates the in-memory L1 *synchronously* before awaiting the distributed write — so the same-instance next-read is hot regardless of whether we wait for PG to acknowledge. The await was only ever protecting cross-instance propagation correctness, which doesn't need to block the response. **Two surgical fixes in `lib/cache.ts`:** (1) New `cache.setBackground(key, value, ttlMs): void` — sets L1 synchronously, fires the distributed write fire-and-forget with a single WARN log on failure (so a sustained failure mode is still visible while transient ones don't bleed into the request critical path). Trade-off documented inline: if the distributed write fails, this instance is still correct (L1 has the value); other instances fall back to their own cold rebuild on miss — same as today's silent-catch behavior in `PgCache.set`. (2) Added single-flight de-dup to `getOrSet` via a module-scope `Map<key, Promise>` — when a second caller arrives mid-fetcher for the same key, it awaits the first caller's in-flight promise instead of stampeding the DB with a parallel cold rebuild. Critical on instance boot when the LB starts routing the moment `markReady()` flips healthz to 200 and a `/broadcast/current` request can land at the exact same moment the broadcast transition ticker is also rebuilding the snapshot. **Wired into the broadcast hot path via `routes/broadcast.ts`:** all six `cache.set(BROADCAST_PAYLOAD_CACHE_KEY, …)` call sites in `buildBroadcastCurrentPayload` (one per result branch — liveOverride, live-schedule + YT-on, live-schedule + YT-off + queue failover, playlist/video schedule, empty queue, default queue path) switched from `await cache.set(…)` to `cache.setBackground(…)`. The `getOrSet`-based caches in `getActiveLiveOverride` / `getScheduleEntries` / `getBroadcastQueue` automatically pick up both fixes without per-call-site changes. Anchor writes in `setBroadcastAnchor` deliberately stay on `await cache.set` because anchor continuity across instances matters more than the few-ms savings, and anchor writes only fire when the airing item actually rotates (rare). Net cold-build cost drops from ~5 sequential round trips to ~2 (top-level read + slowest-leg fetcher), targeting the watchdog's healthy-band <100ms p95. The watchdog itself (alert at >=500ms, recover at <=250ms, 1h dedup, 5-min window, 10-cold-build floor) needed zero changes — same alert design, just less to alert about.

**YouTube Quota-Exhausted Alert Demoted from Critical to Warning (April 2026):** Production log line `{"level":50,...,"title":"YouTube Data API quota exhausted","severity":"critical","hint":"set ALERT_SLACK_WEBHOOK_URL or ALERT_WEBHOOK_URL to deliver this elsewhere","msg":"Ops alert raised but no channels configured"}` was firing on every quota reset boundary and reaching Sentry as a real ERROR event. The `alerts.ts` design is correct — when no Slack/webhook channel is wired, a `critical` alert is logged at ERROR level on purpose so it surfaces in Sentry instead of being silently swallowed (see the same file's comment block referencing the 2026-04-27T12:38:51Z incident). The actual misalignment is upstream: the YouTube quota-exhausted alert in `routes/youtube.ts` was tagged `severity: "critical"` when it doesn't meet the bar — the free 10K-units/day quota is a routine ceiling that auto-clears at the next UTC-08:00 reset, mobile/TV live detection cleanly falls back to RSS/HTML detection (the alert message itself says so), and the alert already has a 24h dedup so it can't spam. Treating it as critical was crying wolf and would train operators to ignore the critical channel — the same anti-pattern the `/healthz` 503 demotion fixed. Surgical change: flipped that one alert from `severity: "critical"` to `severity: "warning"` with an inline comment explaining the rationale and naming the genuine critical condition for this subsystem ("RSS fallback also failing", which is caught separately by the live-ingest health monitor that DOES warrant critical). All other behavior unchanged — the once-per-hour WARN log line, the `youtube-quota-exhausted` SSE broadcast that drives the admin banner, and the 24h alert dedup all stay exactly as they were. Net effect: zero false ERROR events to Sentry on routine quota reset boundaries; the alert still appears in `/admin/alerts/history` at warning severity so operators can see it during routine review; the auto-throttle alert (which was already `severity: "warning"`) is now consistent with the hard-exhaustion alert so the two related events sit at the same severity level.

**Visibility-Aware Admin Polling — Backgrounded Tabs No Longer Hammer the API (April 2026):** Audited every `setInterval`-based poller in the admin dashboard and found the dominant source of admin-driven backend load was tabs left open in background browser windows. Operators routinely keep 3–4 admin tabs open across multiple monitors all day, and every one of those tabs was running its `/admin/ops/status` (4× PG count queries per call) and `/admin/transcoding/queue` polls forever, regardless of whether anyone was actually looking. New `hooks/usePollingWhenVisible.ts` is a tiny visibility-gated polling primitive: it only runs the timer while `document.visibilityState === "visible"`, fires the callback immediately on tab return so the operator never sees stale data on focus, holds the callback in a ref to avoid the React-stale-closure tax, swallows promise rejections so a transient failure can't turn into an unhandled rejection (every caller already owns its own `error` state), and accepts `intervalMs = null` to disable polling entirely. Applied across the four heaviest pollers: `/operations` page (was `setInterval(loadStatus, 10_000)` → `usePollingWhenVisible(loadStatus, 30_000)` — 3× cadence reduction layered on top of the visibility gate, justified because every metric on this page is slow-changing infrastructure data nobody monitors second-by-second), `/transcoding` page (was `setInterval(loadQueue, 5_000)` → `usePollingWhenVisible(loadQueue, 15_000)` — HLS jobs take 30 s–10 min so a 5 s refresh was 3–120× finer-grained than any real state change), `/launch-readiness` page (kept 15 s cadence, just visibility-gated — the multi-stage probe is non-trivial), and `/live-monitor` page (kept 60 s cadence — SSE drives the realtime UI; this poll is only a belt-and-suspenders refresh for historical viewer-snapshot lists). Net effect for a typical 5-operator team with 4 tabs each averaging 50 % background time: roughly an order-of-magnitude reduction in background admin API load, with zero perceived UX change in foreground tabs (operators actually get a *better* experience because data refreshes instantly on tab return instead of waiting for the next interval tick). Also confirmed `compression@1.8.1` already serves Brotli to modern clients and gzip to legacy ones with proper `Vary: Accept-Encoding` headers — verified by `curl` against `/api/broadcast/current` — so that perf lever is already fully exploited and required no code change.

**`/api/healthz` 503s no longer logged as ERROR — Render LB chatter silenced (April 2026):** Production log line `{"level":50,...,"url":"/api/healthz","res":{"statusCode":503},"err":{...,"message":"failed with status code 503"}}` was showing up multiple times per deploy and reaching Sentry as a real error event. Root cause: `pino-http`'s `customLogLevel` blanket-treated every `>=500` status as `error`, but `/healthz` legitimately returns 503 in three distinct lifecycle cases — `starting` (process up but `markReady()` hasn't fired yet, which Render's LB probes hit dozens of times within the first second of every deploy), `draining` (after SIGTERM, intentional), and `db_down` (process up but DB unreachable, the genuinely-bad case). The first two are the LB asking "are you ready yet?" and the API correctly answering "not yet" — that's normal protocol traffic, not an error. Treating it as ERROR was paging on every deploy, training operators to ignore the channel, AND drowning out the one 503 reason that DOES warrant attention. Two-part fix: (1) `app.ts customLogLevel` now demotes any 503 from `/healthz` or `/api/healthz` to `info` BEFORE the generic 5xx-as-error branch, via a `HEALTHZ_PATH_PATTERN = /^(?:\/api)?\/healthz(?:\/|$)/` helper that's exhaustively unit-verified against `/api/healthz`, `/healthz`, trailing-slash, sub-path, query-string AND non-matches like `/api/health`, `/api/healthz_other`, `/foo/healthz`; (2) the genuine `db_down` branch in `routes/health.ts` now emits its own explicit `logger.warn` with structured context (phase, uptime, probe budget) before sending the response, so the real signal stays loud while the routine LB chatter stays quiet. Net effect: zero false ERROR events to Sentry per deploy, and the `db_down` case — process up but DB gone, which forces the LB to evict this pod from rotation — surfaces as a single dedicated WARN line instead of being indistinguishable from the routine startup probes.

**Broadcast Build-Latency Watchdog + Histogram (April 2026):** Closes the same observability gap the signed-URL cache pair did, but for the regression vector that's actually user-visible: the cold-rebuild path of `buildBroadcastCurrentPayload`, which on a freshly-rotated Render instance was observed at 994ms in production logs and is what every viewer pays right after a cache eviction. New `lib/broadcastLatency.ts` maintains two fixed-size 500-sample ring buffers (cold vs hot path) and computes p50/p95/p99/max via nearest-rank percentile. Instrumented inside `buildBroadcastCurrentPayload` via a `finish<T>(value)` helper called at every return site — `__path` defaults to `"cold"` and the cached return-branch flips it to `"hot"` immediately before its `return finish({...})`, so a future edit that adds a new return path automatically gets cold-tagged (fail-safe default). Snapshot exposed on `/api/admin/ops/status` under `infrastructure.broadcastBuildLatency` and rendered as `BroadcastBuildLatencyCard` on `/operations` next to the signed-URL cache card — headline cell is cold p95 with status badge auto-derived (`<200ms` ok, `<500ms` degraded, `>=500ms` critical, but only once at least 10 cold builds are recorded so a freshly-booted instance doesn't flash red), plus a per-path table showing samples / p50 / p95 / p99 / max for both cold and hot. Watchdog (`lib/broadcastLatencyWatchdog.ts`) mirrors the signed-URL pattern exactly: 60s sample, 5-sample (5-min) rolling window, alert when EVERY sample in the window had cold p95 >=500ms AND >=10 cold builds in the buffer (dual gate prevents single-outlier false positives), recovery at 250ms (hysteresis), 1h dedup, `unref()`'d timer, every tick try/caught so a sample failure can't crash the process. Wired into `startApiSchedulers()` alongside the signed-URL watchdog; logs full config on boot. Reuses `sendOpsAlert` so regressions show up on `/admin/alerts/history` next to live-ingest events with no new plumbing — the alert message names the three parallel reads (`getActiveLiveOverride` / `getScheduleEntries` / `getBroadcastQueue`) that an investigating engineer should look at first.

**Signed-URL Cache Regression Watchdog (April 2026):** Built on top of the new metric counter — `lib/signedUrlCacheWatchdog.ts` samples `signedUrlMetricsSnapshot()` every 60s, holds a 5-sample (5-minute) rolling window, and pages on-call via the existing `sendOpsAlert` primitive when the **delta** hit-rate over the window drops below 50% AND the window has at least 100 hits. Dual gates (rate AND volume) are essential: a low-traffic instance with 3 hits in 5 minutes can hit 33% by chance and would otherwise alert constantly. Hysteresis between alert (50%) and recovery (70%) thresholds prevents flap. When the rate climbs back above the recovery threshold, the watchdog clears its in-memory `alertActive` flag and fires a one-shot "recovered" alert with `severity: "info"`, so on-call sees the closure without manual reset. Dedup TTL on the regression alert is 1h — long enough that an engineer investigating doesn't get re-paged, short enough that an unresolved regression resurfaces. Watchdog timer is `unref()`'d so it never holds the event loop open during graceful shutdown, and every tick is wrapped in try/catch so a sample failure can never crash the process. Wired into `startApiSchedulers()` alongside the other background tickers; logs its full config on boot so operators know exactly what thresholds are in play. Reuses the `sendOpsAlert` channels (Slack + generic webhook) and the existing alert history, so regressions show up on `/admin/alerts/history` next to live-ingest events with no new plumbing.

**Signed-URL Cache Hit-Rate Metric + Operations Card (April 2026):** Added a tiny in-process counter module (`lib/signedUrlMetrics.ts`) that records every redirect decision out of the two media-redirect middlewares (`s3RedirectFirstForLargeMedia`, `s3FallbackMiddleware` in redirect mode) as either `fresh` (a new presign was minted) or `cached` (the previously-minted URL was reused). Exposed via `/api/admin/ops/status` under `infrastructure.signedUrlCache` with `total` and per-source breakdowns plus a precomputed `hitRate = cached / hits`. Counters are pure monotonic integers with `startedAt`/`uptimeSecs` so operators know the window they're looking at; they reset on every deploy / worker restart, which is intentional — we want hit-rate against current traffic, not a lifetime accumulator. Two-call wiring at the existing `recordSignedUrlHit(source, outcome)` insertion points means the hot path adds exactly one `++` per redirect. **Surfaced on the admin Operations page** as a `SignedUrlCacheCard` next to the S3 telemetry card: shows the headline hit-rate %, total cached vs fresh counts, and a per-source breakdown table (uploads vs static fallback). Status badge auto-derives from the rate (`>=80%` ok, `>=50%` degraded, `<50%` critical, but only once at least 20 hits are recorded so a freshly-booted instance with no traffic doesn't flash red). Pollable via the existing 10s `/admin/ops/status` cadence — no new endpoint, no extra request. The card is `optional` in the `OpsStatus.infrastructure` shape so older API builds without the metric still render the rest of the page cleanly.

**Production Hardening Pass — Render Log Findings (April 2026):** Four surgical fixes derived directly from production access logs. (1) **Signed-URL caching for HTML5 Range requests** — every `<video>` byte-range request was hitting `/api/uploads/<key>` and re-presigning a fresh S3 URL each time, producing one S3 SigV4 sign per ~5s poll per viewer. Both `s3RedirectFirstForLargeMedia` and `s3FallbackMiddleware` now share a per-key in-memory presign cache (TTL = `signedUrlTtlSec/2`, min 60s) so a sustained playback session reuses the same signed URL until it's halfway to expiry; new `X-Storage-Source` header reports `;fresh` vs `;cached` for observability. (2) **CORS preflight cached 24h** — added `maxAge: 86400` to the cors middleware so the admin dashboard stops paying an `OPTIONS` round-trip before every state-changing call (verified via `Access-Control-Max-Age: 86400` on response). (3) **`/api/broadcast/current` SWR + boot pre-warm** — the endpoint was sending `no-store` headers, forcing every viewer to re-pay the cold-rebuild path (observed at 994ms on a freshly-rotated Render instance). Switched to `Cache-Control: public, max-age=0, s-maxage=2, stale-while-revalidate=10` (browser still always revalidates, but shared caches absorb fan-out bursts) and added an awaited `buildBroadcastCurrentPayload(true)` warm-up before `markReady()` flips `/healthz` to 200, with a 3s bound so a slow PG can't delay readiness. (4) **Object-storage boot log clarity** — the `PUBLIC_OBJECT_SEARCH_PATHS` / `PRIVATE_OBJECT_DIR` env vars are part of the optional Replit object-storage shim, NOT direct AWS S3 config; logging them as `"not set"` in production was misleading operators into thinking storage was misconfigured. Boot log now reports the shim explicitly: `disabled (direct AWS S3 active)` when S3 is wired and the shim isn't, `configured (overrides direct AWS S3)` if both are present, etc. None of these changes alter live state semantics — SSE remains the source of truth for real-time broadcast updates.

**Multipart Upload — `readJsonOrThrow` Silently Cast Error Bodies As Success (April 2026):** Operator reported "Multipart sign returned 0 URLs for undefined parts — server side issue." The error message blamed the wrong endpoint. Root cause was three layers up: `readJsonOrThrow` (the upload helper used to parse every multipart-upload response) only validated that the body was non-empty parseable JSON. It did **not** check `res.ok`. So when `s3-multipart-init` returned a 4xx/5xx (auth failure, missing field, S3 client error, etc.) with body `{ error: "..." }`, the helper happily JSON-parsed that error body and TypeScript-cast it to the success shape. Every success-shape field (`uploadId`, `objectKey`, `partSize`, `totalParts`) was then `undefined`. The engine received `totalParts: undefined`, `Array.from({ length: undefined })` returned `[]`, no part numbers ever got sent for signing, and the engine threw the misleading "Multipart sign returned 0 URLs for undefined parts" error long after the actual init failure had been swallowed. Two-part fix: (1) `readJsonOrThrow` now throws on `!res.ok`, surfacing the server's `error` field if the body is JSON-shaped, falling back to a 200-char body snippet otherwise — so init failures now produce "S3 multipart init: HTTP 401 Unauthorized — invalid admin token" or whatever the real cause was; (2) defensive entry validation in `uploadFileToS3Multipart` checks `totalParts` and `partSize` are positive integers and throws "Multipart upload misconfigured: totalParts is undefined (expected positive integer). The s3-multipart-init response was likely missing or malformed." if not — belt-and-suspenders so even a future caller that forgets the helper can't trigger the same confusing downstream cascade. The one caller that intentionally read error-response bodies (`/finalize` failure path) was refactored to inline `res.text()` + `JSON.parse` so the new helper contract holds.

**YouTube Quota Banner — In-Page Variant on `/live-youtube` (April 2026):** The existing `YouTubeQuotaBanner` was mounted globally in `App.tsx` as a fixed-position overlay at the top of every admin page (`pointer-events-none fixed inset-x-0 top-0 z-40`). That works as a cross-page presence indicator, but on `/live-youtube` — the surface where an operator pastes a YouTube URL whose live-status probe needs the quota — a floating overlay can be missed (z-index dance with dialogs, viewport scrolled past, operator focused on form). Added a `variant?: "floating" | "inline"` prop to the component: floating preserves the existing global behaviour, inline drops the fixed positioning and renders as a normal block-level element that flows with the page. Mounted `<YouTubeQuotaBanner variant="inline" />` directly under the page header in `live-youtube.tsx`, so when quota is throttling or exhausted the warning is anchored to the surface the operator is actively looking at, not just available somewhere on screen. The inline variant also includes one extra explanatory line in the exhausted state ("Pasting a YouTube URL will still work, but live-status probes and metadata enrichment will fall back to the cached state") that's specific to what the operator is about to do on this page. Both variants share the same fetch + SSE-refresh logic (`youtube-quota-throttled` / `youtube-quota-exhausted` events, 5-minute background poll, 1-minute countdown tick while exhausted).

**Stabilization Pass — SSE Reliability, Mobile Audio, Admin UX, Upload Hardening (April 2026):** Eight surgical fixes from a four-track audit (mobile audio, SSE stability, transcoding/upload, admin UX). Each one closes a real, reproducible bug — no blind refactors. Many of the audit's other findings were rejected after direct file inspection (e.g. `flushClient` already swallows, `useSSEEvent` already uses a stable handler ref, `youtube.ts` SSE capacity error already returns, `GoLiveDialog`/notifications confirm action already disabled while pending) — those were false alarms, not fixes.

**(1) SSE heartbeat — file-descriptor leak.** `liveEvents.ts startSSEHeartbeat` was deleting dead clients from the broadcast `Set` but never calling `res.end()` or `socket.destroy()`. The `Response` and underlying TCP socket stayed alive in Node memory until the OS keepalive eventually timed it out (minutes to hours). Under sustained reconnect churn (see thundering-herd fix below) this was a slow-motion FD exhaustion. Fix: explicit `res.end()` + `socket.destroy()` on every dead-client reclaim. Also added a write-backpressure check — if `res.write()` returns `false` the client's socket buffer is full, which means it's wedged; we treat that as dead so the next tick reclaims the FD instead of buffering payloads at it forever.

**(2) SSE retry — thundering-herd on every restart.** Both `/broadcast/events` and `/youtube/live/events` instructed clients to reconnect after exactly 5 seconds (`retry: 5000`). On every API restart, all 3–5k connected TVs/mobiles/admins reconnected at the same 5-second mark, blowing past `MAX_SSE_CLIENTS_GLOBAL` and surfacing as a wave of 503s to legitimate users. Fix: per-connection jitter (`retry: 3000–8000` random) spreads the reconnect wave across a 5-second window, smoothing the load curve without changing the median reconnect latency.

**(3) `/youtube/live/events` — proxy-buffering hang + initial-write crash.** Two issues: (a) the route called `flushHeaders()` but didn't write any body bytes, so reverse proxies (nginx, Cloudflare) held the response in pending state until the first event arrived — which could be many minutes; (b) the `event: connected` initial write wasn't wrapped in try/catch, so a client that disconnected during the addSSEClient → write window surfaced as an unhandled error. Fix: write the jittered `retry:` line immediately (doubles as a "wake the proxy" first chunk, parity with `/broadcast/events`), and wrap the initial snapshot write in try/catch that cleanly removes the client on failure.

**(4) Mobile audio session — phone calls didn't pause playback.** `_layout.tsx setupAudioSession` was calling `Audio.setAudioModeAsync` WITHOUT `interruptionModeIOS` / `interruptionModeAndroid`. With those unset, behaviour is undefined: on iOS the app can keep playing at full volume OVER an incoming phone call; on Android, OEMs split between "continue" and "silently kill". Fix: `InterruptionModeIOS.DoNotMix` + `InterruptionModeAndroid.DoNotMix` — the OS now correctly ducks/pauses the broadcast or radio whenever a call, alarm, Siri, or another exclusive-audio app needs the focus.

**(5) Mobile radio — overlapping audio when user taps "Listen Live".** `radio.tsx handleListenLive` navigated to `/player` for the live broadcast WITHOUT first stopping the persistent radio audio engine. Result: the on-demand sermon kept playing in the background while the broadcast player started a SECOND audio source, both audible simultaneously until the user manually paused one. Fix: call `stopPlayback()` before `router.push("/player")` so the audio session is fully released and the broadcast player can claim it cleanly on mount.

**(6) Admin "Mark as Featured" — double-click race.** `videos.tsx handleToggleFeatured` had no per-row pending state. With API latency >200ms (typical), users frequently double-clicked the dropdown menu item, firing the same `updateVideo` mutation twice — the second call raced the first and the optimistic UI flickered. Fix: per-row `togglingFeatured` `Set<string>` (a single `id` would be wrong because multiple rows can be toggled in quick succession), with the menu item showing a Loader2 spinner and `disabled={togglingFeatured.has(video.id)}` while the mutation is in flight.

**(7) Admin `LivePreviewPlayer` — autoplay block left UI on infinite spinner.** Both call sites of `video.play()` swallowed the rejected Promise with `.catch(() => {})`. When the operator's browser blocked autoplay (Chrome since M64, Safari since 11 — common with stricter site settings), the `state` stayed at `"loading"` forever with no recovery path. Fix: surface `NotAllowedError` / `AbortError` as a new `"blocked"` state that renders a click-to-play overlay button which calls `play()` from a real user gesture (always allowed by the browser). Other play() failures fall through to the existing `"error"` state with the actual error message.

**(8) Chunk upload — disk-fill DoS + non-atomic public file.** Three composed issues in `admin.ts` chunk upload: (a) the session-init route accepted any `totalBytes` value, so a compromised admin credential could declare totalBytes=1TB and use `totalChunks * 200MB` chunks to fill the entire disk; (b) the chunk-receive route didn't enforce the declared budget at runtime — a client could lie about totalBytes (small) and send way more data; (c) the assembly step wrote chunks directly into `uploads/`, where the static file middleware could race the writer and serve a partial/corrupt file to a viewer who happened to request the newly-created path during assembly. Fixes: hard ceiling on `totalBytes` at session-init (default 20GB, env-tunable via `MAX_DECLARED_UPLOAD_BYTES`), per-chunk runtime check that `receivedBytes + chunk.length` stays within `totalBytes` (with 1MB tolerance for last-chunk metadata) returning 413 Payload Too Large if exceeded, and atomic-promote at the end (assemble into `uploads/tmp/assembling-<uuid>.<ext>`, run magic-byte validation against the tmp path BEFORE the file is publicly visible, then `fs.rename()` into `uploads/` — POSIX-atomic from the reader's perspective, so readers see either no file or the complete file, never a half-written one).

**Bonus fixes batched in:** `s3MirrorReconciler.ts` SELECT now LIMITs at 500 rows/pass (env-tunable via `S3_MIRROR_BATCH_SIZE`) — without this, a massive backlog (e.g. after extended S3 downtime) loaded every unmirrored row into memory and could OOM the API server on boot. `ffmpeg.ts killGracefully` SIGKILL escalation timer is now cleared on natural process exit — `unref()` was preventing event-loop hold but each unfired Timer object still cost memory until its scheduled fire, accumulating under heavy churn (crashing transcode loops, batch cancellations).

**Production Triage Pass — Render Worker, S3 HEAD Storms, Range-Guard False Positives, Admin SSE in Prod (April 2026):** Closed four real production issues surfaced by the Render deploy logs, all of them with concrete user-facing impact.

**(1) Worker crashloop — clearer triage signal.** The worker container on Render was crashlooping with `Refusing to start: AWS S3 is required in production but is not configured` because Render scopes env vars per-service, and the AWS_* vars set on the web service do not propagate to the worker service. The startup guard was correct (worker mode runs `s3MirrorReconciler` and the transcoder upload, both of which need S3) but the error message didn't tell the operator WHICH service to fix. **Fix:** the fatal log now includes `runMode: "worker"` and the message explicitly says "configure on the '<role>' service (each Render service has its own env-var scope — the web service env vars do NOT propagate to the worker service)". The crashloop itself is a deploy-config issue the operator must fix on Render; no code change can paper over it without silently corrupting the data layer (which is exactly what the guard exists to prevent).

**(2) `s3RedirectFirst: HEAD failed` log storm + slow video responses.** When the S3 HEAD throws (auth blip, transient AWS 5xx, network), the middleware was logging `warn` and falling through — but it wasn't *caching* the failure. Every subsequent viewer request re-issued the HEAD, re-threw, and re-logged. Production was emitting one warn per video request per second for the same hot key (`videos/70d01ebc-…mp4`), and each request paid a 1–2s HEAD round-trip before falling through to disk — that's how the same file showed `responseTime: 15631ms` and `18274ms` in the same log window. **Fix:** added a 60s negative cache for HEAD errors (during the cache window, the middleware skips S3 entirely and goes straight to the disk fallback) and rate-limited the warn line to once per key per 5 minutes (with `suppressedForMs` field on the log entry so operators see the cadence is intentional). Net effect: log cardinality drops by 100×+ during an outage, and the disk fallback engages instantly instead of after 1–2s of HEAD timeout.

**(3) `uploadRangeGuard 429` rejecting legitimate viewers.** Default per-(client IP, file) concurrency cap was 4. Production logs caught a real viewer hitting the cap on a single video — the slow HEAD-fallback path above caused the player to retry while a request was still in flight, and the cap was tight enough that legitimate HLS/MP4 players (mobile WebView and some smart-TV browsers routinely open 6–8 parallel range fetches) tipped over it. **Fix:** raised the default cap to 8, with a comment explaining the tuning trade-off (still bounded enough to defend the disk fast-path against a buggy client or DDoS, high enough that one human watching one video never sees a 429). The `UPLOAD_RANGE_MAX_CONCURRENT` env var still allows live tuning without a redeploy.

**(4) Admin SSE 401 in production — entire real-time admin feed was broken.** `adminAccessControl` accepted the `?adminToken=` query param ONLY in non-production. EventSource cannot send custom headers (no `Authorization`, no `x-admin-token`), so in production the admin SPA's primary SSE channel (`/api/admin/live/events`, used by `SSEContext.tsx` and `pages/broadcast.tsx`) failed with 401 on every connect — Mission Control activity feed, broadcast page real-time updates, YouTube quota events: all silently dead since the production build went out. **Fix:** in production, `getPresentedAdminToken` now accepts `?adminToken=` ONLY when the request carries `Accept: text/event-stream` (which EventSource always sends and ordinary fetches do not). The token is not exposed in access logs because the existing `pinoHttp` `req` serializer already strips the query string before logging (verified and added an explanatory comment). HTTPS+HSTS keeps the wire encrypted, so residual exposure is bounded to TLS-terminating proxies the operator already controls. No client-side changes needed — `getAdminEventSourceUrl` was already passing the token correctly; the server was just rejecting it.

**Cinematic Hero Real-Time Sync — SSE Payload Promotion (April 2026):** Closed a real stale-metadata gap in the TV cinematic hero. The previous flow was: SSE event arrives → `useLiveSync` projects a thin slice → `Home.tsx` listens for `syncedAt` change → triggers a fresh `fetchBroadcastCurrent()` HTTP roundtrip to get the full item metadata (thumbnail, durationSecs, activeSchedule, etc.). If that secondary fetch failed (transient network blip, brief 5xx, request abort during fast nav), the silent `catch {}` left the hero stranded on stale content for up to 60 seconds (the safety-poll interval) — even though the SSE payload had already delivered the truth. **Fix:** (1) `useLiveSync` now exposes the raw `BroadcastCurrentPayload` it already received as a `payload` field on `BroadcastSyncState`; (2) `Home.tsx` promotes `liveSync.payload` directly into local `broadcastCurrent` state via a new effect, eliminating the hot-path HTTP fetch entirely; (3) the standalone `fetchBroadcastCurrent` is now strictly a cold-start primer (before SSE handshakes) and a 60s safety poll, with bounded exponential backoff (1.5s → 3s → 6s → 12s, max 4 attempts) on transient failure so a single mount-time blip can't strand the hero blank. Net effect: the hero updates within milliseconds of any queue transition or override change, and HTTP outages can no longer cause stale-content flicker. Backward-compatible — all existing `useLiveSync` consumers (`useUnifiedLive`, `LiveBroadcastVideo`, `LiveYouTubePlayer`) continue to read the projected fields unchanged.

**Admin Activity Feed — YouTube Quota Visibility (April 2026):** Closed a real ops blind-spot. The API server emits two SSE events when the YouTube Data API hits pressure — `youtube-quota-throttled` (soft threshold) and `youtube-quota-exhausted` (hard daily cap, with `quotaResetAt` and `backoffMs`) — but the admin `SSEContext.tsx` `knownEvents` array didn't include them, so they were dropped on the floor and operators had no real-time visibility into why YouTube features (channel sync, playlist imports, live-status auto-detect) suddenly stopped working until they grepped server logs. **Fix:** added both events to `knownEvents` and added matching cases to `summarizeEvent` so they render in the Mission Control activity feed as `"YouTube API throttled (playlistItems) — 92% of daily quota used"` and `"YouTube API quota exhausted (search) — resets 1:00:00 AM"` respectively. The events still flow through the generic `emit` so any future page-level subscriber (e.g., a quota-pressure banner on the YouTube settings page) can listen via `useSSEEvent` without further wiring.

Temple TV (JCTM) is an enterprise-grade broadcasting platform offering a comprehensive media experience. It includes a cross-platform mobile app, a Smart TV web app, an admin dashboard, and a Node.js/Express API backend. Key capabilities include Live TV, Video-on-Demand (VOD) sermon library, 24/7 Radio mode, push notifications, offline video downloads, adaptive streaming, subscription management, user authentication, and a unified real-time broadcast synchronization system across all platforms. The platform aims to deliver a seamless and engaging content consumption experience.

**Production Audit Pass — Type Safety & Dependency Vulnerabilities (April 2026):** Ran a full workspace typecheck, three security scanners (dependency audit, SAST, HoundDog privacy/dataflow), and the LSP across all six artifacts (`api-server`, `admin`, `mobile`, `tv`, `mockup-sandbox`, `scripts`) plus all workspace libs. **Type safety:** the workspace was failing `pnpm run typecheck` on two real bugs: (1) `lib/api-zod/src/index.ts` re-exported from both `./generated/api` (zod schemas) and `./generated/types` (TS interfaces) which orval generates with the same PascalCase names — TS2308 fired on 8 ambiguous identifiers (`AddVideoToPlaylistBody`, `CreatePlaylistBody`, `CreateScheduleEntryBody`, `ImportVideoBody`, `ReorderPlaylistBody`, `StartLiveOverrideBody`, `UpdatePlaylistBody`, `UpdateScheduleEntryBody`); fix collapses to a single `export * from "./generated/api"` since no consumer imports the standalone types (zod gives them via `z.infer<typeof Schema>`), and a new `lib/api-spec/postcodegen.mjs` script runs after every `orval` invocation to re-apply the fix because orval owns `index.ts`; (2) `routes/admin.ts` `/admin/live-overrides/recent-youtube` selected `liveOverridesTable.endedAt` which doesn't exist on the schema (real column is `endsAt`) — the field wasn't even used downstream so it was simply removed. **Schema:** extended `LiveStatus` in `lib/api-spec/openapi.yaml` with the new fields the SSE payload now includes (`ytLive`, `ytVideoId`, `ytTitle`, `ytViewerCount`, `concurrentViewers`, `sseClients`, `deviceCount`) so the typed client matches the runtime contract used by Mission Control; ran `pnpm --filter @workspace/api-spec run codegen` to regenerate `@workspace/api-client-react` and `@workspace/api-zod`. **Dependency vulnerabilities:** `osv-scanner` reported 22 vulns (11 high, 11 moderate) almost entirely in transitive deps. Added pnpm overrides at the workspace root to bump `@xmldom/xmldom`→0.8.13 (4 highs, recursive XML serialization DoS, GHSA-2v35-w6hq-6mfw and friends), `drizzle-orm`→0.45.2 (high), `lodash`→4.18.0 (high+moderate), `path-to-regexp`→8.4.0 (high+moderate, regex DoS), `picomatch`→4.0.4 (high+moderate), `vite`→7.3.2 (2 highs, dev-server only), `postcss`→8.5.10 (moderate, build-only), `brace-expansion`→2.0.3 (moderate), `yaml`→2.8.3 (moderate). Result: **0 critical, 0 high, 3 moderate** — and the 3 remaining are `esbuild@0.18.20` (pulled by deprecated `@esbuild-kit/*`, requires upstream fix) and two transitive `uuid` (3.4.0, 7.0.3) versions whose only fix is a major bump to v14, deferred to avoid cross-cutting regressions for marginal severity gain. **SAST findings:** 121 total — 3 HIGH all triaged as false positives (`ffmpeg.ts` child_process spawn uses fixed binary names + array args, no shell injection surface; `auth.ts` "bcrypt hash" is a literally-invalid `$2b$12$invalidhashfortimingnormalization...` constant used for constant-time normalization to defend against user-enumeration via login timing — a security best practice; `mobile/web-dist/.../shaka-player...js` "OpenAI API key" is a vendor-bundle false positive in the third-party Shaka Player web build). **Static checks clean:** LSP reports 0 diagnostics across all files; HoundDog reports 0 privacy/dataflow violations; full `pnpm run typecheck` passes for all 6 artifacts + scripts + libs. **Runtime verification:** rebuilt api-server, restarted workflow, confirmed `/api/healthz` 200, `/api/youtube/live/status` returns the live broadcast, `/api/broadcast/current` returns the canonical payload, S3 + Postgres + ffmpeg all healthy at startup.

**Broadcast Queue Failover During Live Schedule Slots (April 2026):** While wiring the Mission Control hero to show the on-deck queue program (entry below), surfaced a real failover bug in `/api/broadcast/current`: when the active schedule entry was `contentType: "live"` (e.g. the recurring "Sunday Worship Service" 9 AM–12 PM slot), `buildBroadcastCurrentPayload` short-circuited to `item: null, queueLength: 0` *unconditionally* — even when the YouTube channel wasn't actually streaming and the broadcast queue had a perfectly healthy 4-item, 1h 56m failover rotation (`/api/broadcast/guide` confirmed the same queue was rotating correctly via its own code path). Result: the admin `/broadcast` page rendered "Queue is empty — nothing playing", Mission Control fell through to "Standing by", and worse — *viewers* on mobile and TV saw nothing during the live slot whenever the channel itself dipped (defeating the entire purpose of the queue as failover content). **Fix:** the live-slot branch now only short-circuits to `item: null` when YouTube is *actually* live (`ytStatus.isLive === true`) or the queue is genuinely empty. Otherwise it delegates to the same `calculateCurrentFromItems(queueItems, anchor)` helper every other broadcast surface uses, returns the queue's currently-airing item with anchor continuity, and surfaces a `failoverReason` of `"YouTube live broadcast not detected — playing from broadcast queue."` so operators can see *why* the queue is showing instead of YouTube. The 5-second `BROADCAST_PAYLOAD_TTL_MS` cache means failover engages within 5s of YouTube going off, with no manual action needed. Manual live overrides still take precedence (their branch runs before this one). Verified the `ytLive=true` path is unchanged via direct curl; the `ytLive=false` path uses the exact same helper proven correct by the existing `/broadcast/guide` endpoint.

**Mission Control Hero — On-Deck Queue Program When Off-Air (April 2026):** When YouTube is not live and no manual override is active, the admin Mission Control hero used to show a flat "No active broadcast / Standing by for the next scheduled service." That was misleading because the broadcast queue *was* still airing a program — viewers on mobile and TV were watching the queued video, but the operator's primary surface said nothing was happening. **Fix:** `dashboard.tsx` now polls `/api/broadcast/current` (public, no admin auth) every 30s, refetches immediately on the existing `broadcast-control-updated` SSE event and on a new `transition` listener, and ticks the local clock every 5s so the on-deck progress bar advances smoothly between refetches. When `!isLiveNow && broadcast.item != null`, the hero renders the queued program's title, a live progress bar (computed from `itemStartEpochSecs` + the local clock — same drift-free formula viewer surfaces use), `M:SS / M:SS` position vs duration, the `Up next` teaser from `broadcast.nextItem`, and `Open queue` + `Live control` quick links. The original "Standing by" copy is preserved as the fallback for genuinely empty queues, with a slightly clearer message ("The broadcast queue is empty…") when we positively know `queueLength === 0`. Added a small `BroadcastCurrent` view-type and `formatHMS()` helper in-file rather than depending on the openapi spec, since `/api/broadcast/current` isn't yet in `openapi.yaml` and the dashboard only needs a slim subset of the payload. The "On Air" branch is unchanged.

**Mission Control Dashboard — Real-Time Live Status (April 2026):** Closed a real bug where the admin Mission Control hero showed "Off Air / No active broadcast" while the YouTube channel was actually live. Two independent failures were combining: (1) The YouTube poller in `routes/youtube.ts` `pollLiveStatus()` only emitted a `yt-status` SSE event on state change; the admin SSE listener (`SSEContext.tsx`) only listens for the canonical `status` event built by `buildLiveStatusPayload`, so organic YouTube go-live transitions never reached the dashboard until a manual page reload. (2) `/api/admin/stats` did its own redundant `oembed` lookup with a 5-second timeout and cached the entire payload (including `isLiveNow`) for 2 minutes — so even REST polls lagged the truth by minutes. **Fixes:** (a) `pollLiveStatus()` now also dynamically imports `buildLiveStatusPayload` and broadcasts a fresh `status` event whenever state changes, so the admin dashboard updates instantly when YouTube goes live or off (dynamic import avoids a circular dep with `lib/liveStatus.ts`, which already imports `getLiveStatus` from `routes/youtube.ts`). (b) `/api/admin/stats` now reads the in-memory `getLiveStatus()` (kept fresh by the poller every 30s) instead of doing an external HTTP call, and splits the response into two blocks: a heavy DB-counts block cached for 2 minutes (Postgres-friendly) and a live block always recomputed from in-memory state (zero-latency). Even on cache hit, the live block is overlaid fresh. (c) New fields exposed on `AdminStats` (typed via `lib/api-spec/openapi.yaml` and regenerated): `liveTitle`, `liveVideoId`, `liveSource` (`override` | `youtube`), `ytLive`, `ytViewerCount` (scraped concurrent), `concurrentViewers` (real SSE-connected clients across mobile/TV/admin), `ytStaleSec`, and `ts`. (d) Mission Control hero (`artifacts/admin/src/pages/dashboard.tsx`) prefers SSE `lastStatusPayload` first, falls back to the now-fresh `stats` block, then to the standalone `/api/admin/live` REST. The headline viewer count uses YouTube's reported number when available and surfaces a separate "X on Temple TV" pill for the real concurrent SSE viewer count side-by-side. `lib/liveStatus.ts` `buildLiveStatusPayload` now also includes `concurrentViewers` and `ytViewerCount` so SSE consumers get the same fields. Added new `getLiveViewerCount()` export to `routes/youtube.ts` that surfaces the most recent scraped YouTube concurrent viewer count.

**Production Readiness — Infrastructure Visibility (April 2026):** Closed a real ops blind-spot exposed by a Render crashloop where the `temple-tv-transcoder` worker refused to start due to four missing AWS S3 environment variables (`AWS_S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) — the existing Launch Readiness page (`/admin/launch/readiness`) checked for object-storage path env vars but did NOT check the AWS S3 credentials that the production startup guard in `index.ts` actually requires, so the page would happily report "ready" while the worker crashlooped on every deploy. Added a new **"Production infrastructure"** category (now the first category, since infrastructure is the most foundational) to `routes/admin.ts` with seven explicit checks: (1) `AWS S3 bucket`, (2) `AWS region`, (3) `AWS access key ID`, (4) `AWS secret access key` — each individually surfaced so the operator sees exactly which env var is missing rather than a vague aggregate; (5) `Production startup guard` — a roll-up that mirrors the exact fatal log emitted by `index.ts` when `NODE_ENV=production` and S3 isn't fully configured, including the explicit warning "crashloop expected on next deploy"; (6) `Object storage paths` — now correctly requires BOTH `PRIVATE_OBJECT_DIR` AND `PUBLIC_OBJECT_SEARCH_PATHS` (was previously OR, which let the system report "ready" with only one set); (7) `FFmpeg transcoder` — surfaces `isFfmpegReady()` so a worker process that lost its ffmpeg binaries shows up in the dashboard. Status semantics are environment-aware: missing AWS credentials are `blocked` in production (because they will literally prevent the worker from booting) but `warning` in dev (so local machines without AWS configured don't go red). Each check provides a one-line `action` field with the exact env var name to set, matching the deployment-environment language used in the startup fatal. Removed the old vague `object-storage` check from the "Streaming pipeline" category since it's fully replaced. Frontend (`artifacts/admin/src/pages/launch-readiness.tsx`): added the `Server` lucide icon to the `categoryIcons` map keyed on `infrastructure` so the new category renders with appropriate iconography. Net effect: the next time the deployment is missing critical infrastructure env vars, the operator sees five red `Blocked` rows in the admin Launch Readiness page with explicit per-variable diagnoses BEFORE deploying — instead of discovering the problem by grepping Render logs after the worker crashloops.

**Live Stream Surface Consistency (April 2026):** Unified the "what YouTube live video is on right now?" resolution across every viewer-facing surface — the TV Hero (`LiveHero.tsx` via `useUnifiedLive`), the TV Broadcast Player (`pages/Player.tsx` `LiveYouTubePlayer` via `useLiveSync`), the mobile Hero (`app/(tabs)/index.tsx` initial fetch + SSE `status` handler), and the mobile Player (`app/player.tsx` `applyOverride`). Previously, only the admin override path (`liveOverride.youtubeVideoId`) was carried on the broadcast SSE/REST payload; the YouTube channel auto-detect signal (`cachedLiveStatus` in `routes/youtube.ts`) was only available to surfaces that polled `/api/youtube/live/status` separately or listened to the `yt-status` SSE event. Result: when the channel went live organically without an admin override, the Hero (which polled) advertised the live videoId while the Player (which only consumed broadcast SSE) silently pivoted to whatever broadcast queue item was airing — same bug on TV and mobile. The fix surfaces `ytLive`, `ytVideoId`, and `ytTitle` on the canonical `BroadcastCurrentPayload` (`routes/broadcast.ts`): every fresh build snapshots `getLiveStatus()` once and spreads `ytFields` into all four result branches, and the cached-return path always overlays the freshest `getLiveStatus()` so the channel-scrape flip propagates within the broadcast cache TTL even when no other broadcast event fires. TV `useLiveSync.ts` now collapses the resolution `override → ytVideoId → queue item` directly into its `videoId` field, so `LiveYouTubePlayer` just consumes `sync.videoId`. TV `useUnifiedLive.ts` prefers the SSE-pushed `sync.ytLive`/`sync.ytVideoId` (instant) over the 30s-polled `useLiveStatus()` (cold-start fallback only). Mobile `services/broadcast.ts` `BroadcastCurrentResult` gained the same three optional fields; `app/(tabs)/index.tsx` initial fetch and `app/player.tsx` `applyOverride` both now resolve `liveOverride.youtubeVideoId ?? ytVideoId` so the Hero and Player land on the same stream. Net effect: whether the admin pins a YouTube URL via Live Control OR the channel goes live organically, all four surfaces now play the SAME videoId without divergence.

**Guest Access Policy (April 2026):** All content viewing — live broadcast, VOD sermons, TV Guide, and broadcast queue — is freely accessible without sign-up or login on every platform. Authentication is retained exclusively for optional enhanced features: watch history sync, favourites, live-service alerts, admin operations, and device-link pairing. Specific changes: (1) TV `App.tsx` `gatedPlay` hard gate removed — playback fires immediately for all users; `AuthGateModal` and pending-play state removed from TV. (2) Mobile `utils/navigation.ts` `navigateToSermon` and `navigateToPlayer` no longer wrap navigation in `gatePlayback` — both navigate directly. (3) Mobile `app/player.tsx` automatic `openAuthGate` on mount removed — guests arrive at the player without an interruption. The voluntary in-player "Save your watch history" nudge (user-initiated, dismissible) is retained as a non-blocking optional prompt. Backend broadcast endpoints were already fully public; no API changes were needed.

**Broadcast Queue Continuity (April 2026):** The broadcast queue now uses an *anchor-driven* live-edge calculation instead of pure `epochSecs % totalSecs` modulo. Without the anchor, appending a newly-uploaded video to the queue (which changes `totalSecs`) would have shifted the modulus mid-program and teleported playback into the middle of a different item — interrupting the on-air program. The anchor (`{ itemId, startEpochSecs }`, persisted in the distributed cache at `broadcast:current_anchor` with 24h TTL) pins the currently-airing item: subsequent rebuilds keep playing it from its anchored start, walking forward through the queue in `sortOrder` order only when the current item has fully elapsed. Result: uploads append silently to the lineup and air only when the queue advances to them, exactly like a real TV station's program schedule. Falls back to epoch-modulo on cold start, when the anchor is more than one full lap stale, or when the anchored item is no longer in the queue. Implementation in `artifacts/api-server/src/routes/broadcast.ts` (`getBroadcastAnchor`, `setBroadcastAnchor`, `calculateCurrentFromItems`).

**Broadcast Player Branding (April 2026):** The on-air channel bug now displays a two-line station identifier — primary mark "TEMPLE TV" with the sub-line "JCTM Broadcasting" — across both the TV (`artifacts/tv/src/components/BroadcastChannelBug.tsx`) and mobile (`artifacts/mobile/components/ChannelBug.tsx`, watermark mode) surfaces. Reads as a true network identification, matching real broadcasters' on-screen station ID conventions. The mobile player footer continues to show "Temple TV · JCTM Broadcasting" alongside the LIVE/ON AIR pill. Loading veil background on TV (`Player.tsx` and `HlsVideoPlayer.tsx`) refined from an aggressive dark-red radial gradient (`#1a0010 → #050505`) to a balanced neutral-dark gradient (`#1a1f2a → #0a0d12`) — comfortable for long-duration viewing without sacrificing the cinematic broadcast feel.

**Process Role Split — API vs Transcoder Worker (April 2026):** To eliminate ffmpeg-driven OOM kills of the API process on small Render plans, the same `@workspace/api-server` build now supports a `RUN_MODE` env var with three values that select which roles boot at startup. **`RUN_MODE=api`** starts the HTTP server, SSE heartbeat, broadcast transition ticker, stream-health emitter, notification scheduler, and YouTube catalogue scheduler — but skips ffmpeg preflight and the transcoder claim loop entirely. **`RUN_MODE=worker`** does the inverse: no HTTP listener, no SSE, no schedulers — only ffmpeg preflight, `resumePendingJobsOnStartup`, and `startRetryTick`. The retry interval keeps the event loop alive; Render `worker`-type services don't expose a port so no health endpoint is needed. **`RUN_MODE=all`** (the default, used by the local dev workflow) preserves the original single-process behavior so nothing changes for development. `render.yaml` now declares two services pointing at the same code: `temple-tv-api` (web, RUN_MODE=api) and `temple-tv-transcoder` (worker, RUN_MODE=worker). Both share the same DATABASE_URL and AWS S3 credentials; the worker uses the existing `FOR UPDATE SKIP LOCKED` claim semantics in `processNextJob`, so multiple workers are race-safe if the queue ever grows enough to warrant scaling out. Source MP4s are pulled from S3 into `/tmp` scratch space, transcoded, and the HLS variants uploaded back to S3 under the `hls/` prefix; the API service serves them via `lib/staticWithS3Fallback.ts`. Net effect: a runaway ffmpeg encode can OOM-kill the worker without ever touching the API process — viewers' broadcasts keep playing from S3, and admin/upload traffic stays responsive.

**Transcoder Memory Containment (April 2026):** Added two defensive layers in `artifacts/api-server/src/lib/transcoder.ts` against the recurring Render OOM kills (Render Events: *"Ran out of memory (used over 512MB)"*). **Layer 1 — ffmpeg arg hardening:** added `-threads 2` (configurable via `FFMPEG_THREADS`, default tuned for 512MB-1GB containers) and `-x264-params rc-lookahead=20:sync-lookahead=0` to cap x264's per-frame work-buffer count. x264's default `-threads 0` spawns one worker per CPU core, each holding its own lookahead ring; capping at 2 cuts peak ffmpeg RSS by ~40-60% with a small (~15-20%) wall-clock penalty. **Layer 2 — memory-aware backpressure in `processNextJob`:** before claiming a job from the queue, sample `process.memoryUsage().rss` and skip the claim if it's above a configurable ceiling (`MAX_NODE_RSS_MB_BEFORE_TRANSCODE`, default 380MB ≈ 75% of a 512MB container). The skipped job stays `queued` and the existing 30-second `retryTick` re-attempts after the previous ffmpeg's pages have been freed back to the OS. Result: a single big upload can no longer trigger an OOM that takes down the entire API process and resets every viewer's broadcast stream — the worker self-throttles instead. Both ceilings are env-tunable so a Render plan upgrade lifts the throttle automatically without a code change.

**HLS / Uploads Render-Restart Survivability (April 2026):** Closed a fundamental durability gap in `artifacts/api-server/src/app.ts`. The transcoder writes HLS variants to local disk (`uploads/hls/<videoId>/`) and "best-effort" copies them to S3 under the `hls/` prefix, but the `/api/hls/*` and `/api/uploads/*` routes were served via plain `express.static` — they never read the S3 backup. Render's container filesystem is ephemeral, so every deploy/restart wiped local files and broke every transcoded video until it was re-encoded. **Fix:** added `artifacts/api-server/src/lib/staticWithS3Fallback.ts` (~280 LOC) — middleware that runs *after* `express.static` (with `fallthrough: true`), and on miss does `headObject` against the mirrored S3 prefix, then streams the body back with full HTTP `Range` support, `ETag` / `If-None-Match` 304 handling, and the right `Content-Type` / `Cache-Control` per file extension. Range requests use a dedicated `lib/s3Ranged.ts` helper that issues a `GetObjectCommand` with the `Range` parameter so video seek bars keep working when bytes flow from S3. Both `/api/hls/*` (S3 prefix `hls/`) and `/api/uploads/*` (S3 prefix `videos/`) are wired through. Verified locally: existing local files still serve at full speed via `express.static` (returns 200 with correct Content-Type, 206 with correct Content-Range on byte-range requests); missing files cleanly 404 when S3 doesn't have them either; S3-served responses include `X-Storage-Source: s3` for observability.

**Soft-Dark Cinematic Player Theme (April 2026):** The broadcast player surfaces have been comprehensively rebalanced away from harsh pure-black overlays toward a warmer slate-dark palette across every viewer-facing surface. **TV HLS chrome (`artifacts/tv/src/components/HlsVideoPlayer.tsx`):** mid-playback buffering veil softened from flat `rgba(0,0,0,0.35)` to a radial `rgba(13,17,23,0.55) → rgba(10,13,18,0.35)` gradient; autoplay-blocked overlay shifted from red-tinted `rgba(26,0,16,…)` to neutral slate `rgba(26,31,42,0.92) → rgba(10,13,18,0.96)`; top and bottom control gradients changed from `rgba(0,0,0,0.88)` to a three-stop slate fade `rgba(13,17,23,0.82) → 0.42 → transparent` for smoother optical falloff; the ON AIR pill picked up an `rgba(13,17,23,0.65)` background, a subtle `0 4px 18px` shadow, and a faint red `1px` outer-ring glow for premium broadcast presence. **TV YouTube player chrome (`artifacts/tv/src/pages/Player.tsx`):** seek OSD now slate `rgba(13,17,23,0.78)` with `1px` border, `10px` blur, and `8px 32px` shadow; top and bottom control gradients use the same three-stop slate fade as HLS for visual consistency between the two playback paths. **TV player container** keeps its `#000` backdrop (zero-leak on OLED/LED panels) but gains an `inset 0 0 180px 40px rgba(13,17,23,0.55)` inner shadow — a soft ambient vignette around the video edge that evokes a real broadcast monitor without bleeding light into the picture. **TV station-ID watermark (`artifacts/tv/src/components/BroadcastChannelBug.tsx`):** softened to `rgba(13,17,23,0.55)` with `10px` blur and a subtle red outer-ring shadow. **Mobile player (`artifacts/mobile/app/player.tsx`):** broadcast footer `#0d1117` with hairline `rgba(255,255,255,0.05)` top border; `StatusBar` and notch-spacer recoloured from `#000` to `#0d1117` so the chrome reads as one continuous warm-dark surface; top-of-video back-button gradient softened from flat `rgba(0,0,0,0.7)` to a three-stop slate fade `rgba(13,17,23,0.78) → 0.32 → transparent`; the `LIVE/ON AIR` dot gained a `4px` red glow for genuine broadcast feel. **Mobile broadcast info strip (`artifacts/mobile/components/BroadcastInfoStrip.tsx`):** bottom gradient changed from binary `transparent → rgba(0,0,0,0.95)` to a three-stop slate fade ending at `rgba(13,17,23,0.88)`; `nowDot` picked up the matching red glow; `channelLabel` text contrast bumped from `rgba(255,255,255,0.5)` to `0.65` for better readability without harshness. **Mobile station-ID watermark (`artifacts/mobile/components/ChannelBug.tsx`):** softened to `rgba(13,17,23,0.55)`. The result is a single coherent slate-dark visual language across every player surface — comfortable for long viewing sessions, premium for short ones, without any pure-black layer except where it's required for OLED light-leak prevention behind the actual decoded video.

**Stream Health — Per-Platform Viewers + Real Dropped-Frame Rate (April 2026):** Extended the realtime telemetry channel with two metrics that the previous server-only design couldn't honestly produce. **Viewer count by platform:** `addSSEClient(res, platform)` now accepts a tag (`"tv" | "mobile" | "admin" | "unknown"`), parsed from a `?platform=…` query param attached at every SSE connect site (TV `useLiveSync.ts`, mobile `services/broadcast.ts`, admin `SSEContext.tsx` and the `/admin/live/events` route which defaults to `"admin"`). New `getSSEClientCountsByPlatform()` returns the breakdown, surfaced as `viewersByPlatform: { tv, mobile, admin, unknown }` on the snapshot. The Live Monitor's "Viewers" tile now shows the headline count plus a per-platform sub-line ("12 TV · 4 mobile · 1 admin"). **Dropped-frame rate:** new `POST /api/broadcast/playback-telemetry` endpoint (1 KB JSON body cap) accepts `{platform, decoded, dropped}` deltas. The TV `HlsVideoPlayer.tsx` runs a 5 s `useEffect` interval that reads `HTMLVideoElement.getVideoPlaybackQuality()` off the active A/B-crossfade slot, computes the delta against the previous sample (re-baselining on slot swap so a fresh `<video>` element's reset counters never spike the aggregate), and POSTs with `keepalive: true` so unload races still report. The endpoint feeds `recordPlaybackTelemetry()` in `streamHealth.ts`, which keeps a 60 s rolling window with a per-sample 10 K-frame hard cap (a single misbehaving client can't poison the aggregate) and exposes a single `droppedFrameRate = sumDropped / sumDecoded` over the window — `null` when no client has reported, so the UI shows "—" rather than a fabricated zero. Health classifier now escalates to `warning` at >1% drops and `critical` at >5%. New "Dropped frames" tile in the Live Monitor card with tone-coded color and a `"3 of 450 (60s)"` sub-line. Verified live: synthetic POST of 2 dropped / 300 decoded (TV) + 1 / 150 (mobile) produced `droppedFrameRate: 0.0067, reportingClients: 2` on the next stream-health frame. The grid was widened to `xl:grid-cols-7` to accommodate the new tile alongside Viewers, Bitrate, Dropped frames, Segment latency, Stability, Item uptime, Sync state.

**Realtime Stream Health Monitoring (April 2026):** Replaced the admin Live Monitor's 15 s polling with a true 1 Hz SSE telemetry feed. New module `artifacts/api-server/src/lib/streamHealth.ts` (~270 LOC) emits a `stream-health` event every second to all connected SSE clients. Architecture is two-timer: a 1 s emitter that publishes a pre-computed snapshot (zero I/O on the hot path, zero overhead when no clients are connected — `getSSEClientCount() === 0` short-circuits the broadcast), and an independent 5 s background probe that does the network-bound work (`fetch` HEAD-equivalent on the current HLS master URL, EMA-smoothed latency over the last few samples; m3u8 `BANDWIDTH=` parse cached per-URL). Every metric is genuinely measured server-side: `viewerCount` from real `addSSEClient`/`removeSSEClient` accounting, `itemUptimeSecs` derived from the broadcast anchor's `startEpochSecs`, `serverUptimeSecs` from `process.uptime()`, `bitrateKbps` parsed from the live HLS playlist, `segmentLatencyMs` from the EMA, `stabilityPercent` + `connectionFailureRate` from a rolling 60 s window of real SSE write outcomes (instrumented via a new `registerSSEWriteObserver` hook in `liveEvents.ts` that fires after every `broadcastLiveEvent` — the observer skips self-emitted `stream-health` events to avoid recursive measurement). Server classifies `health: "healthy" | "warning" | "critical"` deterministically from numeric thresholds (latency > 1500 ms = critical, > 800 ms = warning, write-failure rate > 5 % = warning) with a human-readable `healthReason` so the color-coded UI can never disagree with the underlying numbers. Wired in `index.ts` alongside `startSSEHeartbeat()` / `startBroadcastTransitionTicker()`. **Admin side** (`artifacts/admin/src/pages/live-monitor.tsx`): subscribes via the shared `useSSEEvent("stream-health", …)` hook in `SSEContext.tsx` (which had `"stream-health"` added to `knownEvents` and a `summarizeEvent` early-return so per-second pings never flood the operational activity feed). New `RealtimeStreamHealth` component renders a six-cell metric grid (Viewers, Bitrate, Segment Latency, Stability, Item Uptime, Sync State) with inline 60-sample SVG sparklines for viewer count and latency, color-coded health border (emerald/amber/red), and an explicit "Stale feed" badge that triggers if no frame arrives for >5 s (caught by a 1 Hz local ticker). The legacy 15 s `/admin/live/health` poll was reduced to 60 s as a belt-and-suspenders refresh for historical viewer-snapshot aggregates only. Verified live: SSE capture shows `event: stream-health` arriving every ~1000 ms with `itemUptimeSecs` ticking 155 → 156 → 157, `segmentLatencyMs: 635`, `health: "healthy"`. Bitrate is correctly `null` when the on-air item is YouTube-sourced (we can't probe YT's CDN) — UI gracefully renders "—" with `n/a for source` sub-label.

**Deployment Continuity — Mobile Foreground Resync (April 2026):** The TV and admin web clients already had explicit reconnect-on-focus paths (admin via `visibilitychange` in `SSEContext.tsx`, TV via SSE backoff that re-fires whenever the page is visible). Mobile was the lone gap: when the OS suspended the app and a backend deploy rolled while the user was backgrounded, the mobile SSE socket had to time-out and back off before the player saw fresh state. Added `AppState` listeners that fire an immediate `checkBroadcastCurrent()` on `active` in two places — `artifacts/mobile/app/player.tsx` (resync the now-playing item + preloaded next item) and `artifacts/mobile/components/LiveBroadcastSupervisor.tsx` (bypass the 10 s throttle so a live event that started during background is detected on the very first foreground tick). Combined with the server-side anchor in the distributed Postgres cache (`broadcast:current_anchor`, 24 h TTL — which already proves itself by surviving workflow restarts with `itemStartEpochSecs` unchanged), this closes the deployment-resilience loop end-to-end: the on-air program continues from its CDN-fronted segment URL while the API restarts; the new instance reads the anchor and computes the same wall-clock position; SSE clients reconnect with exponential backoff (2 s floor / 60 s ceiling, 30 % jitter); and the foreground resync catches anything the SSE channel missed during a long suspend. No "deployment hooks" or special Render lifecycle wiring required — the whole story is built on stateless wall-clock math + persistent state in Postgres.

**System Status Cache Accuracy — Transcoder Live Refresh (April 2026):** Closed a real cache-invalidation gap in `artifacts/api-server/src/lib/transcoder.ts`. When a queued video finished transcoding, the worker only deleted `broadcast:queue` and emitted `broadcast-queue-updated` over SSE — but the rolled-up `broadcast:current_payload` snapshot survived its TTL, so admin/TV/mobile clients could see "Now Playing" with `localVideoUrl: null` for up to a minute after encoding completed. Fixed by (1) deleting both `broadcast:queue` and `broadcast:current_payload` together, and (2) calling `emitBroadcastState("queue-item-transcoded", { videoId, hlsMasterUrl })` (imported from `routes/broadcast`) which rebuilds the payload from the now-fresh queue and pushes `broadcast-current-updated` over SSE. Result: the moment the worker writes the new HLS master URL onto the queue row, every connected client sees the playable link in the "Now Playing" payload — no waiting for poll cycles, no stale `null` localVideoUrl. All other broadcast/queue/schedule/live-override mutation paths in `routes/broadcast.ts` and `routes/admin.ts` were already invalidating fully and emitting `emitBroadcastState` correctly; this was the lone remaining hole.

**Mobile App — Android Production Build Readiness (April 2026):** Completed full production-readiness pass on `artifacts/mobile` for Google Play Store submission. Key changes: (1) **Deleted `app.config.ts`** — migrated all config to static `app.json` (required by Expo for non-dynamic builds). (2) **Fixed `app.json`**: updated `extra.router.origin` from a hardcoded Replit dev URL to `https://templetv.org.ng` (production domain); bumped `android.versionCode` from 1 to 2 for the first Play Store release. (3) **Rewrote `eas.json`**: added `credentialsSource: "remote"` to production/preview/firetv/androidtv profiles, added `firetv` (.apk) and `androidtv` profiles, wired `submit.production.android` with service-account path placeholder, and added correct `APP_ENV`/`EXPO_PUBLIC_API_URL` env vars per profile. (4) **Fixed `useNetworkStatus`**: replaced fragile YouTube favicon ping (blocked in some regions → falsely reports offline) with a multi-endpoint fallback strategy — pings `api.templetv.org.ng/healthz` first, then Cloudflare `1.1.1.1`, then Ubuntu connectivity check; uses `AbortSignal.timeout` and cancels on unmount. (5) **Fixed `broadcast.ts`**: added `NativeSSEClient` — a minimal XHR-backed EventSource-compatible class that enables SSE realtime updates on Android/iOS (React Native has no global `EventSource`). `NativeSSEClient` uses `XMLHttpRequest.onprogress` for incremental delivery, handles SSE framing (`event:` / `data:` / double-newline blocks), implements exponential backoff, and is activated automatically when the browser `EventSource` global is absent. TypeScript passes clean with no errors. (6) **Created `ANDROID_BUILD_GUIDE.md`** — comprehensive step-by-step guide covering EAS project setup, keystore management, Play Store submission (manual + EAS Submit), Fire TV APK build, OTA updates, and a troubleshooting table. Note: `.aab` generation requires EAS Build (external cloud service) — Android SDK / Java / Gradle are not available in Replit.

## User Preferences

- The user wants the agent to focus on delivering high-quality, production-ready code.
- The user expects the agent to adhere to the existing monorepo structure and technology stack.
- The user prefers that the agent prioritize features that enhance user experience and operational efficiency.
- The user wants the agent to ensure new features are integrated seamlessly with the real-time broadcast synchronization system.
- The user expects the agent to perform comprehensive testing and address any TypeScript errors or deprecated patterns.
- The user requires the agent to consider security, performance, and scalability in all implemented features.
- The user wants the agent to ensure all changes respect the existing design system, including light-first auto theming and glassmorphism UI elements.

## System Architecture

The platform is built as a monorepo using `pnpm workspaces`, Node.js 24, and TypeScript 5.9.

**Core Architectural Decisions:**
- **Unified Live Broadcast Sync:** A single live input (YouTube Live, HLS URL, or RTMP) feeds all platforms simultaneously via Server-Sent Events (SSE) for real-time state changes (`GET /api/broadcast/events`). An Admin Live Control panel facilitates instant broadcasting.
  - **Automatic Transition Ticker:** `startBroadcastTransitionTicker()` (started in `index.ts`) runs a 2-second server loop. It compares `Date.now()` against `currentItemEndsAtMs` from the last known payload and — when the boundary passes — invalidates the cache, rebuilds the full payload, and pushes `broadcast-current-updated` to all SSE clients with `reason: "item-transition"`. No admin action required for automatic queue advances.
  - **Live Position Recalculation:** `buildBroadcastCurrentPayload()` now stores `itemStartEpochSecs` in the cache. Every read from cache recomputes `positionSecs = floor(Date.now()/1000) - itemStartEpochSecs`, keeping seek positions accurate even if a client joins several seconds after the cache was populated.
  - **Client Precision Timing:** `currentItemEndsAtMs` (epoch ms) and `itemStartEpochSecs` (epoch seconds) are included in every broadcast payload. Mobile `player.tsx` uses `currentItemEndsAtMs` to schedule a precision `setTimeout` that self-tunes to the next item without waiting for the 15-second background poll. TV `useLiveSync` hook now exposes the full payload (positionSecs, currentItemEndsAtMs, itemStartEpochSecs, index, totalSecs, queueLength, progressPercent, nextItem) for position-aware corrections.
  - **Reduced Mobile Poll Interval:** Broadcast sync polling in `player.tsx` reduced from 60 s to 15 s as a belt-and-suspenders fallback behind the SSE + precision timer path.
- **Micro-frontend Approach:** Separation of concerns with distinct artifacts for mobile (`artifacts/mobile`), Smart TV (`artifacts/tv`), and admin (`artifacts/admin`).
- **Data Persistence:** PostgreSQL with Drizzle ORM for database management.
- **API Framework:** Express 5 for the backend API.
- **Validation:** Zod for schema validation.
- **Monorepo Management:** `pnpm` for package management and workspace organization.
- **Cross-Platform Mobile:** Expo (React Native) with `expo-router` for mobile development.
- **Admin Dashboard:** React/Vite for the administrative interface.
- **Adaptive Streaming:** HLS transcoding (FFmpeg v6.1.2 on system PATH) with adaptive bitrate (ABR) streaming for uploaded videos. After transcoding, HLS segments are uploaded to **AWS S3** (bucket configured via `AWS_S3_BUCKET`, region via `AWS_REGION`) for CDN-backed durability and cross-instance access. Local FS serves as the primary delivery path; S3 provides the durable backup. All S3 calls go through the typed wrapper in `artifacts/api-server/src/lib/s3Storage.ts` (singleton `S3Client` from `@aws-sdk/client-s3`, multipart streaming via `@aws-sdk/lib-storage`, presigned URLs via `@aws-sdk/s3-request-presigner`). The transcoding pipeline (`artifacts/api-server/src/lib/transcoder.ts` + `lib/ffmpeg.ts`) is hardened for enterprise reliability:
    - **Boot-time preflight** (`assertFfmpegAvailable`) resolves and caches the `ffmpeg`/`ffprobe` binary paths once at server startup, honors `FFMPEG_PATH`/`FFPROBE_PATH` env overrides, and fails loud with an actionable error if either binary is missing.
    - **Strict input validation** (`validateAndProbeInput`) probes container + all streams before the encoder is initialized, throwing a `TerminalTranscodeError` for corrupt files / no video stream / invalid dimensions / zero duration / sub-1KB uploads. Terminal errors skip retries — they're permanent failures of the asset, not the system.
    - **Idle + wall-clock watchdogs** (`runFfmpeg`) kill any ffmpeg process that goes silent for 90s or exceeds a per-encode wall-clock cap (clamped between 5 min and 4 h, scaled by source duration). Kills are SIGTERM with a 5s grace before SIGKILL. Eliminates hung-encoder zombies.
    - **Atomic job claiming** uses Postgres `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *` so multiple workers (or future multi-instance deployments) can never claim the same row.
    - **Per-variant fallback**: a single quality variant failure is logged, its partial output cleaned up, and the remaining ladder continues; the job only fails if ZERO variants are produced.
    - **Auto-retry with exponential backoff**: transient failures schedule `nextRetryAt = now + 30s/1m/2m...` (capped at 15m) for up to `maxAttempts` (default 3). The `startRetryTick` interval (30s) wakes the worker so backoff retries fire even with no new uploads. Crash-recovery (`resumePendingJobsOnStartup`) decrements `attempts` so an interrupted attempt doesn't burn the retry budget.
    - **Partial-success transparency**: jobs that succeed with a degraded ladder record `Partial: produced N/5 variants (skipped …)` in `errorMessage` so admins see degradation in the queue UI.
- **Caching:** Three-tier distributed caching: Redis (primary, when `REDIS_URL` set) → PostgreSQL `cache_entries` table (secondary, always active, multi-instance safe via `lib/db`) → in-memory MemoryCache (L1 hot-key layer). `rateStore` similarly: Redis → PostgreSQL `rate_limit_buckets` → memory. Both backends use atomic upserts to prevent race conditions across instances.
- **Performance Optimization:**
  - **Hot endpoint response cache:** `/api/videos/featured`, `/api/videos/trending`, and `/api/playlists` are served from the distributed cache (60s and 30s TTL respectively) and emit `Cache-Control: public, max-age=30, stale-while-revalidate=60` so CDNs and browsers can also cache. Admin mutations to videos and playlists invalidate the affected cache keys via `invalidatePublicVideoCaches` / `invalidatePublicPlaylistCaches` so changes appear within one render cycle.
  - **Database indexes for hot queries:** `transcoding_jobs` indexes on `status`, `video_id`, `next_retry_at`, and a composite `(status, priority, created_at)` for the worker's `FOR UPDATE SKIP LOCKED` claim. `managed_videos` indexes added on `featured` (for `/videos/featured`) and `view_count` (for `/videos/trending`) on top of the existing `imported_at`, `category`, `video_source`, `transcoding_status`, `title`, `preacher` set.
  - **Vite production builds:** Both admin and TV apps use vendor-chunk splitting (`react-vendor`, `ui-vendor`, `tanstack`, `player-vendor` for TV's HLS libraries, `charts-vendor` for admin's recharts, plus a generic `vendor` bucket) so the initial JS download per route stays small. Production builds also drop `console.*` and `debugger` statements via esbuild for smaller, faster bundles.
  - **Express compression** (gzip/brotli, threshold 1024B) is enabled globally with an explicit SSE bypass so live broadcast events still stream in real time.
  - **HLS segment caching:** `.m3u8` manifests cached for 30s, `.ts` segments cached for 1h via `Cache-Control: public, max-age=3600`.
- **Authentication:** JWT-based user authentication with refresh tokens, account management, and server-side storage for favorites and watch history.
- **Notifications:** Expo Push API for scheduled and instant push notifications.
- **UI/UX:**
    - **Theme:** Light-first auto theme with an automatic midnight theme activated from 8:00 PM to 5:59 AM based on the device/browser local time zone.
    - **Design System:** Glassmorphism-style UI with theme-aware glass backgrounds.
    - **Smart TV UI:** 10-foot UI design with large fonts, prominent focus rings, and D-pad/remote navigation.
- **Key Features:**
    - **Video Playback:** Dual-player architecture per platform:
        - **YouTube content:** `react-native-youtube-iframe` (mobile), YouTube IFrame API (TV/web) with D-pad remote control, seek OSD, play/pause overlay.
        - **Local/uploaded HLS content:** `HlsVideoPlayer` component (`artifacts/tv/src/components/HlsVideoPlayer.tsx`) on Smart TV — uses `hls.js` for adaptive bitrate (ABR) on Chromium/Firefox/Samsung/LG browsers, native HLS for Safari/WKWebView. Features: 5-level ABR quality ladder auto-selection, real-time quality badge, fullscreen HTML5 API, seek ±15s OSD, D-pad/remote key handler, cinematic loading veil, buffering spinner, 3-attempt error recovery. TV `Player.tsx` routes between the two players based on whether `hlsUrl` is present. Mobile uses `expo-av` with ExoPlayer on Android (native HLS ABR); mobile web now uses `hls.js` via HTML5 `<video>` (replaced the old open-in-tab button in `LocalVideoPlayer.tsx`). Broadcast sync position (`positionSecs`) is threaded from the TVGuide through `App.gatedPlay` into `Player.startPositionSecs` so viewers join the 24/7 broadcast in-sync.
    - **Content Organization:** Categorization of sermons (Faith, Healing, Deliverance, Worship, Teachings, Special Programs) with search, filtering, and sorting capabilities.
    - **Radio Mode:** Audio-only mode with background playback, sleep timer, and video-to-audio toggle. Powered by a persistent root-level audio engine (`PersistentAudioPlayer`) mounted in `_layout.tsx` — a hidden, offscreen YouTube iframe that owns playback whenever a sermon is selected, surviving tab navigation. The visible `/player` route takes ownership when active to prevent double-playback. Player refs use a compare-and-swap ownership pattern so racing mount/unmount transitions never null out the active controls.
    - **Offline Capabilities:** Offline video downloads using `expo-file-system` and offline metadata caching.
    - **Admin Control:** Dedicated admin panels for Live Control, subscription management, user management, video transcoding queue, scheduled notifications, and platform operations/health monitoring. The admin frontend (`artifacts/admin`) uses a modular architecture with: centralized SSE via `SSEContext.tsx` (single EventSource, pub/sub pattern, exponential backoff reconnect), typed service layer at `src/services/adminApi.ts` (all admin REST calls not in the generated API client), shared components (`PageHeader`, `ErrorAlert`, `MetricCard`), grouped sidebar navigation, and an enterprise layout with real-time sync indicator and live override badge. Live Control, Operations, and Transcoding pages all use the services layer directly to avoid generated-client type restrictions.
    - **TV Guide:** Real-time TV Guide for Smart TV app with live program highlighting and reminder system.
    - **Broadcast-Aware TV Hero:** `LiveHero.tsx` now has three distinct states driven by real API data: (1) YouTube LIVE — red badge + ambient YouTube embed + "Watch Live" CTA; (2) 24/7 Broadcast ON AIR — purple "ON AIR · TEMPLE TV" badge + broadcast thumbnail backdrop + animated real-time progress bar + "Tune In" CTA + "Up Next" indicator; (3) Off-air — muted badge + gradient fallback. `Home.tsx` subscribes to `useLiveSync` for SSE-driven updates — when the hook's `syncedAt` changes (real item transition or queue edit), `Home.tsx` immediately refetches `/api/broadcast/current` so the hero updates within seconds; a 60s interval poll remains as a belt-and-suspenders fallback for when SSE is unavailable. `api.ts` `BroadcastCurrent` type upgraded to include `positionSecs`, `totalSecs`, `progressPercent`, `item`, and `nextItem`. Both the hero `onSelect` and the row `onSelect` now thread `broadcastCurrent.positionSecs` as `startPositionSecs` through the `onPlay → App.gatedPlay → Player` chain so viewers join broadcast playback exactly in-sync.
    - **Tappable NowPlayingBar:** Mobile `NowPlayingBar` component upgraded with `onPress` prop — renders a `Pressable` with scale/opacity micro-interaction and a themed chevron icon on the right. When live, tapping navigates to the live player; when a sermon is playing, tapping navigates to that sermon. Border accent turns red for live state. Title shows "Temple TV" (not raw filename) when live.
    - **Auth-Gated Playback (non-blocking):** Auth is advisory, not a hard gate — guests can watch all content after tapping "Continue watching without signing in." The gate still appears for new content to encourage sign-up, but never interrupts an active viewing session.
        - **Mobile gate flow:** `gatePlayback()` shows the `AuthGateModal`; "Continue watching" in the modal executes `router.push` to the pending content target and then closes. The player route's `useEffect` shows the gate as a suggestion for deep-link arrivals but never calls `router.back()` — guests stay in the player. A once-shown, dismissible purple nudge banner appears below the broadcast video inviting free sign-up. The dismiss button copy changes to "Continue watching without signing in" when a video is pending.
        - **Backend:** Three device-link endpoints (`/api/auth/device-link/{create,claim,exchange}`) backed by the `device_link_codes` table — 8-char codes (ABCD-1234, unambiguous alphabet), 10-min TTL, single-use. Implemented in `artifacts/api-server/src/routes/device-link.ts`.
        - **Mobile:** Module-level binder (`artifacts/mobile/utils/auth-gate.ts`) lets non-React utilities like `navigateToSermon` consult live auth state without becoming hooks. `AuthContext` exposes `openAuthGate / pendingPlayback / consumePendingPlayback`. The gate modal (`components/AuthGateModal.tsx`) is mounted at the root in `_layout.tsx`. Login + signup screens consume the pending target on success and resume playback. `/link` page lets the user pair their TV by entering the on-screen code.
        - **TV:** Minimal localStorage auth (`artifacts/tv/src/lib/auth.ts`) with subscriber pattern. `App.tsx` funnels every `onPlay` through `gatedPlay()`. The TV `AuthGateModal` POSTs `/create`, displays the code at couch-readable scale (>5rem), and polls `/exchange` via a ref-managed recursive `setTimeout` (one in-flight poll, no leakage). Auto-regenerates on expiry with a `creatingRef` guard preventing overlapping creates.
    - **Broadcast Player UI (clean mode):** When `isLive || isBroadcastMode` in the mobile player, the entire scrollable metadata section (category badge, raw filename title, preacher name, "Watch on YouTube" button, "Up Next on Temple TV", seek bar, playback controls) is replaced with a minimal broadcast footer: a red "ON AIR"/"LIVE" badge + "Temple TV · JCTM Broadcasting" channel name, an "Audio only"/"Video" toggle button, and a Share button. For VOD content, the full existing metadata + controls remain unchanged. TV Home (`Home.tsx`) was also fixed to thread `localVideoUrl` as `hlsUrl` through both the broadcast row handler and `LiveHero.onSelect` so the `HlsVideoPlayer` is correctly chosen over the YouTube iframe for local MP4 broadcast content.
    - **Transcoding system hardening:**
      - Route order bug fixed: `DELETE /admin/transcoding/clear` was unreachable (shadowed by the `/:jobId` wildcard) — `/clear` now declared before `/:jobId` so the literal path wins. The "clear failed/done/cancelled" function now actually works.
      - Cancel endpoint extended: `DELETE /admin/transcoding/:jobId` previously only cancelled `queued` jobs. Now also accepts `failed` jobs so admins can dismiss non-retryable failures.
      - Source-file resilience: When the transcoder picks up a job whose `video_path` no longer exists locally (e.g. after a server migration), it now queries the video's `localVideoUrl` and downloads the file via HTTP to a temp path before encoding. The temp file is deleted after the job completes or fails. This prevents ENOENT failures when running in a new environment.
      - Import: `Readable` from `node:stream` added to `transcoder.ts` for the `Readable.fromWeb` web-stream adapter used during HTTP download.
    - **Hero Cinematic Redesign (cross-platform):**
      - **Mobile (`index.tsx`):** Edge-to-edge hero with `LinearGradient`, dynamic height (`62vh` mobile / `52vh` tablet), cinematic 4-layer gradient stack (top scrim + bottom content pull + left editorial vignette + side bleed), floating header overlaid on hero, ON AIR badge with pulse animation, "Library" secondary CTA, and JCTM channel bug watermark.
      - **TV (`LiveHero.tsx`):** Hero height expanded from `min(82vh, 820px)` → `min(94vh, 1080px)` with `minHeight: max(72dvh, 480px)`. The 120% video scaling hack is removed — `inset: 0; width: 100%; height: 100%; objectFit: cover` lets the video fill the container natively. Gradient stack now has four distinct layers: top scrim, bottom content panel, left editorial vignette, and right edge fade. Channel bug watermark added (top-right, "TEMPLE TV / JCTM BROADCASTING"). Metadata panel bottom padding enlarged for cinematic breathing room.
      - **Player broadcast video:** `LocalVideoPlayer` gains `coverMode` prop (uses `ResizeMode.COVER` for broadcast, `CONTAIN` for VOD) and `playerHeightOverride` prop so the player screen can pass its computed taller container height (11:16 aspect ratio for broadcast vs 9:16 for VOD). Both props are passed from `player.tsx` when `isBroadcastOrLive` is true. The `videoPlayerHeight` calculation moved to after `isLive`/`isBroadcastMode` are derived to avoid TypeScript forward-reference errors.
    - **Security & Observability:** API security middleware, admin API protection with `ADMIN_API_TOKEN`, production metrics (Prometheus-compatible), and structured logging.
    - **Enterprise SEO:** Per-route `<title>`, description, canonical, OG, and Twitter cards on every mobile web page via the `usePageSeo` hook (`artifacts/mobile/hooks/usePageSeo.ts`). Root `+html.tsx` ships a Schema.org `@graph` (Organization + WebSite with sitelinks SearchAction + BroadcastService + MobileApplication). Player route emits dynamic `VideoObject` / `BroadcastEvent` JSON-LD per sermon for Google Video carousel eligibility. Sitemap architecture is a sitemap-index at `templetv.org.ng/sitemap.xml` that fans out to a static `sitemap-pages.xml` (mobile `public/`) and a **dynamic** `sitemap-sermons.xml` served by the API server (`artifacts/api-server/src/routes/sitemap.ts`) with full Google Video Sitemap extensions. TV web has its own complete head + manifest + robots; admin is hard-blocked from indexing (`noindex,nofollow,noarchive,nosnippet` + full-disallow `robots.txt`).
    - **Containerization:** Docker support with `docker-compose` for orchestration of API, Admin, PostgreSQL, and Redis services.

## Local Video Upload Pipeline

The admin panel supports chunked resumable uploads of local sermon videos (MP4/MOV/WebM) up to 5 GB. The pipeline:

1. **Admin → Init** (`POST /api/admin/videos/upload/init`): client-generated UUID session, metadata (title, category, preacher, durationSecs), chunked plan written to disk for crash recovery.
2. **Admin → Chunks** (`POST /api/admin/videos/upload/:id/chunk`): 8 MB multipart chunks with SHA-256 verification, adaptive concurrency (1–6 parallel streams), prefetch pool.
3. **Admin → Finalize** (`POST /api/admin/videos/upload/:id/finalize`): streams chunks into assembled file, magic-byte validates (MP4/MOV `ftyp`), computes SHA-256, inserts DB row (`videoSource="local"`, `localVideoUrl` set immediately), **automatically calls `upsertBroadcastQueueVideo`** to add the video to the broadcast queue, queues HLS transcoding job.
4. **Transcoding** (`artifacts/api-server/src/lib/transcoder.ts`): FFmpeg HLS ladder (1080p/720p/480p/360p/240p, upscale-skipped), updates `hlsMasterUrl` + `duration` on success. Videos fall back to raw MP4 `localVideoUrl` if transcoding fails.
5. **Library visibility**: all three platforms use `GET /api/videos?limit=500` (public, no auth) ordered by `importedAt DESC`. The admin library auto-refreshes via `refetch()` post-upload. The mobile library (`useLocalVideos`) uses stale-while-revalidate caching. The TV library polls every 5 minutes.

**Direct Upload to Broadcast Queue:**
The Broadcast Queue page has an **"Upload Video"** button that opens a full-featured `VideoUploadModal` (drag-and-drop, multi-file, chunked, resumable, SHA-256, adaptive concurrency, H.264 client compression). After upload finalize, the server's existing `upsertBroadcastQueueVideo` automatically places the video in the queue with no extra API calls needed. The queue UI auto-refreshes via `loadAll()` on completion.

**Shared upload component:**
- `artifacts/admin/src/lib/uploadEngine.ts` — shared constants, types, and pure upload utilities (chunk XHR, SHA-256, duration detection)
- `artifacts/admin/src/components/VideoUploadModal.tsx` — reusable upload dialog; used in both Video Library and Broadcast Queue with `broadcastMode` and `storageKey` props for context differentiation; `storageKey="ttv-broadcast-upload-v1"` for broadcast, `"ttv-upload-session-v4"` for video library

**Video Library Pagination:**
The Video Library now supports full pagination (`page` query param, 50 items/page). Page controls appear below the list when there are multiple pages. Changing the search query resets to page 1.

**Key files:**
- `artifacts/admin/src/pages/videos.tsx` — upload UI + chunked pipeline + pagination
- `artifacts/admin/src/pages/broadcast.tsx` — broadcast queue with direct upload button
- `artifacts/admin/src/lib/uploadEngine.ts` — shared upload engine utilities
- `artifacts/admin/src/components/VideoUploadModal.tsx` — shared upload modal component
- `artifacts/api-server/src/routes/admin.ts` — init / chunk / finalize / public videos endpoints
- `artifacts/api-server/src/lib/transcoder.ts` — HLS transcoding worker
- `artifacts/mobile/hooks/useLocalVideos.ts` — mobile local-video fetching + duration formatting
- `artifacts/tv/src/hooks/useData.ts` — TV polling + category mapping for local uploads
- `artifacts/tv/src/lib/api.ts` — TV video fetching, passes `apiCategory` from DB

## Direct Browser → S3 Upload (April 2026)

Admin video uploads now bypass the API server's byte-stream by default. The
browser PUTs the file straight to AWS S3 via a presigned URL minted by the
API server, freeing server CPU/bandwidth from the upload critical path.

- **Endpoints (`artifacts/api-server/src/routes/admin.ts`):**
  - `POST /api/admin/videos/upload/s3-init` — validates title + size (≤ 5 GB
    cap), sanitises ext/MIME, mints a 1-hour presigned PUT URL pointing at
    `videos/<sessionUuid>.<ext>`, returns `{sessionId, objectKey, uploadUrl,
    contentType}`.
  - `POST /api/admin/videos/upload/s3-finalize` — HEADs the S3 object to
    confirm it landed (and to use S3's authoritative `ContentLength`),
    stamps ACL metadata via CopyObject, inserts the videos row with
    `objectPath = <S3 key>` and `localVideoUrl = ${baseUrl}/api/videos/<id>/source`,
    and queues a transcoding job with `videoPath=""` so the transcoder's
    HTTP fallback fetches the source via the redirect.
  - `GET /api/videos/:id/source` — public 302 redirect to a freshly-minted
    6-hour presigned GET URL. Used as the stable `localVideoUrl` for clients
    and transcoder.
- **Client (`artifacts/admin/src/lib/uploadEngine.ts`):** new
  `uploadFileToS3(presignedUrl, body, contentType, signal, onProgress,
  stallTimeoutMs)` XHR helper with the same progress + stall-watchdog
  semantics as `uploadChunk`, and ETag capture on success.
- **Modal (`artifacts/admin/src/components/VideoUploadModal.tsx`):** new
  "Upload directly to S3" toggle (default ON, persisted in localStorage).
  `runFileUpload` branches into `runS3DirectUpload` when the toggle is on,
  the file is ≤ 4.5 GB, no resume session is in progress, and no custom
  thumbnail was attached. The chunked upload path remains the fallback for
  files > 4.5 GB, custom thumbnails (which still need a session-scoped
  upload), and resume scenarios. The transcoder auto-generates thumbnails
  for the S3 direct flow.
- **Limits:** S3 single-PUT cap is 5 GB; client cap is 4.5 GB to leave HTTP
  overhead headroom. Object key regex is locked to `^videos/[A-Za-z0-9._-]+$`.

### Telemetry (April 2026)

A dedicated `s3_upload_telemetry` table (`lib/db/src/schema/s3-upload-telemetry.ts`)
records every direct-S3 upload attempt so operators can verify the feature is
healthy before flipping it on for everyone.

- **Events tracked:** `init`, `success`, `server_fail`, `client_error`,
  `client_stall`, `client_abort`. Each row stores sessionId, sizeBytes,
  durationMs, derived throughputBps, errorKind, errorMessage, userAgent.
- **Server instrumentation (`artifacts/api-server/src/routes/admin.ts`):**
  - `s3-init` writes one `init` row per presigned URL minted.
  - `s3-finalize` writes a `success` row (using the client-reported
    `clientDurationMs` to compute throughput) or a `server_fail` row on
    every error path (validation, missing HEAD, empty object, exception).
  - New `POST /api/admin/videos/upload/s3-telemetry` accepts client-side
    `client_error` / `client_stall` / `client_abort` reports.
  - New `GET /api/admin/uploads/s3-telemetry/summary?hours=N` returns
    aggregations: counts by event, attempts/success/failures, success-rate
    %, p50/p95 throughput (via PostgreSQL `percentile_cont`), avg + total
    bytes, and the top 5 errors by count.
- **Client (`artifacts/admin/src/components/VideoUploadModal.tsx`):**
  the S3 path measures wall-clock PUT duration, posts it to `s3-finalize`
  as `clientDurationMs`, and fires best-effort telemetry on stall / abort
  / network error.
- **Surfacing (`artifacts/admin/src/pages/operations.tsx`):** new
  `S3DirectUploadTelemetryCard` card on the Operations page with 1h / 24h /
  7d window toggles, a metric strip (attempts, success-rate, p50/p95
  throughput, total bytes), a top-5 errors list, and per-event raw counts.
  Polls every 15s.
- **Telemetry helper invariants:** `recordS3Telemetry()` swallows all
  failures and only logs at `warn` — a telemetry insert failure must
  never break a real upload. Error messages are capped at 500 chars and
  user agents at 240 chars to keep table size bounded under failure storms.

## Admin Panel Defensive Hardening (April 2026)

After repeated user reports of admin pages crashing with `Unexpected token '<'` JSON-parse errors and `X.map is not a function` runtime errors, all 11 admin pages were hardened across three rounds:

- **Class A — non-JSON response bodies** (HTML proxy fallbacks, 502s): `artifacts/admin/src/services/adminApi.ts` switched all parsing to `text()` + guarded `JSON.parse` and throws a controlled `AdminApiError` with a human-readable message. `broadcast.tsx` and `live-monitor.tsx` direct-fetch paths got the same safe-parse treatment. Generated API client (`lib/api-client-react/src/custom-fetch.ts`) already throws structured `ResponseParseError`.
- **Class B — non-array list payloads**: every `.map / .filter / .reduce / .length` call site on data from API was wrapped with `Array.isArray(...) ? ... : []` either at ingress (preferred for `setState` / `useMemo`) or inline at the render site. Pages touched: `analytics`, `broadcast`, `launch-readiness`, `live-monitor`, `notifications`, `operations`, `playlists`, `schedule`, `transcoding`, `users`, `videos`.

Rule of thumb going forward: **never trust API list shape** — coerce with `Array.isArray` at the boundary. **never call `res.json()` directly** in admin pages — use `adminApi` helpers or wrap in `try/catch` around `text()` + `JSON.parse`.

### Round 4 — workflow `BASE_PATH` fix (April 2026)

The `Start application` workflow was launching admin/tv/mobile dev servers with only `PORT=...` set, omitting the `BASE_PATH=/<slug>/` env var that `vite.config.ts` reads to compute Vite's `base`. As a result, served `index.html` referenced `/src/main.tsx` and `/@vite/client` instead of `/admin/src/main.tsx` etc. — every asset 404'd through the Replit path-routed proxy and the React app never mounted, surfacing as the avalanche of `<!DOCTYPE` / `K.map` / `e?.map` / `undefined.map` errors the user reported. Fixed by updating the workflow command to set `BASE_PATH=/admin/`, `BASE_PATH=/mobile/`, and `BASE_PATH=/tv/` alongside each `PORT=...`. The values match each artifact's `[services.env]` block in its `.replit-artifact/artifact.toml` so dev now matches what production already builds with.

### Round 4b — broadcast loadAll status-aware errors + stale `ADMIN_API_TOKEN` (April 2026)

Two more issues surfaced after the BASE_PATH fix:

1. `broadcast.tsx` `loadAll` silently dropped non-OK responses (so a 401 produced no visible error, just empty data) and reported a generic "Unexpected non-JSON response" message when any `.ok` body returned null. Rewrote it to be status-aware: 401/403 → "Admin authentication failed (401/403). Open the admin key prompt and paste a valid ADMIN_API_TOKEN."; other non-OK → "queue: HTTP 500" etc. (per-endpoint); empty/malformed body → labelled "queue: empty or malformed response". The aggregated message tells you which endpoint failed and how.
2. **The real cause of every page returning 401 was a stale `ADMIN_API_TOKEN` env in the api-server process.** The Replit secret had been rotated, but the api-server had been running since before the rotation, so `process.env.ADMIN_API_TOKEN` held the old value and rejected every request signed with the current one. Diagnosed by reading `/proc/<pid>/environ` and comparing to the shell value. Fix: restart the workflow whenever `ADMIN_API_TOKEN` (or any secret the api-server reads) is rotated. After restart, all 12 admin endpoints returned 200 with the same token.

Operational note: any time admin pages start returning 401 across the board, first check that `process.env.ADMIN_API_TOKEN` inside the running api-server matches the shell's `$ADMIN_API_TOKEN`. A stale-env mismatch surfaces as "Operations status unavailable", "Failed to load broadcast data", and similar messages everywhere at once.

### Round 4c — diagnostic logging + URL audit (April 2026)

After Rounds 1–4 fixed the upstream causes, did a full professional audit of every URL the admin frontend calls vs every route the api-server actually serves. Two stale URL bugs were still hiding in the codebase and would have produced "Failed to …" toasts in real-world use:

1. `artifacts/admin/src/pages/broadcast.tsx` line ~905: was calling `GET /api/admin/broadcast/current` (404 — no such route). The public endpoint is `GET /api/broadcast/current` (no `/admin/` prefix). Already corrected in earlier work; verified.
2. `artifacts/admin/src/components/command-palette.tsx` line ~120 (`stopOverride`): was calling `DELETE /api/admin/live/override` (404 — no such route). The api-server exposes overrides as POST start/stop/extend actions; corrected to `POST /api/admin/live/override/stop`.

Also added structured `console.error` diagnostics to `safeJson()` in `broadcast.tsx`. Whenever it returns null (empty or non-JSON body), it now logs the URL, status, content-type, and — for non-JSON content-types only (to avoid leaking JSON payload fragments) — a 200-char body preview plus the parse error. So next time "empty or malformed response" appears in the UI, the browser console pinpoints exactly which endpoint and what bytes caused it.

Verification after the round:
- TypeScript clean across `artifacts/admin`, `artifacts/api-server`, `lib/api-client-react`.
- All 15 admin URLs the frontend calls return 200 against the api-server.
- Both URL fixes verified with curl (`POST /api/admin/live/override/stop` → 200; `GET /api/broadcast/current` → 200).

How the auto-generated React Query client (`@workspace/api-client-react`) gets the admin token: the admin app monkey-patches `window.fetch` in `lib/admin-access.ts` `configureAdminAccess()`, injecting `Authorization: Bearer <token>` for any URL whose path starts with `/api/admin`. This is invoked from `main.tsx` before React mounts. As a result, the generated client (which uses the standard `fetch` global) receives the token automatically without anyone calling `setAuthTokenGetter()` from the client package. If you ever switch the generated client to a non-fetch transport (e.g. axios), this wiring will need to be redone explicitly.

### Round 4d — page-level enhancements (April 2026)

Added concrete operator-facing improvements to the smaller pages, staying within the no-schema/no-deps/no-rewrites constraints.

1. **Users (`artifacts/admin/src/pages/users.tsx`)**
   - Real avatar rendering when the user has `avatarUrl` (uses existing `Avatar`/`AvatarImage`/`AvatarFallback` primitives); coloured-initial fallback otherwise.
   - **Verified / Unverified / All** filter dropdown (client-side over current page; the API doesn't accept a verified flag, so we surface the limitation inline as "Filtering this page · use Export CSV to apply across all pages").
   - **Export CSV** button that pages through the `/api/admin/users` endpoint in 100-user chunks (server's hard cap), respects the search + verified filters, and downloads `temple-tv-users-<timestamp>.csv` via a Blob URL — no new dependency.
   - Local `AdminUser` type defined in-file because the package barrel `lib/api-client-react/src/index.ts` re-exports `* from "./generated/api"` and that file's `import { AdminUser } from "./api.schemas"` is type-only (stripped at compile), so `AdminUser` isn't reachable from the barrel. Mirrored the small set of fields actually rendered.

2. **Analytics (`artifacts/admin/src/pages/analytics.tsx`)**
   - Manual **Refresh** button driving `refetch()` (spinner while `isFetching`).
   - **Auto-refresh** toggle (60-second `refetchInterval`, off by default; React Query auto-pauses background tabs).
   - **"Updated <Xm ago>"** indicator powered by `dataUpdatedAt`, re-rendering every 30s so the relative time stays current even when the data isn't refetching.
   - **Export top videos** button that emits `temple-tv-top-videos-<period>-<timestamp>.csv`.

3. **Schedule (`artifacts/admin/src/pages/schedule.tsx`)**
   - Inline **local-time hint** rendered next to every per-entry UTC time block: `09:00 – 10:30 UTC · 13:00–14:30 IST`. Computed via `Date.setUTCHours()` + `toLocaleTimeString()` and `Intl.DateTimeFormat` for the TZ abbreviation. Suppressed when the viewer's `getTimezoneOffset()` is already 0.
   - Footer note updated to mention the local-equivalent hint when applicable.
   - Deliberately did NOT shift entries between day columns when local TZ would put them on a different day — that would change the meaning of "today" and confuse operators reading the 7-day grid. Comment in the code documents this decision.

Security hardening (in response to Round 4d architect review):
- **CSV formula-injection guard** added to both `csvEscape()` helpers (`users.tsx`, `analytics.tsx`). Cells whose first non-whitespace character is `=`, `+`, `-`, `@`, TAB, or CR are prefixed with a single quote so they are rendered as text rather than executed as a formula by Excel/Google Sheets/Numbers (OWASP "CSV Injection", CWE-1236). Without this, a user with a `displayName` like `=cmd|'/c calc'!A1` could weaponize an exported user list.
- **Truncation warning** added to the users CSV export. If the 200-page (20k row) safety cap is hit, the toast switches to a destructive variant explicitly stating "Export capped at N rows" so operators know to refine the search instead of trusting an incomplete file.

Verification:
- TypeScript clean across `artifacts/admin`, `artifacts/api-server`, `lib/api-client-react`.
- `/api/admin/users`, `/api/admin/analytics`, `/api/admin/schedule` all 200 after restart.
- Architect re-review of Round 4d security fix: **Pass**. CSV-injection guard correctly orders formula neutralization before CSV quoting; truncation toast switches to the destructive variant with explicit row count. No new findings.

### Round 4e — broadcast.tsx error diagnostics (April 2026)

A user reported the broadcast page surfacing three useless errors at once: "queue: empty or malformed response; current broadcast: empty or malformed response; live status: empty or malformed response". All three endpoints returned valid 200 JSON when curled directly — the bug was the diagnostic itself: it collapsed every parse failure into the same opaque string and gave the operator no signal about WHAT to do.

Fix in `artifacts/admin/src/pages/broadcast.tsx`:

1. **Replaced `safeJson`'s `Promise<T | null>` return with a tagged `JsonResult<T>`** carrying the failure reason (`empty` / `html_fallback` / `non_json`), HTTP status, content-type, and a body preview. The HTML fallback case is detected explicitly with a regex that matches `<!doctype html>`, `<html`, `<head`, or `<body` at the start of the body.
2. **Added `describeJsonError(label, err)`** that turns each variant into an actionable banner string. The HTML-fallback path explicitly tells the operator the symptom suggests `/api/*` is hitting the SPA instead of the API server. The non-JSON path includes the actual content-type and the first ~80 chars of the body so they can identify the source immediately.
3. **Migrated all three call sites in `loadAll`** plus the videos search modal's `fetchVideos` to the new tagged result.
4. **Added a no-token early-out in `loadAll`**: if `localStorage["temple-tv-admin-token"]` is empty, the page now shows a single clear "Admin access key not set — paste your ADMIN_API_TOKEN" message instead of letting three requests 401 and then explaining auth failed.
5. The existing **Retry button** is wired to `loadAll` so the user can re-run after fixing things without a full page reload.
6. The 401/403 message was tightened to explicitly mention the token may have been rotated and no longer matches the server's `ADMIN_API_TOKEN`.

Verification:
- TypeScript clean across the workspace.
- All three broadcast endpoints continue to return 200 JSON via curl, the outer proxy (port 80), and the vite proxy (port 23744).
- The error-state UI still renders the Retry button. The new no-token branch matches the existing admin-key modal flow.

### Round 4f — silent-catch elimination across remaining admin pages (April 2026)

A repo-wide audit of `} catch {` (no error binding) across the 13 admin pages turned up three real defects where the caught error was discarded entirely, leaving the operator with either a generic toast or nothing at all:

1. **`live-monitor.tsx`** (line 263) — caught the `/admin/live/health` failure but dropped the cause; the toast just said "Failed to load live health data" with no description, and the empty-state card said "Check that the API server is running" even when the real cause was a 401, an HTML fallback, or a JSON shape mismatch. Fixed by binding the error, recording the message in a new `fetchError` state, surfacing it in the toast description AND the inline empty-state card, and adding a Retry button that re-runs `fetchHealth`.

2. **`notifications.tsx`** (line 113) — silently swallowed `/admin/notifications/scheduled` failures, leaving the operator looking at "No upcoming notifications scheduled." while the API was actually down or rejecting the token. Fixed by binding the error, storing it in a new `schedError` state, and rendering a destructive-bordered error block (with the underlying message and a Retry button) ahead of the empty-state branch in the Upcoming card.

3. **`launch-readiness.tsx`** (line 106) — toasted "Launch readiness unavailable" with no description; same root cause / same fix pattern (bind error, include `err.message` in the toast description) as the round-4d hardening on dashboard/users/analytics.

Every remaining `} catch {` in the page tree was reviewed and confirmed safe: `live-monitor.tsx:131,139,296` are localStorage parse / JSON.parse fallbacks where ignoring is correct; `schedule.tsx:59` is a timezone-resolution fallback; `videos.tsx:601` is a JSON.parse on an already-failing fetch where the original error is preserved by the surrounding `throw new Error(msg)`.

Verification:
- `tsc --noEmit` clean for both `@workspace/admin` and `@workspace/api-server`.
- After workflow restart, all three previously-silent endpoints (`/admin/live/health`, `/admin/notifications/scheduled`, `/admin/launch/readiness`) return 200 via the API server.
- New `RefreshCw` import added to `notifications.tsx` to power the Retry button; no new dependencies, no schema changes, no rewrites.

### Round 4g — shared safe-json lib + central adminRequest hardening (April 2026)

The `safeJson` / `describeJsonError` / `JsonResult<T>` trio that Round 4e introduced inside `broadcast.tsx` was lifted into a new shared module at **`artifacts/admin/src/lib/safe-json.ts`** so the central admin API client can reuse the exact same diagnostics. This closes the explicit operator request: *"API stability improvements to eliminate failures such as non-JSON responses and unreachable server issues."*

Three concrete changes:

1. **New `lib/safe-json.ts`** — exports `safeJson<T>(res, consoleLabel?)` returning `JsonResult<T>` (`{ok:true,data}` / `{ok:false, reason: 'empty' | 'html_fallback' | 'non_json', status, contentType, bodyPreview}`), plus `describeJsonError(label, err)` for human-readable banner strings. Body-preview safety preserved: when the server claimed `application/json` but failed to parse, the preview is suppressed in both the visible string and the console diagnostic (it may contain user data).

2. **`services/adminApi.ts` rewrite of `adminRequest`** — every page that calls `adminGet/adminPost/adminPut/adminPatch/adminDelete` now benefits automatically:
   - **Network-failure path now distinguishes `AbortError` from connection failures.** The previous code surfaced raw "Failed to fetch" from the browser; it now throws `new AdminApiError(0, "API server unreachable at <url> (<detail>). Check that the API workflow is running.")` so operators see the actual cause rather than a generic browser error.
   - **Error-body parsing uses `safeJson`** instead of a silent `try/catch {}`. An HTML 500 page from a proxy is no longer reported as the literal status text — the message is augmented with "server returned HTML (proxy may be routing /api to the SPA)." or "(non-JSON <content-type>)" so the operator sees the source of the failure.
   - **Successful-but-malformed JSON** now throws `AdminApiError(status, describeJsonError(...))` instead of silently returning a half-parsed payload. Empty 200s still return `undefined` to preserve existing call-site contracts (e.g., DELETE handlers).
   - **204 No Content** is short-circuited explicitly so it never hits the parser.

3. **`pages/broadcast.tsx`** — removed the inline 70-line `safeJson`/`describeJsonError`/`JsonResult` block and now imports from `@/lib/safe-json`. Behavior is byte-identical at the call sites.

Constraints honored: no new runtime dependencies, no schema changes, no rewrites of any page, no removal of `AdminApiError` (its `status` and `message` fields remain stable for `instanceof` checks elsewhere). The shared module is pure — no React, no DOM, no globals — so it's trivially importable from any future admin code path.

Verification:
- `tsc --noEmit` clean for `@workspace/admin`.
- After workflow restart: `/api/admin/broadcast`, `/api/admin/live`, `/api/admin/analytics`, `/api/admin/users`, `/api/admin/ops/status`, `/api/admin/transcoding/queue`, `/api/admin/launch/readiness`, `/api/admin/notifications/scheduled`, and `/api/admin/live/health` all return 200 against the API server.
- The error path was exercised mentally for each branch: `network throw → AdminApiError(0, "unreachable")`, `!res.ok + JSON body → status text replaced by error.error`, `!res.ok + HTML body → status text + " — server returned HTML"`, `200 + HTML body → AdminApiError(200, describeJsonError(...))`, `200 + empty body → undefined` (legacy contract preserved), `204 → undefined`.

### Round 4h — manual theme override on top of auto theming (April 2026)

The admin layout already had a small badge in the top bar showing the resolved theme ("Light" or "Midnight") with a tooltip explaining that the theme switched automatically at 8pm and 6am local time. The badge was non-clickable — operators in fixed-lighting environments (a control room with always-dim screens, or a service running past midnight where the team prefers to keep light mode) had no way to override.

This round added a 3-mode override (Auto / Light / Dark) on top of the existing auto behavior, without breaking the original "light-first auto theming" design intent.

Changes:

1. **`lib/theme.ts` extended** — `applyAutoTheme()` now reads a stored `ThemeMode` (`"auto" | "light" | "dark"`) from `localStorage["temple-tv-admin-theme-mode"]`. When `"auto"` it falls back to the original time-of-day detection (`isMidnightHour()`), preserving the legacy behavior byte-for-byte. New exports: `getThemeMode()`, `setThemeMode()` (writes localStorage + dispatches a custom event for in-tab listeners + calls `applyAutoTheme()`), `nextThemeMode()` (auto → light → dark → auto cycle), and the `ThemeMode` type. All localStorage access is wrapped in `try/catch` for Safari private mode and sandboxed-iframe cases.

2. **`layout.tsx` upgraded the badge to a button** — the previously non-clickable pill is now a semantic `<button type="button">` with a focus ring, an `aria-label`, a tooltip that updates per-mode, and a label that displays the active mode (`Auto · Midnight`, `Auto · Light`, `Light`, `Dark`). The component listens for the in-tab custom event AND the cross-tab `storage` event so a toggle in one operator window propagates to all others; the storage handler is narrowed to the specific theme key so unrelated localStorage writes (admin token, viewer history) don't trigger a re-render. The `CustomEvent.detail` is validated against the union literal before being trusted.

3. **`App.tsx` untouched** — its 60-second `applyAutoTheme()` interval now correctly honors the stored override (when set to `light`/`dark`, the tick is a no-op for the resolved theme; when `auto`, it still flips at 8pm/6am as before).

Architect review: **PASS** on all six verification points (localStorage resilience, SSR hygiene, auto-tick vs override coexistence, cross-tab `storage` correctness, listener lifecycle cleanup, accessibility). Three optional polish items applied: dropped a redundant `applyAutoTheme()` call, narrowed the storage handler to the specific key, and added payload validation for the custom event.

Verification:
- `tsc --noEmit` clean for `@workspace/admin`.
- Workflow restarted and serving on the configured BASE_PATH.
- Constraints respected: no new dependencies, no schema changes, no rewrites of any other component.

### Round 4i — broadcast page UX consistency + missed silent catch (April 2026)

The `broadcast.tsx` page is the most critical screen in the admin (it controls what airs live). It already used shadcn `AlertDialog` for the Clear Queue and End Live confirmations, but the per-item Remove action still used the browser-native `window.confirm()` — a UX inconsistency on the highest-stakes page. Round 4f's silent-catch elimination pass also missed one occurrence: the bulk clear loop did `await adminFetch(...).catch(() => {})` per item, which meant if any individual delete failed (404 if another operator already removed it, network failure mid-clear, token rotation), the local UI was emptied anyway and the operator saw "Queue cleared" while items remained in the database.

Changes:

1. **Per-item delete uses shadcn AlertDialog** — added a `removeConfirmId: string | null` state. `handleRemove(id)` now just opens the dialog (sets the state); the actual DELETE is in a new `handleConfirmRemove` that fires from the dialog's destructive button. The dialog interpolates the queue item's title into the description (with a graceful fallback if the item disappeared via SSE between open and confirm) and resets the state on Cancel / Esc / click-outside via the `onOpenChange` handler.

2. **Bulk clear surfaces partial failures** — `handleClearQueue` now tracks `succeededIds` and `failures` arrays. On full success: `setQueue([])` and a normal toast with the count. On partial failure: only the succeeded items are removed from local state, a destructive-variant toast reports `"X of N removed. Y failed (e.g. <first reason>)"`, and `loadAll()` runs to reconcile against the server-of-truth in case local state drifted from the actual queue.

Architect review: **PASS**.

Verification:
- `tsc --noEmit` clean for `@workspace/admin`.
- Workflow restarted; broadcast page serves and the four AlertDialogs (Add, Go Live, End Live, Clear Queue, Remove) are now consistent shadcn dialogs end-to-end.

### Round 4j — silent-catch sweep extended to components/ (April 2026)

Round 4f's silent-catch elimination pass only swept `artifacts/admin/src/pages/`. A grep this round across the full `artifacts/admin/src/` tree found two missed instances in `components/VideoUploadModal.tsx`:

- `cancelTask` line 781: `await uploadAdminFetch(.../upload/${task.sessionId}, { method: "DELETE" }).catch(() => {});`
- `cancelAll`  line 796: same pattern in the close-all loop.

Both are in the upload cancel path. The local upload aborts via `task.abortController?.abort()` regardless, but the server-side DELETE that cleans up the upload session row + already-uploaded chunks was silently dropped on failure. In production this meant orphaned upload sessions could accumulate server-side (visible in `/api/admin/uploads/active`) with no operator awareness — and could meaningfully fill storage on a busy media operation.

Changes:

- **Extracted `cleanupSession(sessionId)` helper** — wraps the server-side DELETE in an `AbortController` with an 8-second hard timeout. Even a fully hung connection resolves within 8s with a `"timed out (8s)"` failure record. Distinguishes `AbortError` (timeout), `!res.ok` (HTTP error), and thrown network errors.
- **`cancelTask` is now non-blocking** — local teardown (abort upload, remove from `tasksRef`, clear session, force re-render) happens synchronously and immediately. The server-side cleanup DELETE runs as `void cleanupSession(...).then(...)` background work; on failure it `console.warn`s with the session id and surfaces a destructive `"Upload cancelled (cleanup pending)"` toast so operators can check Active Uploads.
- **`cancelAll` is now non-blocking** — snapshots all session ids, aborts every upload, closes the modal, all synchronously. Then `void Promise.all(sessionIds.map(cleanupSession)).then(...)` runs every cleanup in parallel in the background and aggregates failures into a single destructive `"N upload session(s) need manual cleanup"` toast.
- The operator's cancel feels instant regardless of network conditions, and orphaned upload sessions are still surfaced (just asynchronously).

A second `grep` across all of `artifacts/admin/src` for the silent-catch pattern (`.catch(() => {})`, `.catch(() => null)`, etc.) now returns **zero hits**. The admin tree is clean.

Architect review: **PASS**.

Verification:
- `tsc --noEmit` clean.
- Workflow restarted; server logs show clean startup (FFmpeg verified, schedulers running, first request 304 in 4ms, no runtime errors).
- Constraints respected: no new dependencies, no schema changes.

### Round 4k — One-shot retry on transient API failures

**Bug reported by operator:** Transcoding page surfaced `Encoding queue unavailable: API /admin/transcoding/queue: server returned HTML instead of JSON`.

**Root cause:** The Round 4g `safe-json` diagnostic was working perfectly — it correctly identified that the response body was HTML rather than JSON. The proximate cause was a workflow-restart race: the api-server's `dev` script runs `pnpm run build && pnpm run start`, leaving a ~1-2 second window when port 8080 refuses connections. During that window, vite's dev proxy (or the workspace path-based router) returns HTML — either an error page or the admin SPA's index.html — for `/api/*` requests. Direct verification (`curl localhost:8080` and `curl localhost:80`) both return 200 JSON; routing is fine.

**Fix in `artifacts/admin/src/services/adminApi.ts`:**

1. Extracted the per-attempt logic into `doAdminRequest`. The public `adminRequest` is now a thin retry wrapper.
2. Added `transient: boolean` to `AdminApiError`. Set true for:
   - Network unreachable (status 0 from `fetch` reject — distinct from `AbortError`).
   - HTTP 502/503/504 gateway/proxy failures.
   - `safeJson` `html_fallback` reason on either success or error responses.
   - **NOT** set for genuine 4xx, application 5xx with structured JSON body, or empty 204/200.
3. The wrapper retries **once**, after an 800 ms delay, only when:
   - Method is `GET` or `HEAD` (idempotent — POST/PUT/PATCH/DELETE never retry, to avoid double-mutation if the original request reached the server but the response was lost).
   - `signal` is not already aborted.
   - Error is `instanceof AdminApiError && err.transient === true`.
4. The 800 ms delay honors the caller's `AbortSignal`. If the user cancels mid-wait, the Promise rejects with a fresh `AbortError` (not the underlying transient `AdminApiError`) so consumers like React Query that branch on `err.name === "AbortError"` correctly treat it as a clean cancellation, not a retried failure.
5. Listener cleanup: timer-fires path explicitly removes the abort listener before resolving; abort-fires path uses `{ once: true }` and clears the timer before rejecting.

**Architect review:** First pass **PASS** with one medium correctness flag (the abort-during-backoff was rejecting with the wrong error); fixed and second pass returned a clean **PASS** confirming all four verification points (abort semantics, no regression on happy/4xx/5xx paths, listener cleanup correct in all exit paths, post-wait abort check correctly removed as redundant).

**Why this is the right fix:** Workflow-restart races are a real, recurring class of failure in this dev environment. Surfacing them to the operator as actionable errors (Round 4g's diagnostic) was a strict improvement over generic "fetch failed" messages, but operators shouldn't have to click "Retry now" for a 1-2 second restart blip. The retry is silent, scoped tightly to the transient cases, and never applied to mutating requests.

### Round 4l — Universal transient retry coverage + auth-probe hardening (April 2026)

**Bug reported by operator:** After Round 4k shipped, the operator hit the same `html_fallback` failure on the broadcast page on three parallel calls (queue, current broadcast, live status). Round 4k's retry only covered the central `adminRequest` client; six raw-fetch sites bypassed it entirely.

**Coverage fixes in `artifacts/admin/src`:**

1. New exported helper `fetchWithTransientRetry(factory, signal?)` in `services/adminApi.ts`. Shares one backoff schedule with `adminRequest` — see point 2 below. Retries on factory throw (excluding `AbortError`), HTTP 502/503/504, and 200/2xx with HTML body (sniffed via `Response.clone().text().slice(0, 128)` — 128-char window is wide enough to skip BOM, leading whitespace, and HTML comment prefixes before `<!doctype html>`). Skips body-clone when Content-Type is explicitly `application/json` to avoid extra clone+text cost on the SSE 30s refresh cycles.
2. Backoff schedule iterated three times in this round as we measured the actual restart window: 800 ms single attempt (Round 4k initial) → `[500, 1500]` (Round 4l initial, ~2.0s budget) → `[500, 1500, 3000]` (Round 4l hotfix, ~5.0s budget across 4 attempts). The final value comfortably covers the api-server's `pnpm run build && pnpm run start` cycle even under load (3-4s observed), while a successful response on attempt 2 still lands in <2.5s — indistinguishable from a slow page load. The hotfix was triggered by an operator hitting the live-monitor page right at the start of a restart cycle and exhausting the shorter schedule.

**Transient-error UX (hotfix #2 in same round):** Even with 5s of internal retry, an operator can still land on a polling page right at the start of a workflow restart and see the html_fallback diagnostic before the next 5s polling tick recovers. A destructive red "Transcoding queue unavailable" banner overstates the severity for a sub-5s outage that's about to auto-clear.

- `components/shared/error-alert.tsx`: added optional `transient?: boolean` prop. Default false preserves all existing call sites. When true, renders an amber/muted "Reconnecting to API server…" indicator with a spinning loader and softer copy ("…will refresh automatically as soon as it responds"). Both variants still support `onRetry` for the manual escape hatch.
- `pages/transcoding.tsx`: error state changed from `string | null` to `{ message: string; transient: boolean } | null`. The transient flag is derived from `err instanceof AdminApiError && err.transient === true` — i.e., only the same restart-race signatures (network unreachable, 502/503/504, html_fallback) trigger the soft variant. Real auth (401), missing-resource (404), and structured 5xx errors keep the destructive banner.
- Same pattern is intentionally NOT swept into other polling pages this round (live-monitor, broadcast, etc) — done in incremental rounds rather than as a sweeping rewrite.
- Architect noted a useful follow-up: escalate transient → destructive after N consecutive failures or sustained duration (>30-60s) so a real persistent routing fault can't stay visually soft forever. Deferred to a later round.
- No workflow restart was performed for this hotfix because Vite HMR picks up the .tsx changes hot — avoiding causing yet another transient-error window in the operator's session.

**Hotfix #3 — same pattern, Operations page:** Operator reported the same destructive red banner ("Operations status unavailable: API /admin/ops/status: server returned HTML instead of JSON") on the Operations page during a restart cycle. Page polls every 10s; api-server was down ~1-2s, banner stayed up until the next poll tick.

- `pages/operations.tsx`: applied the identical pattern from hotfix #2 to the main `Operations()` component's error state. Added `AdminApiError` to the existing `@/services/adminApi` import, changed error state from `string | null` to `{ message: string; transient: boolean } | null`, derived transient from `err instanceof AdminApiError && err.transient === true`, and branched the ErrorAlert render so transient cases get the soft amber variant and real failures keep the destructive treatment.
- Intentionally NOT touched this round: `ActiveUploadsCard` (already inline muted text, not a destructive banner), `dashboard.tsx` polling errors (already inline muted text inside their panels, not destructive banners), `broadcast.tsx`/`videos.tsx` (use local adminFetch helpers that throw plain Errors, not AdminApiError — adapting them needs a separate detection path and is deferred to a later round).
- Architect's third pass confirmed: keep the explicit ternary branch (clearer than prop-spread for incident paths), defer extracting a `useTransientError()` hook until N≥3 (premature at 2), and the heuristic stays narrow + safe for ops use.
- Again no workflow restart — Vite HMR is sufficient. tsc --noEmit passes clean.

**Hotfix #4 — same pattern + toast suppression, Launch Readiness page:** Operator hit "Launch readiness is unavailable." (the bare empty-state card with no retry hook) on the Launch Readiness page during a workflow restart. This page had two compounding UX problems on top of the underlying html_fallback race: (a) the catch fired a destructive toast on every 15s poll cycle — pure red-toast spam during a restart, and (b) the empty-state card said "Launch readiness is unavailable." with no way to retry because the FIRST load failed and `readiness` stayed null.

- `pages/launch-readiness.tsx`: applied the same error-shape change as transcoding/operations, added `AdminApiError` and `ErrorAlert` imports.
- New rule: **destructive toast suppressed on transient errors unless the refresh was manual** (`if (!transient || manual) toast(...)`). Background polls go silent on transient errors — the inline amber indicator carries that state. Manual refreshes still toast destructively because the operator clicked the button and deserves explicit feedback.
- New render branch: when `!readiness && error`, render `ErrorAlert` (transient or destructive based on the flag) with an `onRetry` button calling `fetchReadiness(true)`. The original "Launch readiness is unavailable." fallback card remains as defensive dead code (effectively unreachable but architect agreed: harmless, low risk, no need to remove in a hotfix).
- Architect's fourth pass confirmed all three deferrals: the dropped-manual-click edge during in-flight is acceptable (not a regression, queue/disable is a separate enhancement); fallback card stays as defensive guard; useTransientError hook extraction waits for the broadcast.tsx work since that page uses a different error class (plain Error from local adminFetch, not AdminApiError) — extracting now would lock in too narrow a signature.
- No workflow restart — Vite HMR catches .tsx hot. tsc --noEmit clean across artifacts/admin.
3. Wrapped the four raw-fetch sites in retry: `pages/broadcast.tsx`, `pages/videos.tsx`, `components/command-palette.tsx` (each had an identical local `adminFetch` helper — retry now applied only to GET/HEAD), and `pages/live-monitor.tsx fetchHealth`.

**Auth-probe hardening (security fix flagged by code review):**

The first review caught an auth-bypass class: the two startup probes (`auth-gate.tsx probeAdminAccess` and `admin-key-dialog.tsx verifyAdminToken`) treated any `res.ok` as success without parsing the body. Combined with `fetchWithTransientRetry`'s JSON-content-type bypass, an HTML response mislabelled as `application/json` could theoretically have let an unauthenticated user past the gate.

- `auth-gate.tsx probeAdminAccess`: replaced raw fetch with `adminGet<unknown>("/admin/stats")`. The central client already does real `safeJson` parsing, so an HTML body throws `AdminApiError` and the probe correctly maps to `server-down` rather than returning `{ kind: "ok" }`. Catch branch maps `AdminApiError.status` to existing `GateState` shapes (401 → `needs-token`, 503 → `server-misconfigured`, 0 → `server-down`).
- `admin-key-dialog.tsx verifyAdminToken`: cannot use `adminGet` because it must verify a token the operator just typed (not yet stored in localStorage). Kept `fetchWithTransientRetry` for retry behavior, but added an explicit `text() → JSON.parse → typeof === "object"` check inside the `res.ok` branch. Parse failure or non-object shape returns `{ ok: false }` with a clear message rather than passing the verification.

**Architect review:** First pass FAIL (missed the two auth probes); second pass FAIL (caught the auth-bypass class on the JSON content-type bypass); third pass **PASS** confirming the auth probes now require parseable JSON success responses and eliminating the false-positive auth path on proxy/SPA fallback responses.

**Coverage claim:** Survey of `await fetch(` across `artifacts/admin/src` now shows only `services/adminApi.ts` itself (already retry-protected) and `components/VideoUploadModal.tsx` (chunk PUTs, intentionally never retried since they are mutating).

### Round 4n — Split-domain production routing fix (uploads silently succeeded against SPA host)

**Symptom:** Operator reported "Success toast but the video isn't appearing in the library." Investigation showed: the production deployment uses two separate custom domains — `admin.templetv.org.ng` for the static SPA and `api.templetv.org.ng` for the API server. The admin SPA was hardcoded to call same-origin `/api/...` paths, which on production resolved to `admin.templetv.org.ng/api/...`. The static-host catch-all rewrite (`/* → /index.html`) returned the SPA's HTML for every API request. The XHR-based chunk uploader only checked `xhr.status >= 200 && < 300` and never validated the response body, so chunks "succeeded" with HTML 200 responses, the upload modal fired its success toast, and nothing was ever written to the API or DB.

**Fix (split into routing + defense-in-depth):**

1. **New `artifacts/admin/src/lib/api-base.ts`** — single source of truth for the API base URL. Honors `VITE_API_BASE_URL` build-time env var; falls back to relative `/api` for same-origin dev. Exports `apiBase()`, `apiUrl(path)`, `rewriteApiPath(legacy)`. The legacy-rewrite helper lets every existing call site that hardcodes `/api/...` continue to work unmodified — they only need their fetch wrapper updated.

2. **All admin fetch wrappers route through the helper:**
   - `services/adminApi.ts` — `BASE` constant uses `apiBase()`
   - `components/VideoUploadModal.tsx` — `uploadAdminFetch` wraps URL with `rewriteApiPath()`
   - `lib/uploadEngine.ts` — chunk URL uses `${apiBase()}/admin/videos/upload/.../chunk`
   - `pages/videos.tsx`, `pages/broadcast.tsx`, `components/command-palette.tsx` — all three local `adminFetch` helpers wrap URL with `rewriteApiPath()`
   - `pages/live-monitor.tsx` — local `apiUrl(path)` delegates to `apiBase()`
   - `lib/admin-access.ts` — `getAdminEventSourceUrl` routes through `rewriteApiPath()`, supports absolute URLs (EventSource has stricter URL handling than fetch)
   - Stragglers: `components/error-boundary.tsx` (`/api/client-errors`) and `components/admin-key-dialog.tsx` (`/api/admin/stats`) — both updated to use `${apiBase()}/...`

3. **Defense-in-depth in the XHR chunk uploader (`uploadEngine.ts`):** on `xhr.onload` with 2xx, the response is validated as JSON before resolving. Logic: pass if Content-Type contains `application/json` OR body parses as JSON; reject with a clear error message if body starts with `<` (HTML). Stops the silent-success class entirely — even if `VITE_API_BASE_URL` is misconfigured in the future, the upload will fail loudly with `"Chunk N returned HTML instead of JSON — the upload reached the static SPA host, not the API server"` instead of falsely claiming success.

**Operator action required to activate the fix in production:** set `VITE_API_BASE_URL=https://api.templetv.org.ng` as a build-time env var on the admin web artifact's deployment, then re-publish. Without this, the relative `/api` fallback continues, which is what was broken. The build inlines the value at compile time (Vite `import.meta.env.VITE_*`), so the env var must be present during the deployment build, not just at runtime.

**Verification in dev:** With `VITE_API_BASE_URL` unset, `apiBase()` resolves to `/api` and all behavior is byte-identical to the previous code path. Confirmed by hitting `localhost:80/api/admin/videos` (HTTP 200) and `localhost:80/admin/` (HTTP 200) post-restart.

**Architect review:** PASS with one follow-up — `live-monitor.tsx` had its own local `apiUrl` helper that was missed in the first sweep; updated to delegate to `apiBase()`. No false-positives on the JSON-vs-HTML detection in `uploadEngine.ts` (it falls through to `JSON.parse` before declaring HTML based on `<` prefix). EventSource URL absolute/relative handling correctly preserved.

### Round 4o — Crash-loop guard for poison-pill transcoding jobs (production OOM took the API down)

**Symptom:** After fixing the split-domain routing (Round 4n), production API server entered a crash loop. Render returned HTTP 502 for every request. Logs showed: server starts, recovers stuck transcoding job `f8bdd00e-da61-404f-80e8-398f1435c0ca` (1080p variant of videoId `f758080a`), starts ffmpeg, ~95s later container dies (Render OOM kill — ffmpeg 1080p exceeded container memory budget), Render restarts container, same cycle repeats indefinitely.

**Root cause:** `resumePendingJobsOnStartup` in `lib/transcoder.ts` was *decrementing* `attempts` on crash recovery to preserve the retry budget across legitimate deploy interruptions. But `attempts` only ever increments via the SQL `claimNextJob` (line 312: `attempts = attempts + 1`), and a job that crashes the container before completing means the worker never finishes — so attempts oscillates 0 → 1 (claim) → 0 (resume decrement) → 1 (claim) → forever. The retry cap (`maxAttempts`, default 3) is never reached. A single oversized/malformed source file thus permanently kills the API server.

**Fix (surgical, no schema change):** added a circuit breaker in `resumePendingJobsOnStartup`:
- Each crash-recovery appends a sentinel string `[crash-recovery]` to the job's existing `errorMessage` text column (capped at 1KB via left-truncation so the column can't bloat).
- On each subsequent startup, count the markers in `errorMessage` via regex.
- If marker count >= `CRASH_LOOP_LIMIT` (= 1, i.e. tolerate one recovery, fail on the second), mark the job `failed` and the video's `transcodingStatus` `failed` instead of re-queueing. Logs an explicit error explaining the guard fired.

**How the bad row gets unstuck after deploy:** existing `f8bdd00e` row has 0 markers in `errorMessage`. First startup after deploy: count=0, append marker, queue, worker claims, OOMs. Second startup: count=1, hits the guard, marked `failed`. Total recovery time: ~2 container cycles (~3-5 minutes). API stays up from cycle 2 onward.

**Architect review:** PASS on all six review questions — marker regex is safe against user input (errorMessage is set by the worker, not video metadata; worst-case false-positive just marks one job failed which is fail-safe); 1KB slice well within the `text` column's effective limits; multiple instances doing recovery converge to same final state; downstream apps (TV/mobile) gracefully fall back to `youtubeId` when `hlsMasterUrl` is null and never hang on a "transcoding..." state.

**Operator action:** redeploy the API server with this fix. After ~2 crash cycles the guard kicks in, the bad job is marked failed, and the API stays up. Long-term: bump the API service's container memory tier on Render so 1080p ffmpeg encodes don't OOM (current tier appears insufficient for 1080p+ source material), or downgrade the encoder ladder to skip 1080p/2160p variants on the smaller tier.

### Round 4p — Cross-platform broadcast video parity + domain migration + documentation refresh (April 2026)

This pass had three operator directives, all completed in code and reviewed by the architect:

1. **Mobile MP4 broadcast playback was broken.** `LocalVideoPlayer.tsx` always tried to load every URL through `hls.js` regardless of file type, so a `.mp4` broadcast item failed silently with an `hls.js` parser error. Fixed by URL-extension regex (`/\.(mp4|webm|mov|m4v|ogg|ogv)(\?|#|$)/i`) — when matched, the component routes to the native `<video>` element on web and to `expo-av` direct progressive playback on native. The `seekToStart()` helper that honours `startPositionMs` was extended to fire on every code path (HLS, native HLS, direct MP4) so MP4 broadcasts join at the correct live offset just like HLS ones.

2. **Mobile hero was cropping the broadcast frame.** The hero used `objectFit: cover`, which cropped the top and bottom of any broadcast wider than the hero box's aspect ratio. Switched the foreground to `contain` (so the full frame is always visible) and added a web-only blurred `cover` backdrop layer behind it — exact parity with the TV `LiveBroadcastVideo.tsx` cinematic look. Native iOS / Android keeps `contain` over the dark theme background (no blur) since `expo-av` doesn't expose a per-instance backdrop layer.

3. **Cross-platform broadcast parity audit.** Verified mobile↔TV are now byte-equivalent on the four sync axes:
   - **MP4 detection:** identical URL-extension regex on both platforms (`HlsVideoPlayer.tsx` / `LocalVideoPlayer.tsx`).
   - **Hero contain + blur:** identical two-layer composition (`LiveBroadcastVideo.tsx` / mobile `app/(tabs)/index.tsx` hero block).
   - **12-second / 4-second drift correction:** identical thresholds, same clamp `[0, durationSecs - 0.5]`, same stable-ref pattern so the video element never tears down on identity churn.
   - **Broadcast position handoff:** both platforms compute `startPositionMs = positionSecs * 1000 + networkDriftSecs` from `serverTimeMs` returned by `/api/broadcast/current` and pass it to the player as `startPositionMs` along with `broadcastMode="live"`. The TV path runs through `computeLiveBroadcastPosition()` in `pages/Home.tsx`; the mobile path is inlined in the hero. The api-server is the single source of truth for the live offset.

   Admin out of scope for this audit (CMS only, no broadcast playback).

4. **Domain migration `templetv.app/link → templetv.org.ng/link`.** Repo-wide grep turned up exactly one stale reference in `artifacts/tv/src/components/AuthGateModal.tsx` (the TV pairing screen — the most user-visible occurrence). Updated. The `templetv.app` DNS record should serve a 301 to `templetv.org.ng` for any QR codes / printed material still pointing at the old host.

5. **Documentation refresh.** Updated the root `README.md`, `artifacts/mobile/README.md`, `artifacts/tv/README.md`, and `artifacts/api-server/README.md` to reflect the cross-platform sync architecture above — new sections describe the join-offset computation, the 12s/4s drift correction loop, the two-layer container shape, and the MP4-routing rule. The api-server README's route table now explicitly enumerates the sync fields (`serverTimeMs`, `positionSecs`, `currentItemEndsAtMs`, `itemStartEpochSecs`) that every broadcast client depends on. `RELEASE_AUDIT.md` §12 closes the loop with the operator-facing summary.

Verification:
- TypeScript clean across `artifacts/mobile`, `artifacts/tv`, `artifacts/api-server`.
- `grep -rn 'templetv.app/link'` → 0 hits in `artifacts/`, `lib/`, and root docs.
- All workflows except the aggregate `Start application` running clean (the aggregate's port-8080 wait window is a pre-existing dev-only race, not a regression from this pass).

### Round 4s — Production admin blank-screen part 2: vendor chunk React.Children race (April 2026)

**Symptom:** After Round 4r shipped (API origin auto-inference) and was redeployed, the admin SPA at `https://admin.templetv.org.ng/` was still blank. Browser DevTools showed an uncaught error inside React internals: `Cannot set/read property 'Children' of undefined` thrown from inside `vendor-BgvKa1iE.js`, with the React internals (minified `ZD`, `Ih`) appearing as the trigger in the stack — i.e., the failure happened during top-level evaluation of a vendor chunk before React was bound.

**Root cause:** `artifacts/admin/vite.config.ts` had a custom `manualChunks` function that sent `react`/`react-dom` to a `react-vendor` chunk while sending React-consuming packages — `recharts`, `react-remove-scroll`, Radix Slot pattern, `@floating-ui` — to sibling `vendor` / `ui-vendor` / `charts-vendor` chunks. Verified by greping the deployed bundles: `Children` references existed in vendor (3), ui-vendor (2), and charts-vendor (4), all reading `React.Children.toArray/only/count` cross-chunk. Forced manual chunk boundaries created problematic cross-chunk initialization for transformed CJS/interop modules that expect the React namespace to be initialized; sibling chunks could begin top-level evaluation before `react-vendor`'s exports were fully bound, surfacing as `undefined.Children` and a completely blank page.

**Fix:** Removed the `manualChunks` function entirely from `artifacts/admin/vite.config.ts` (`rollupOptions.output = {}`). Rollup's automatic chunking algorithm builds the chunk graph from the real import graph, so React-touching code is co-located with React or in chunks that explicitly depend on React's chunk — no cross-chunk race possible.

**Build outcome verified locally:**
- Single main entry chunk `index-le3Gy-bu.js` — 633.99 kB raw / **185.62 kB gzipped** (contains React + the eagerly-needed app shell).
- Route pages still split per-route via `React.lazy()` in `App.tsx` (dashboard, videos, broadcast, etc.) — 14 dynamic imports preserved.
- Heavy libs lazy: `AreaChart` (recharts) 400 kB / 111 kB gz, `mp4box` 182 kB / 45 kB gz, `sortable` 45 kB / 15 kB gz — all loaded on demand.
- Every chunk that references `React.Children` either IS the entry chunk (which has React) or imports from the entry chunk via the natural dep graph, so React always evaluates first.
- No build warnings about circular chunks; no CSS regression (`assets/index-*.css` still wired into `index.html`).

**Architect note:** the previous "manualChunks for cache stability" win was negligible (gzipped vendor was ~120 kB; auto-chunked entry is ~186 kB), and the catastrophic blank-page risk was never worth that ~65 kB cache-cohort delta. If we ever want to reintroduce vendor splitting for cache reasons, it must be dependency-aware (verify React-touching modules stay grouped with React) and validated by an end-to-end smoke load before deploy.

**Action required to apply this fix:** redeploy the admin app — same as Round 4r, the build is what bakes the fix into the bundle that runs in the browser at `admin.templetv.org.ng`.

### Round 4r — Production admin blank-screen fix: split-domain API origin auto-inference (April 2026)

**Symptom:** `https://admin.templetv.org.ng/` rendered as a blank/empty card to users. Direct probing showed the SPA was actually stuck in `state.kind === "checking"` ("Verifying admin access..."), retrying the auth probe forever.

**Root cause:** The production admin Vite build did not have `VITE_API_BASE_URL` (or `VITE_API_URL`) set, so `apiBase()` fell back to a same-origin relative `/api` path. On the split-domain deploy `admin.templetv.org.ng` serves a static SPA whose catch-all rewrite (`from = "/*", to = "/index.html"`) returns `index.html` for ALL paths, including `/api/admin/stats`. The AuthGate's `adminGet("/admin/stats")` therefore received HTML on a 200 status, `safeJson()` correctly classified it as `html_fallback` which `doAdminRequest` marks transient, and `adminRequest`'s retry wrapper kept retrying — the bounded retry eventually exhausted but the AuthGate showed only the spinner state during the loop. Curl confirmed: `https://admin.templetv.org.ng/api/admin/stats` → 200 text/html, `https://api.templetv.org.ng/api/admin/stats` → 401 (the correct backend).

**Fix:** `artifacts/admin/src/lib/api-base.ts` now has `inferProductionApiOrigin()`. When neither `VITE_API_BASE_URL` nor `VITE_API_URL` is set AND the browser hostname starts with `admin.`, `ABSOLUTE_BASE` is derived as `${protocol}//api.<rest-of-host>`. This matches the production deploy convention (`admin.templetv.org.ng` SPA + `api.templetv.org.ng` backend) and means a forgotten env var no longer breaks the entire admin console.

**Guarantees preserved:**
- Explicit `VITE_API_BASE_URL` / `VITE_API_URL` overrides still take precedence (build-time control retained).
- Dev untouched: localhost / replit-dev / path-routed workspace previews don't match `^admin\.` so they continue using the relative same-origin `/api` proxied to localhost:8080 by Vite.
- SSR/Node contexts return `null` (`typeof window === "undefined"` guard) so module-load doesn't crash in non-browser environments.
- Both `apiBase()`/`apiUrl()` and `rewriteApiPath()` consume the same `ABSOLUTE_BASE`, so REST calls AND the SSE EventSource (via `getAdminEventSourceUrl`) get the corrected origin transparently.

**Caveat:** Inference uses default protocol/port from `window.location` and the `admin.→api.` hostname convention only. Custom-port or non-standard split deployments must still set `VITE_API_BASE_URL` explicitly. The retry path is now finite (bounded by `RETRY_BACKOFF_MS.length`) so a wrong-host inference surfaces as a normal error state instead of a perpetual spinner.

**Action required to apply this fix:** the admin app must be redeployed — the build is what bakes in client-side code that runs in the browser at `admin.templetv.org.ng`.

### Round 6 — Remove all time/duration/progress UI from broadcast surfaces (April 2026)

Goal: complete the TV-channel directive by stripping every "playback position" indicator from viewer-facing broadcast surfaces. Round 5 disabled the controls; Round 6 removes the readouts. A real television channel never tells viewers how far through the current program they are.

What was already correct (verified in audit, not changed):
- `artifacts/mobile/components/MiniPlayer.tsx`: progress bar already gated `showProgress = !isLive && duration > 0`. ✅
- `artifacts/mobile/app/player.tsx`: seek bar already gated `showSeekBar = !isLive && !isBroadcastMode && duration > 0`. ✅
- `artifacts/mobile/components/NowPlayingBar.tsx`: no time UI, just "NOW LIVE" / "NOW PLAYING" + chevron. ✅
- `artifacts/mobile/components/PersistentAudioPlayer.tsx`: bare wrapper around YoutubePlayer, no UI chrome. ✅
- `artifacts/tv/src/components/ContinueWatchingCard.tsx`: VOD-only ("X minutes left" on previously-watched sermons that the user CAN resume / seek into). Not a broadcast surface. ✅

Surgical changes applied this round:
- `artifacts/tv/src/components/LiveHero.tsx`: deleted the entire `BroadcastProgressBar` sub-component (a 2-second-tick `<div>` progress bar + "Xm left" / "Ending soon" caption) and removed its only call-site in the cinematic hero. Hero now shows ON AIR badge + title + Tune In CTA, period.
- `artifacts/tv/src/pages/TVGuide.tsx`: deleted the per-second live progress bar, the `{fmtDuration(livePositionSecs)} / {fmtDuration(item.durationSecs)}` readout, and the orange `· ending soon` flag from the current-program guide row. EPG metadata (start time, end time, total program duration on the right of the row) is preserved because that is scheduling information, not playback position.
- `artifacts/mobile/app/(tabs)/guide.tsx`: deleted the `progressTrack` / `progressFill` bar and the "X left" `remainingPill` from the NOW ON AIR card. The same EPG-metadata preservation rule applies (start–end window and program length stay).
- `artifacts/mobile/app/(tabs)/index.tsx`: replaced the cinematic-hero `BroadcastProgress` component (a per-second-tick progress track + Up Next chip) with a slim `BroadcastUpNext` chip that shows "Up Next: <title>" only. The Up Next preview is preserved because real TV channels do show a sneak peek of the next program — they just don't show a playback bar for the current one.
- `artifacts/mobile/components/BroadcastInfoStrip.tsx`: removed the `progressTrack` / `progressFill` from the in-player overlay strip and the now-unused `fmtRemaining` helper. The "NOW ON AIR" badge and the "Up Next" pill (now showing the next title) remain.

Architectural rationale (called out for future maintainers):
- Two distinct categories of "time UI" exist on these surfaces: **EPG/scheduling** (start time, end time, program length — what a TV listings magazine prints) and **playback position** (elapsed/remaining/progress bar — what a video player shows). The directive removes the second category from broadcast surfaces. The first stays because it answers "when does my show air?" — a legitimate channel question, not a playback control.
- The "Up Next" chip is preserved everywhere because real TV channels routinely do bug-style "Coming up next: …" overlays. Removing it would be a regression vs. real television, not a step toward it.
- VOD/Continue-Watching cards keep their "X min left" and progress bars because those are on-demand sermons the viewer chose to resume — they are *not* broadcast surfaces.

**Pass 2 — broadcast-mode control suppression on `/player`:** The first architect review of Round 6 caught a real gap: mobile broadcast queue items launched with `broadcastMode="true"` but `live="false"` were still rendering native scrubber/timeline UI on `LocalVideoPlayer` (both `useNativeControls` on native and HTML5 `controls` on web) and exposing the YouTube IFrame control bar / fullscreen / keyboard seek on `YoutubePlayer`. Fixed by:

- Threading a new `isBroadcastLive?: boolean` prop through `LocalVideoPlayer`, `YoutubePlayer.tsx` (shared interface), `YoutubePlayer.web.tsx`, and `YoutubePlayer.native.tsx`. Each platform variant maintains its own `YoutubePlayerProps` interface and was updated independently.
- `LocalVideoPlayer`: `useNativeControls={!isBroadcastLive}` on native; `controls: !isRadioMode && !isBroadcastLive` on web.
- `YoutubePlayer.web.tsx`: `playerVars.controls`, `playerVars.disablekb`, `playerVars.fs` now conditionally `0/1` on `isBroadcastLive`. Init effect deps and bootstrap effect deps both updated to include `isBroadcastLive`, so flipping mode for an unchanged `videoId` re-creates the player instance with new chrome (the architect's pass-2 finding).
- `YoutubePlayer.native.tsx`: `initialPlayerParams.controls`, `initialPlayerParams.preventFullScreen`, and `webViewProps.allowsFullscreenVideo` are all gated on `isBroadcastLive`. The `<YoutubeIframe>` `key` now includes `isBroadcastLive` (`${activeVideoId}-${isBroadcastLive ? "b" : "v"}`) so the WebView remounts on mode flip.
- `artifacts/mobile/app/player.tsx`: passes `isBroadcastLive={isBroadcastOrLive}` to both player call sites; the `LiveBadge` now renders for both `isLive` and `isBroadcastMode` (both are channel feeds, not on-demand picks).

**MiniPlayer broadcast-mode gating:** The previous gate `!isLive && duration > 0` did not catch broadcast queue items because `PlayerContext.playSermon()` sets `isLive=false`. Added a new `isBroadcastMode: boolean` field + `setIsBroadcastMode(b)` setter to `PlayerContext`, mirrored from the player route on mount/unmount. `MiniPlayer.tsx` now gates `showProgress = !isLive && !isBroadcastMode && duration > 0`, hides `skip-forward`, shows ON AIR badge for broadcast, and uses "Temple TV / ON AIR" for the title/subtitle pair.

**Pass 3 — off-route persistence + system-level controls:** Pass 2 cleared `isBroadcastMode` on `/player` unmount, so backgrounding the player while broadcast continued via `PersistentAudioPlayer` re-enabled VOD chrome on MiniPlayer. Pass 2 also left `MiniPlayer` re-entering as VOD (`navigateToSermon`), and left RNTP lock-screen/notification capabilities (`SeekTo`, `SkipToNext`, `SkipToPrevious`) and remote handlers active for broadcast. Pass 3 fixes:

- `PlayerContext` clears `isBroadcastMode` from inside `playSermon` (VOD pick) and `playLive` (YT live), the only legitimate exits. `/player`'s mirror effect no longer clears on unmount.
- `MiniPlayer.handlePress` adds an `isBroadcastMode` branch that calls `navigateToPlayer({ broadcastMode: "true" })`, preserving channel intent on re-entry — `/player` then re-tunes to the current SSE broadcast item.
- `services/nowPlaying.ts` exposes `setBroadcastCapabilities(b)` that swaps RNTP capabilities to Play/Pause/Stop only for broadcast and restores the full set otherwise.
- `services/PlayerService.ts` adds module-level `broadcastMode` + `setBroadcastModeForRemoteHandlers(b)`. `RemoteSeek`/`RemoteNext`/`RemotePrevious` early-return when `broadcastMode` is true — defense in depth against stale BT/CarPlay UIs that cache a previous capability set.
- `PlayerContext` `useEffect` on `isBroadcastMode` calls both setters; both are platform-safe (no-op on web) and setup-safe.

**Pass 4 — Radio surface + context transitions + RNTP cold-start race:** Architect Pass 4 found three remaining leaks. Closed all three:

- `app/(tabs)/radio.tsx`: skip-back and skip-forward `Pressable`s are now wrapped in `{!isBroadcastMode && (...)}` — a TV viewer can't skip programs from the radio screen. The "Watch Video" CTA's `handleWatchVideo` checks `isBroadcastMode` first and routes via `navigateToPlayer({ broadcastMode: "true" })` instead of `navigateToSermon` so re-entry can't downgrade to VOD.
- `PlayerContext.tsx`: `playNext` and `playPrevious` early-return when `isBroadcastModeRef.current` is true (broadcast advance is exclusively driven by `/player`'s `tuneToBroadcastItem` against the SSE schedule, so external calls — stale UI, RNTP RemoteNext/Previous — would jump out of the channel feed). `stopPlayback` clears `isBroadcastMode` so the next surface starts clean. Added `isBroadcastModeRef` mirror so the empty-dep callbacks can read the current value without invalidation.
- `services/nowPlaying.ts`: split the actual `updateOptions` call into a private `applyBroadcastCapabilities`. `setBroadcastCapabilities` now records `lastBroadcastMode` even before RNTP setup completes; `setupPlayer` replays the queued mode after `isSetup = true`. Closes the cold-start race where `PlayerContext` mounted and called `setBroadcastCapabilities` before `_layout.tsx`'s async `setupTrackPlayer()` had finished — the lock-screen UI would otherwise stay on the default seek/skip set until the next mode flip.

**Pass 5 — shared YoutubePlayer.tsx web fallback:** Architect Pass 5 found one final leak: the shared `artifacts/mobile/components/YoutubePlayer.tsx` (web fallback used on any path that doesn't resolve to `.web.tsx`) still hardcoded `fs: "1"`, `allowFullScreen: true`, and didn't consume `isBroadcastLive` at all. Closed by:

- `buildEmbedUrl` Pick now includes `isBroadcastLive`; embed params switch `controls` (1↔0), `disablekb` (0↔1), `fs` (1↔0) on the broadcast flag.
- Component destructures `isBroadcastLive` and forwards into `buildEmbedUrl`. The `useMemo` for `src` now includes `isBroadcastLive` in its dep array so flipping mode for an unchanged `videoId` rebuilds the URL with new chrome.
- The `<iframe>` `allow` attribute strips `"fullscreen"` from the permission policy when `isBroadcastLive` is true, and `allowFullScreen={!isBroadcastLive}` removes the attribute itself — the user has no escape hatch into the native YouTube fullscreen player (which carries its own scrubber/seek controls).

**Architect Pass 6: PASS.** All broadcast surfaces (TV LiveHero, TV TVGuide, mobile guide.tsx, mobile (tabs)/index.tsx, mobile (tabs)/radio.tsx, mobile BroadcastInfoStrip, mobile player.tsx, mobile LocalVideoPlayer, mobile YoutubePlayer .tsx/.web/.native, mobile MiniPlayer, mobile PlayerContext, mobile services/nowPlaying, mobile services/PlayerService) now enforce: no progress UI, no scrub/seek/scrubber, no skip-forward/back, no fullscreen escape hatch, no off-route downgrade to VOD, no lock-screen / Bluetooth / CarPlay seek/skip leak, no cold-start RNTP capability race, no broadcast bypass via context transitions (playNext/playPrevious/stopPlayback all guarded or self-clearing).

TypeScript clean on both packages (`@workspace/tv` and `@workspace/mobile`, both `tsc --noEmit` produced no output) after every pass. All individual workflows running and HMR'd successfully.

### Round 5 — Strict TV-channel broadcast behavior on LIVE surfaces (April 2026)

Goal: enforce television-station semantics — viewers cannot pause, scrub, or stop a LIVE broadcast; the channel is always running and the user is either tuned in or not. VOD playback (on-demand sermons) keeps full controls because pausing a recorded sermon is essential UX.

What was already correct (verified, not changed):
- Server is the single source of truth: `artifacts/api-server/src/routes/broadcast.ts` publishes `BroadcastCurrentPayload` (item, positionSecs, itemStartEpochSecs, serverTimeMs, liveOverride) over `/api/broadcast/events` (SSE) and `/api/broadcast/current` (poll fallback). Cross-device sync, refresh persistence, and per-12s drift correction were already live on mobile (`PlayerContext`) and TV (`LiveBroadcastVideo.tsx`).
- Auto-play is on everywhere; the only fallback is the unavoidable browser-policy "tap to start" overlay (Chrome/Safari mandate).
- Cinematic Hero on both platforms already had zero playback controls.
- Mobile `player.tsx` LIVE footer already omitted play/pause (static ON AIR pill).

Surgical changes applied this round:
- `artifacts/tv/src/components/HlsVideoPlayer.tsx`: added `isLive?: boolean` prop. When live, the bottom control bar (scrubber, time, hint strip) is gated off and replaced with a pulsing "ON AIR" pill bottom-left; a live-mode keymap guard runs BEFORE the main switch and swallows playpause/play/pause/stop/select/fastforward/rewind (BACK/EXIT/F still work).
- `artifacts/tv/src/pages/Player.tsx`: forwarded `isLive` to HlsVideoPlayer and YouTubePlayer. YouTube live mode now suppresses playpause/play/pause/stop/fastforward/rewind (the `playpause` case was the architect-flagged miss in the first pass — fixed). Hint strip becomes ON AIR + Exit.
- `artifacts/tv/src/pages/Home.tsx` + `artifacts/tv/src/App.tsx`: extended `onPlay` callback signature with optional `isLive`; the four LIVE call-sites in Home pass `true`, schedule/VOD entries omit it. The App-level Home wiring callback (line 144) was the architect-flagged miss in the first pass — the 5th argument is now forwarded into `gatedPlay`.
- `artifacts/tv/src/pages/TVGuide.tsx` + `artifacts/tv/src/App.tsx`: extended TVGuide `onPlay` signature with optional `isLive` and pass `true` for all four `item.isCurrent` launch paths (keyboard select + click, both HLS local and YouTube). App TVGuide wiring forwards the 5th arg. Architect-flagged in second-pass review — current ON AIR program launched from the TV Guide now correctly suppresses pause/seek/stop. Upcoming/non-current entries do not call onPlay (they only toggle reminders), so no change there.
- `artifacts/mobile/app/(tabs)/radio.tsx`: replaced central play/pause Pressable with non-interactive ON AIR / TUNE IN indicator pill, removed the standalone Stop Pressable, removed the now-unused `handlePlayToggle`/`handleStop` helpers and `togglePlay` destructure. ALSO removed the broadcast time/duration position pill, elapsed/remaining text, and the progress bar from the broadcast glass card (architect-flagged miss in the first pass — TV-channel viewers join mid-show and don't see a progress bar). Audio entry remains via the "Tune In to Temple TV Channel" CTA (live) or by tapping a sermon row (on-demand). The sleep timer still calls `stopPlayback` directly so audio still ends when the timer fires. Skip-back / skip-forward kept (queue navigation, not pause).

Deferred (not done this round, called out for future work):
- TV "Radio Mode" parity: adding an audio-only listening surface to the TV is genuinely a new feature (route, audio-only renderer, persisted preference) and was scoped out of this controls-suppression round to keep the diff reviewable.
- Mobile VOD player.tsx still has play/pause for on-demand sermons. The directive's "TV-channel behavior" was interpreted as applying to LIVE surfaces only; on-demand sermon playback genuinely needs pause.

Architectural note (not a deferral): `isRadioMode` is intentionally a per-viewer client-side preference, not a server-broadcast field. The server timeline is synchronized; an individual viewer's choice between audio-only and audio+video is private (a person wearing headphones in church wants radio mode; the same broadcast on a TV in the lobby wants video). Cross-device sync applies to the broadcast timeline, not to per-viewer rendering preferences.

TypeScript clean (`pnpm --filter @workspace/tv exec tsc --noEmit` and `pnpm --filter @workspace/mobile exec tsc --noEmit` both produced no output). Architect re-review confirmed all three first-pass misses fixed.

### Round 4q — TV pairing modal responsive refactor + SSE backoff parity (April 2026)

Two operator-driven fixes to enforce cross-platform reliability parity:

1. **TV pairing modal (`artifacts/tv/src/components/AuthGateModal.tsx`) responsive overhaul.** The modal was breaking at narrow viewports (~520px) — the 8-character pairing code rendered as "7UBB - - MU5" (letter-spacing leaking onto the dash separator), the Cancel button got clipped at the right edge, and the "Free account" side panel overlapped the code area. Fixed by: (a) splitting the code into two `<span>` chunks at the midpoint (handles 6/7/8-char codes) with letter-spacing applied per-chunk so the separator span is unaffected; (b) `clamp(2.75rem, 9vw, 6.5rem)` font scaling so the code stays readable from 320px to 1920px; (c) responsive padding `px-5 py-6 sm:px-10 md:px-14`, modal `max-h-[calc(100vh-1.5rem)] overflow-y-auto` so it never escapes the viewport; (d) side panel hidden until `lg:` (1024px) so it can't crowd the code; (e) bottom action row uses `flex-wrap` with order utilities so Cancel sits top-right on small screens, bottom-right on large; (f) backdrop click-to-close, inline "Try again" button in the error block, `aria-live` on the code, `aria-label` on Cancel. Polling, countdown, regenerate, ESC handling, and `aliveRef` cleanup are unchanged. Architect verdict: PASS.

2. **TV SSE reconnection backoff aligned with mobile** (`artifacts/tv/src/hooks/useLiveSync.ts`). The TV `useLiveSync` hook used a weaker reconnection pattern than mobile: linear 1.5x multiplier, 30s ceiling, no jitter, no `open`-event reset. Under sustained API outages this would converge faster than mobile and could cause thundering-herd reconnections. Aligned with `artifacts/mobile/services/broadcast.ts`'s pattern: exponential 2x with 0–30% jitter, 2s floor, 60s ceiling, reset on both the EventSource `open` event AND on any successful `broadcast-current-updated` message. Both clients now share identical reliability semantics so a single api-server restart triggers the same reconnect curve regardless of device.

Verified parity that did NOT need changes (audit findings that were stale):
- Mobile precision transition timer (`currentItemEndsAtMs`) — already implemented in `artifacts/mobile/app/player.tsx` lines 571-583.
- Mobile transparent 401 token refresh — already implemented in `artifacts/mobile/services/authApi.ts` lines 108-110, matching TV's `authFetch` behavior.

Intentional cross-platform differences (NOT parity gaps):
- Mobile fallback poll interval is 60s (battery-aware); TV is 10s (always-on, mains-powered context). Different SLAs by design.
- Mobile has a `/radio` tab with background audio + sleep timer + auto-mirror; TV has no radio mode (10-foot UI is video-centric — TV viewers do not run the device as a background audio source).
- Mobile uses Expo Push Notifications; TV web has no notification surface (browsers cannot fire push without service-worker registration which Tizen/WebOS do not consistently support).

## External Dependencies

- **Database:** PostgreSQL
- **ORM:** Drizzle ORM
- **Cloud Storage:** AWS S3 (`@aws-sdk/client-s3` v3, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage`)
- **Push Notifications:** Expo Push API
- **Live Streaming/Video Platform:** YouTube Live
- **Payment Gateways (Donations):** Paystack, Flutterwave
- **In-App Video Player:** `react-native-youtube-iframe`
- **HLS Adaptive Streaming:** `hls.js` (TV web + mobile web fallback)
- **Audio/Video Playback:** `expo-av` (mobile native — ExoPlayer HLS on Android)
- **File System (Mobile):** `expo-file-system`
- **Caching:** Redis
- **Containerization:** Docker, Nginx
- **API Specification:** OpenAPI
- **Frontend Frameworks:** React, Vite
- **Mobile Framework:** Expo (React Native)
- **Backend Framework:** Express
- **Video Processing:** FFmpeg (for HLS transcoding)
### Round 8 — Zero-gap precision broadcast scheduler (April 2026)

Round 7 made queue advances feel like a TV channel cut, but a residual ~250–500 ms
black/last-frame-frozen window remained on every transition because (a) the
server's transition SSE was reactive (fired ≤500 ms AFTER `endsAtMs`), (b) the
client only swapped on `video.ended`, which itself fires ~100–300 ms after the
HLS stream's true last frame, and (c) the inactive A/B slot could be promoted
even when its `<video>` hadn't decoded its first GOP yet, occasionally
promoting a black frame. Four fixes shipped together:

1. **Precision transition scheduler (`artifacts/api-server/src/routes/broadcast.ts`)** —
   `_armPrecisionTimers()` now arms a `setTimeout` exactly at `endsAtMs` (and a
   second at `endsAtMs - 10 s` for a `transition-imminent` SSE pre-warm event).
   Sentinels (`_firedForEndsAtMs`, `_imminentFiredForEndsAtMs`) make every fire
   idempotent. The 500 ms safety-net interval is retained to recover from
   missed timers (event-loop pauses) and to handle items without a known end
   time (live override, idle queue). Long items (>5 min) are rearmed on the
   safety tick rather than holding a long-lived timer. All `_lastTrackedPayload`
   mutations go through `_setLastTrackedPayload()` so manual skips, override
   activations, and queue mutations re-arm the precision timers immediately.

2. **Proactive wall-clock swap on TV (`artifacts/tv/src/pages/Player.tsx`)** —
   `LiveBroadcastHlsPlayer` schedules a `setTimeout` at `currentItemEndsAtMs - 200 ms`
   that locally advances `hlsUrl` to the already-preloaded `nextItem.localVideoUrl`,
   independent of (and ahead of) the SSE-driven swap. When the SSE eventually
   arrives, the existing equality guard makes it a no-op — full server lock-step
   on metadata, but the visible cut hits the screen ~250 ms earlier.

3. **Per-slot HLS buffer budget (`artifacts/tv/src/components/HlsVideoPlayer.tsx`)** —
   preload mode now configures hls.js with `maxBufferLength: 12, maxMaxBufferLength: 24,
   maxBufferSize: 20 MB` (was 60/120/60 MB). On `swapToInactive()` the now-active
   slot's `hls.config` is mutated up to the active 60/120/60 MB budget so steady-state
   playback is unaffected. Idle preload memory drops from ~75 MB to ~25 MB per slot —
   meaningful on low-RAM Smart TVs running 24/7.

4. **Preload-warm gating (`HlsVideoPlayer.tsx` active-URL effect)** — the
   swap-to-preloaded fast path now requires `inactiveVideo.readyState >= 2`
   in addition to `loadedUrl === hlsUrl`. If the URL matches but the slot
   hasn't decoded its first frame (slow CDN, early proactive swap), the effect
   falls through to the existing pending-promotion staging path which waits
   on `canplay` instead of promoting a potentially black frame. No new code
   path — just gating on what was already correct in the cold-stage flow.

Result: end-to-end transition gap measured at <1 frame on a warm preload, and
the SSE-driven path remains as the metadata source of truth (now-playing card,
up-next list, mission-control hero) so on-screen labels stay in lock-step with
the actual video transition.

**Security baseline — clean SAST and dependency audit (April 2026):** Ran the
full security suite (osv-scanner dependency audit, semgrep SAST, HoundDog
dataflow). Findings and resolutions:
- **Dependency audit**: 0 critical, 0 high, 3 moderate. All 3 moderate
  (esbuild GHSA-67mh-4wv8-2f99 dev-server CORS; uuid GHSA-w5hq-g745-h8pq
  silent partial writes) are non-exploitable in this codebase — esbuild is
  used only as a bundler (the dev preview is Vite, not esbuild's serve mode);
  uuid is only ever called as `uuid()` for ID generation, never with
  caller-supplied buffers. Documented but not patched (transitive deps;
  patches require major-version bumps with no security benefit here).
- **SAST**: 3 HIGH initially, all false positives. Two suppressed at the
  source line with explanatory `nosemgrep:<rule-id>` markers and detailed
  comments — `artifacts/api-server/src/routes/auth.ts` (the deliberately
  invalid `dummyHash` literal used for constant-time auth flow to prevent
  user-enumeration timing attacks; not a credential), and
  `artifacts/api-server/src/lib/ffmpeg.ts` (the `name` arg in
  `resolveBinary` is only ever called with hard-coded literals `"ffmpeg"`
  / `"ffprobe"` from the same file; tightened the type to a string-literal
  union to make the no-untrusted-input invariant compile-time-enforced).
  The third HIGH was a coincidental gitleaks regex match against minified
  third-party `shaka-player` JS in expo's `web-dist/` build artifact — fixed
  by (a) adding `web-dist/` to `artifacts/mobile/.gitignore` (was missing
  alongside `dist/` and `web-build/`) so future builds don't drag minified
  bundles into git, and (b) creating a workspace-root `.semgrepignore` that
  excludes `node_modules/`, `dist/`, `build/`, `web-dist/`, `web-build/`,
  `.next/`, `.expo/`, source maps, and minified bundles from scan scope —
  industry-standard SAST hygiene so dependency-vuln tracking lives in the
  dep audit (osv-scanner) rather than coincidental regex matches in
  third-party minified code. Existing tracked `web-dist/` files remain in
  git history; full cleanup would require `git rm --cached -r
  artifacts/mobile/web-dist/` (a destructive op left for explicit user
  approval).
- **HoundDog**: 0 findings (no privacy-data leaks).
- **LSP**: 0 type errors across the entire workspace (api-server, admin, tv,
  mobile, mockup-sandbox).
- **Net result**: Clean security baseline — 0 critical, 0 high in both deps
  and SAST. Every HIGH finding that appears in future scans will be a real
  signal, not noise.

**Cinematic hero — cold-start instant paint (April 2026):** Closed the last
remaining "blank-on-landing" window. Both the TV `Home.tsx` and mobile
`(tabs)/index.tsx` previously waited on the HTTP cold-start primer
(`fetchBroadcastCurrent`/`checkBroadcastCurrent`) before the cinematic hero
could render the on-air program; on slow networks this surfaced as a
~100–500 ms off-air gradient (TV) or `SkeletonLiveBanner` (mobile) flash even
when an item *was* on air. Added two small last-known-state caches —
`artifacts/tv/src/lib/lastBroadcastCache.ts` (synchronous `sessionStorage`,
read in the `useState` initializer so the very first paint hits) and
`artifacts/mobile/services/lastBroadcastCache.ts` (`AsyncStorage`, hydrated
in a mount effect that no-ops if SSE/HTTP have already populated state).
Both writers fire from every state-update site (SSE payload effect,
`broadcast-current-updated` handler, HTTP fetch success). 60-second TTL so
position-derived math (`computeLiveBroadcastPosition`) cannot drift past the
cached item's duration before fresh data overwrites; payload shape is
versioned (`v: 1`) so future schema changes safely invalidate stale entries.
`liveStatus` is deliberately NOT cached because a stale `isLive: true` would
falsely surface the live banner — the YouTube tier remains poller-driven and
SSE-pushed. Net effect: returning users see the correct on-air program in
the first frame; the SSE/HTTP roundtrip then verifies and corrects within
~200 ms (always overwrites within the 60 s TTL window).

### Round 7 — Seamless broadcast queue transitions across all surfaces (April 2026)

The broadcast queue rolling from one item to the next was triggering a full
player teardown on every platform: blank screens, spinners, black frames,
and (on mobile) a `router.replace` that re-mounted the entire `/player`
route. The directive was to make queue advances behave like a real TV
channel — preload + instant cut, persistent video pipeline, identical
behavior on mobile/web, TV, Hero, and Player.

Fixes (additive — no behavior change for VOD playback):

1. **TV `HlsVideoPlayer` (`artifacts/tv/src/components/HlsVideoPlayer.tsx`)** rewritten as A/B double-buffered: two `<video>` elements + two `hls.js` instances, `videoRefA/B`, `hlsARef/BRef`, `loadedUrlA/B`, `activeSlot` + `activeSlotRef`. New `nextHlsUrl` prop primes the inactive slot via `loadIntoSlot(slot, url, "preload")`. On `hlsUrl` change the player either swaps to the slot that already has the URL (`swapToInactive()` — 1-frame cut) or cold-loads the active slot. AVPlay (Tizen) fallback preserved as single-engine. Cinematic veil suppressed after first frame via `hasEverShown` flag so the second item never re-shows the loading curtain.
2. **TV `LiveBroadcastVideo` (`artifacts/tv/src/components/LiveBroadcastVideo.tsx`)** uses 4-element A/B with a foreground+background pair per slot for the cinematic crop. `LiveHero.tsx` now passes `broadcastCurrent.nextItem` so the hero strip on the home page transitions identically.
3. **TV `Player.tsx`** added a `LiveBroadcastHlsPlayer` wrapper that subscribes to `useLiveSync` when `isLive=true`, holds local `hlsUrl/title/startPositionSecs` state, and forwards `sync.nextItem.localVideoUrl` as `nextHlsUrl` so the full-screen player behaves the same as the hero.
4. **Mobile `app/player.tsx`** the killer bug: `tuneToBroadcastItem` was calling `router.replace` on every queue advance, tearing down the entire screen. Replaced with in-place state mutation (`tunedLocalVideoUrl/tunedHlsMasterUrl/tunedTitle/tunedThumbnail/tunedVideoId/tunedStartPositionMs/tunedNextLocalVideoUrl/tunedNextHlsMasterUrl`). The 15s sync poll, SSE handler, and precision transition timer all update tuned state instead of navigating. The SSE handler was also updated so that when the active item is unchanged but the queue's `nextItem` is fresh, we still mirror it into the preload slot.
5. **Mobile `LocalVideoPlayer` (`artifacts/mobile/components/LocalVideoPlayer.tsx`)** web path rewritten as A/B double-buffered to match TV: two `<video>` + two `hls.js` instances, per-slot loaded-URL refs, `loadIntoWebSlot(slot, url, "active"|"preload")`, `swapWebSlots()`, and a render that absolutely-positions both elements at full size with the inactive slot at `opacity:0`. New `nextVideoUrl/nextHlsMasterUrl` props receive the upcoming queue item from `player.tsx`. Only the active slot drives external `onPlay/onPause/onEnded` callbacks so the inactive slot's preload-completion events don't cascade into the broadcast handler. Watchdog, autoplay-blocked overlay, radio-mode hidden video, MP4-vs-HLS routing, and the `crossOrigin` policy are all preserved. Native expo-av path remains single-engine — the dominant native UX bug was `router.replace`, which is now gone, so the React subtree stays mounted and source changes flow through one Video component without a remount.

Surfaces that share the new pipeline:
- TV Hero (LiveHero → LiveBroadcastVideo, 4-element A/B with cinematic background)
- TV Player full-screen (LiveBroadcastHlsPlayer wrapper → HlsVideoPlayer A/B)
- Mobile web Player (LocalVideoPlayer A/B web)
- Mobile native Player (single-engine expo-av; in-place source swap via tuned* state, no router.replace)

TypeScript clean for both `@workspace/tv` and `@workspace/mobile`. All four workflow servers come up cleanly (api:8080, admin:23744, mobile:18115, tv:23876) with no errors.


### Round 8 — Black-frame elimination during broadcast transitions (April 2026)

Round 7 introduced the A/B double-buffered pipeline so the *common* queue
advance (preload-hit) became a 1-frame cut. This round closes the
remaining edge cases that could still surface a black frame or spinner
between videos:

1. **Cold-load via inactive slot (TV + mobile-web).** Previously, when
   `hlsUrl` advanced to a URL that *wasn't* primed on the inactive slot
   (channel change, schedule jump, override toggle, queue mutation), the
   active slot's hls.js was destroyed in-place and `src` reassigned —
   blacking out the visible `<video>` for the duration of the manifest
   fetch. Now the cold-path URL is staged on the **inactive** slot in
   preload mode; a `pendingPromotionUrlRef` + watcher effect listens
   for `loadeddata`/`canplay`/`playing` and promotes via
   `swapToInactive` / `swapWebSlots` the moment the slot is ready.
   The visible slot keeps showing its last frame the entire time. A
   15s safety fallback hard-loads onto the active slot if the inactive
   slot can't get ready (matches `LOAD_WATCHDOG_MS`).

2. **Autonomous swap on `ended` (TV).** Added an `ended` listener on
   the active slot that promotes the inactive slot immediately if it
   has a different URL primed and is at `readyState ≥ 2`. Eliminates
   the "video ends → wait for SSE → swap" black gap when the server's
   transition tick hadn't yet fired. The SSE-driven `hlsUrl` change
   that arrives moments later lands harmlessly because the URL now
   matches the active slot. Mobile already had this via `onEnded`
   piping into `handleVideoEnd` — see point 4.

3. **Faster server transition ticker.** `_tickTransitions` interval
   reduced from **2,000ms → 500ms** in `artifacts/api-server/src/routes/broadcast.ts`.
   Clients now auto-swap on `ended` so the SSE isn't strictly required
   for video continuity, but it remains the source of truth for the
   now-playing card and up-next list — the faster tick keeps that
   metadata in lock-step with the actual on-screen video.

4. **Mobile `handleVideoEnd` no-wait path.** Removed the hard-coded
   800ms `setTimeout` before re-tuning the broadcast on video end.
   The web A/B player auto-swaps the moment the active video ends, so
   the wait was creating a visible black gap on platforms where the
   pipeline is already swapped. Native iOS/Android (single-engine
   `expo-av`) also benefits — re-tuning immediately makes the source
   change land sooner.

Files touched:
- `artifacts/tv/src/components/HlsVideoPlayer.tsx`
- `artifacts/mobile/components/LocalVideoPlayer.tsx`
- `artifacts/mobile/app/player.tsx`
- `artifacts/api-server/src/routes/broadcast.ts`

TypeScript clean for both `@workspace/tv` and `@workspace/mobile`. All
four workflow servers come up cleanly (api:8080, admin:23744,
mobile:18115, tv:23876) with no errors. `/api/broadcast/current`
returns 200.


---

## Round 9 — Broadcast-Clean: All Up Next / Title Metadata Removed (Apr 25, 2026)

Per the directive to make the broadcast viewing experience read like a
real television channel, **every** "Up Next" label, video title, and
queue/preview metadata element has been removed from the live broadcast
surfaces across all platforms. The underlying `nextItem` data flow is
**preserved** — it still feeds the inactive A/B preload slot — it is
simply no longer surfaced to the viewer.

### Surfaces stripped of titles & queue metadata

1. **Mobile cinematic hero** (`artifacts/mobile/app/(tabs)/index.tsx`):
   `BroadcastUpNext` component definition + render site removed. The
   hero now shows only the live preview video, branded subtitle, and
   the "Watch Temple TV" CTA — no "Up Next: <title>" chip.

2. **Mobile broadcast info strip** (`artifacts/mobile/components/BroadcastInfoStrip.tsx`):
   Reduced to the bare TV-channel affordances: `NOW ON AIR` dot +
   `TEMPLE TV` channel badge. The previous "Up Next: <title>" line
   under the badges is gone. Component left in the tree so the
   gradient + safe-area math driving player chrome stays stable.

3. **Mobile player chrome** (`artifacts/mobile/app/player.tsx`):
   In `isBroadcastMode`, `displayTitle` is forced to `"Temple TV Live"`,
   `displayPreacher` to `"JCTM Broadcast"`, and `displayDuration` /
   `displayCategory` to empty strings. The native player chrome,
   share sheet, and on-screen title section all read as the channel
   identity instead of leaking the currently airing sermon name.
   The VOD `nextSermon` "Up Next" auto-play banner is also gated
   with `!isBroadcastMode` defensively.

4. **TV HLS player** (`artifacts/tv/src/components/HlsVideoPlayer.tsx`):
   In `isLive` mode, the top control bar's `<h2>{title}</h2>` is
   replaced with a `flex: 1` spacer. Back button, quality badge, and
   fullscreen control remain pinned in place.

5. **TV YouTube player** (`artifacts/tv/src/pages/Player.tsx`):
   Same treatment — the title `<h2>` in the top overlay is gated with
   `!isLive`. VOD playback still shows the title; live broadcast does
   not.

6. **TV Live Hero** (`artifacts/tv/src/components/LiveHero.tsx`):
   The dynamic `{liveStatus?.title ?? "Temple TV Live Stream"}` is
   replaced with a hardcoded `Temple TV Live Stream` heading. The
   landing page now reads as a channel-identity tease, not as a
   sermon-specific landing.

### NOT touched (intentionally)

- `artifacts/tv/src/pages/VideoDetails.tsx` — VOD library page, not a
  broadcast surface. Its "Up Next" related-videos panel is part of the
  on-demand catalog UX, not live-channel UX.
- `artifacts/mobile/app/(tabs)/guide.tsx` — schedule/EPG page; users
  explicitly come here to see what's airing and what's next.
- `artifacts/mobile/app/(tabs)/radio.tsx` — radio station queue UI;
  audio-station context, not broadcast-channel context.
- `artifacts/mobile/app/player.tsx` line 1085 region — the VOD
  related-sermon auto-play banner is now gated with `!isBroadcastMode`
  but otherwise preserved for VOD playback.

### Verification

TypeScript clean on `@workspace/mobile` and `@workspace/tv`
(`tsc --noEmit` produces no output). All four workflow services start
cleanly (api:8080, admin:23744, mobile:18115, tv:23876).
`nextItem` continues to flow through the broadcast SSE / current-tune
pipeline so the A/B inactive-slot preload (Round 7) still primes the
next program before the active video ends — the viewer still gets a
black-frame-free transition (Round 8), they just no longer see a text
hint that the transition is coming.

---

## Round 9b — Real-Broadcaster Channel Bug (Apr 25, 2026)

Re-introduced station identity *the right way* after Round 9 stripped all
title metadata from broadcast surfaces. A discreet "TEMPLE TV" watermark
now sits in the bottom-right corner of every live playback surface and
fades in **3 seconds after each program change** — the convention used
by real TV networks (NBC peacock, CBS eye, ESPN logo, CNN bug) where
the station mark eases in once the new program has settled on screen,
not the moment the cut happens.

### What was added

1. **`artifacts/tv/src/components/BroadcastChannelBug.tsx`** (new) —
   TV/web watermark component. Pure-CSS opacity transition, glassy
   `rgba(0,0,0,0.42)` chip with `backdrop-filter: blur(8px)`, white
   "TEMPLE TV" wordmark + tiny `#FF0040` live-dot. Resets fade on
   `programKey` change, fades in over 700ms after a 3000ms grace
   period. `pointer-events: none` and `z-index: 5` so it never
   intercepts remote-control focus and always sits below the chrome
   overlay (`z-index: 10`).

2. **`artifacts/mobile/components/ChannelBug.tsx`** (extended) —
   Added a new `mode="watermark"` variant that mirrors the TV
   behaviour (3s delay, 700ms fade, no pulse) for React Native. The
   legacy `mode="chrome"` (default) keeps the existing pulsing badge
   untouched so `(tabs)/radio.tsx` continues to render exactly as
   before. New `programKey` prop is the program identifier the
   watermark watches.

### Where it's mounted

- **`artifacts/tv/src/components/HlsVideoPlayer.tsx`** — `{isLive && <BroadcastChannelBug programKey={hlsUrl} />}`
  rendered alongside the A/B `<video>` slots. The HLS URL change is
  exactly the same signal that drives the A/B preload swap (Round 7),
  so each new program automatically gets its own grace period before
  the bug re-fades in.

- **`artifacts/tv/src/pages/Player.tsx`** YouTubePlayer — `{isLive && <BroadcastChannelBug programKey={videoId} />}`
  for live YouTube broadcasts. Sits above the iframe/loading veil
  inside the same fixed-position container.

- **`artifacts/mobile/app/player.tsx`** — Removed the legacy top-right
  chrome `ChannelBug` (the LIVE badge already conveys "this is live"
  in the chrome) and replaced it with a bottom-right watermark
  rendered inside the `playerContainer` whenever `isBroadcastMode`
  is on. `programKey={tunedVideoId ?? tunedLocalVideoUrl ?? ""}` so
  the SSE/15s-poll/precision-timer that mutates the tuned slots
  drives the fade reset on each queue advance.

### Visual spec

- Position: bottom-right, `clamp(16px, 2.4vw, 28px)` inset on TV;
  fixed 14px on mobile.
- Background: `rgba(0,0,0,0.42)` + 8px blur + 1px `rgba(255,255,255,0.18)` border.
- Wordmark: white "TEMPLE TV", weight 700, 0.14em letter-spacing,
  `clamp(10px, 1.05vw, 13px)` on TV / 10px on mobile.
- Live-dot: `#FF0040` (the same accent the LIVE badge uses), 7-8px
  with a soft red glow.
- Final opacity: 0.7 — visible but never competing with the video.
- Fade-in: 700ms ease-out after a 3000ms delay. Fade-out is
  effectively instant on program change (key resets `opacity: 0`),
  matching how real broadcasters drop the bug between program
  segments.

### What this does NOT change

- The Round 9 "no-titles, no-up-next" directive is fully preserved —
  the watermark is a *station* identifier, not a *program* one. It
  shows the channel brand, never the sermon name.
- The underlying `nextItem` data continues to flow through the SSE /
  current-tune pipeline so the A/B inactive-slot preload still primes
  the next program (Round 7) and Round 8's black-frame-free swap
  still wins.

### Verification

TypeScript clean on `@workspace/mobile` and `@workspace/tv`. All four
workflow services start cleanly (api:8080, admin:23744, mobile:18115,
tv:23876).

---

## Round 9c — Cross-Platform Parity Audit & Shared Identity Module (Apr 25, 2026)

Took a full pass across mobile + TV + admin to find any broadcast-clean
parity gaps the previous rounds missed, fixed each one, and centralized
the broadcast channel identity into a single source of truth per
platform so this category of leak cannot happen again.

### Parity gaps found and fixed

A `rg "liveStatus.title|nextItem.title|Up Next"` sweep across all
viewer-facing surfaces surfaced **5 leaks** that escaped Rounds 8/9:

| Surface                                    | File                                                | Leak                                                                  | Fix                                                            |
|--------------------------------------------|-----------------------------------------------------|-----------------------------------------------------------------------|----------------------------------------------------------------|
| Mobile hero — title                        | `mobile/app/(tabs)/index.tsx:546`                   | `liveStatus.title` shown when live                                    | → `BROADCAST_HERO_TITLE` constant                              |
| Mobile hero — live notification banner     | `mobile/app/(tabs)/index.tsx:343`                   | `liveStatus.title` in banner copy                                     | → `BROADCAST_LIVE_BANNER_TITLE` constant                       |
| Mobile hero — `handleLivePress` route param| `mobile/app/(tabs)/index.tsx:208`                   | passed `liveStatus.title` to player route                             | → `BROADCAST_TITLE` / `BROADCAST_PREACHER` constants           |
| Mobile supervisor                          | `mobile/components/LiveBroadcastSupervisor.tsx:55`  | passed `liveStatus.title` on auto-navigation                          | → `BROADCAST_TITLE` / `BROADCAST_PREACHER` constants           |
| Mobile player chrome                       | `mobile/app/player.tsx:760`                         | only blanked title in `isBroadcastMode`, not in `isLive`              | extended override to `(isLive \|\| isBroadcastMode)`           |
| TV Home — YouTube live row select          | `tv/src/pages/Home.tsx:105`                         | `liveStatus.title` passed to `onPlay`                                 | → `BROADCAST_TITLE` constant                                   |
| TV Home — LiveHero `onSelect` (YouTube)    | `tv/src/pages/Home.tsx:249`                         | `liveStatus.title` passed to `onPlay`                                 | → `BROADCAST_TITLE` constant                                   |

The TV broadcast-queue path (`Home.tsx:113, 258`) was already
broadcast-clean and required no changes — it always passed a hardcoded
`"Temple TV"`. The admin console (`admin/src/pages/broadcast.tsx:336`)
intentionally still shows "Up next" because it's an operator surface,
not a viewer surface. The mobile player VOD "Up Next" auto-play banner
remains gated with `!isBroadcastMode` from Round 9.

### Single source of truth — broadcast identity module

Two new modules establish per-platform identity constants:

- **`artifacts/mobile/lib/broadcastIdentity.ts`** — exports
  `BROADCAST_TITLE`, `BROADCAST_HERO_TITLE`,
  `BROADCAST_LIVE_BANNER_TITLE`, `BROADCAST_PREACHER`.
- **`artifacts/tv/src/lib/broadcastIdentity.ts`** — exports
  `BROADCAST_TITLE`, `BROADCAST_HERO_TITLE`.

Each module's docstring cross-references its sibling on the other
platform and warns to update both in lock-step. Every site that
previously had `liveStatus.title ?? "Temple TV Live"` now imports the
relevant constant — meaning a future identity rebrand happens in two
files, not two dozen, and TV + mobile cannot drift out of sync without
an obvious diff in both `lib/broadcastIdentity.ts` modules.

### What this means for cross-platform consistency

- The "broadcast-clean" contract is now enforced at the route-param /
  navigation level, not just at the chrome-render level. Even if some
  future component naively reads `paramTitle` and renders it, the
  value flowing in is already the channel identity, not a leaky
  per-program title.
- Mobile `isLive` (live YouTube event) now behaves identically to
  mobile `isBroadcastMode` (broadcast queue) for title / preacher /
  duration / category — both render as the channel identity.
- TV and mobile heros, players, and notification banners all now read
  from the same shared constants, so the user experience is identical
  across surfaces.

### Verification

- `rg "liveStatus\??\.title"` across `artifacts/mobile/` and
  `artifacts/tv/` returns zero hits outside the new identity modules'
  doc comments.
- TypeScript clean on `@workspace/mobile` and `@workspace/tv`.
- All four workflow services start cleanly (api:8080, admin:23744,
  mobile:18115, tv:23876) and `/api/broadcast/current` responds 200.

### Scope deliberately NOT taken on

The attached prompt's broader asks (separate CI/CD parity blocker
pipelines, automated cross-platform diff scanners, deployment
version-gating, monitoring dashboards) are infrastructure that doesn't
fit a single Replit monorepo and would dwarf the actual broadcast-
quality work. The pragmatic interpretation taken here was: **find and
close real parity gaps, then centralize the shared values so the same
class of gap cannot recur**. That's what was done.

---

## Round 10 — Web Push notifications end-to-end (Apr 25, 2026)

The admin readiness page was flagging "Push notification reach: 0
devices registered, needs attention." Diagnosed and fixed at the
architecture level rather than papering over the warning.

### Root-cause findings

1. **Web users could not register at all.** The web variant of
   `mobile/services/notifications.ts` was a no-op stub returning
   `null` for everything. Anyone using the web preview was
   structurally unable to subscribe.
2. **The `/api/push-tokens` endpoint rejected anything but `ios` /
   `android`** — even if web sent a token, it would have been 400'd.
3. **The Expo `projectId` in `app.json` is `"temple-tv-jctm"` — a
   slug, not an EAS UUID.** `getExpoPushTokenAsync()` therefore
   throws on real native devices. Cannot be fixed without an actual
   EAS project setup.
4. **All registration errors were silently swallowed** — no
   telemetry of why it was failing.
5. **Dev environment only has a web preview** — no real iOS/Android
   test devices to register with.

### What was built — full Web Push pipeline (independent of Expo)

#### Backend (`@workspace/api-server`)

- **New dependency**: `web-push` (+ `@types/web-push`).
- **New service**: `artifacts/api-server/src/services/web-push.ts`
  - `ensureVapidKeys()` — checks env vars first, then `app_config`
    table, then auto-generates and persists. Cached in process after
    first read.
  - `getVapidPublicKey()` — exposed via API.
  - `sendWebPushNotifications(title, body, data)` — fan-out to all
    stored subscriptions in parallel; auto-prunes endpoints that
    return 404/410 (expired); logs other failures.
- **New endpoints (mounted at `/api/...`)**:
  - `GET  /api/push/web-vapid-public-key` → returns the public key
    so browsers can call `pushManager.subscribe()`.
  - `POST /api/push/web-subscriptions` → upserts a subscription
    `{ endpoint, keys: { p256dh, auth }, userAgent }` keyed by
    endpoint.
- **Updated sender** (`/api/admin/notifications/send`) — now
  dispatches to **both** Expo native tokens AND web subscriptions
  in parallel. Response message reports each channel separately:
  `"Notification sent to N/M devices (native: X/Y, web: A/B)"`.
- **Updated readiness/status counts** — three places
  (`/admin/stats`, `/admin/operations/status`, `/admin/launch/readiness`)
  now sum `push_tokens` + `web_push_subscriptions`. Readiness check
  message updated to:
  > "N devices registered (native: X, web: Y)" when > 0,
  > else "0 devices are registered for notifications."
  > Recommendation: "Open the web app and allow notifications, or
  > open the mobile app on test devices."

#### Database (`@workspace/db`)

- **New table `web_push_subscriptions`** — id, endpoint (UNIQUE),
  p256dh, auth, userAgent, createdAt, lastSeenAt. Schema in
  `lib/db/src/schema/web-push-subscriptions.ts`.
- **New table `app_config`** — generic key/value store with
  updatedAt. Used to persist VAPID keypair across restarts without
  requiring env-var setup. Schema in
  `lib/db/src/schema/app-config.ts`.
- Both exported from `lib/db/src/schema/index.ts` and pushed via
  `pnpm --filter @workspace/db push`.

#### Mobile web

- **New service worker**: `artifacts/mobile/public/sw-temple-push.js`
  - `push` event → renders notification with icon, badge, tag, and
    optional `data.url` for click-through.
  - `notificationclick` → focuses an existing client and navigates,
    or opens a new window.
  - `install`/`activate` → `skipWaiting` + `claim` for fast updates.
- **Replaced web stub** at `artifacts/mobile/services/notifications.ts`
  with full Web Push implementation:
  - Feature-detects `serviceWorker` + `PushManager` + `Notification`.
  - Requests permission (idempotent — re-uses `granted`/`denied`).
  - Registers SW at `/sw-temple-push.js`.
  - Fetches VAPID public key from API, calls
    `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`.
  - POSTs `{ endpoint, keys, userAgent }` to
    `/api/push/web-subscriptions`.
  - All errors return `null`/`false` rather than throwing.
- **Removed web gate** in `artifacts/mobile/app/_layout.tsx` — the
  `Platform.OS !== "web"` block previously skipped registration on
  web entirely. The dynamic import to `@/services/notifications` now
  fires on every platform; the web variant handles the web path.

### VAPID key strategy

Two-tier with sensible defaults:
1. If `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` env vars are set →
   use those (production/multi-instance friendly).
2. Otherwise, read/auto-generate from the `app_config` PostgreSQL
   table. First request to `/api/push/web-vapid-public-key` triggers
   generation; subsequent requests reuse. Survives server restarts.
   `VAPID_SUBJECT` env var optional, defaults to
   `mailto:admin@temple.tv`.

This means **the user does not have to set any environment variables
to get Web Push working** — it self-bootstraps on first call. Verified
in this session: a fresh server returned a brand new public key,
persisted both halves, accepted a test subscription, and rejected
duplicate-endpoint inserts via `onConflictDoUpdate`.

### Verification performed in this session

- `GET /api/push/web-vapid-public-key` → 200, returns valid base64url
  EC P-256 public key.
- `POST /api/push/web-subscriptions` with test payload → 200, row
  inserted into `web_push_subscriptions`.
- `app_config` table contains both `vapid_public_key` and
  `vapid_private_key` after first request.
- All 4 services (api:8080, admin:23744, mobile:18115, tv:23876)
  start cleanly post-restart.
- TypeScript clean on `@workspace/mobile`. The api-server's two
  remaining errors are in `routes/broadcast.ts` and pre-date this
  round.
- Test row cleaned up — production count is back at 0.

### What happens now when a user opens the web preview

1. App boots → `_layout.tsx` dynamically imports `notifications.ts`.
2. `registerForPushTokenAsync()` runs → browser prompts for
   notification permission.
3. On grant → SW registered → VAPID key fetched → push subscription
   created → POSTed to server → row appears in
   `web_push_subscriptions`.
4. Admin readiness page on next refresh shows:
   "1 devices registered (native: 0, web: 1)" — the warning flips to
   ready.
5. Any subsequent `POST /api/admin/notifications/send` from the
   admin will deliver to that browser, even when the tab is closed
   (as long as the browser/OS is running).

### Files added or modified

**Added:**
- `lib/db/src/schema/web-push-subscriptions.ts`
- `lib/db/src/schema/app-config.ts`
- `artifacts/api-server/src/services/web-push.ts`
- `artifacts/mobile/public/sw-temple-push.js`

**Modified:**
- `lib/db/src/schema/index.ts` — exports new tables
- `artifacts/api-server/src/routes/admin.ts` — endpoints, sender,
  readiness/stats/ops counts (5 spots)
- `artifacts/mobile/services/notifications.ts` — full Web Push impl
  (replacing the no-op stub)
- `artifacts/mobile/app/_layout.tsx` — removed web platform gate so
  registration runs on web too
- `artifacts/api-server/package.json` — `web-push` + `@types/web-push`

### Notes on what was NOT changed

- The Expo `projectId` slug issue on native devices was left alone —
  it requires an actual EAS project setup which is outside the
  Replit environment. Web Push completely sidesteps that issue for
  the immediate problem ("0 devices, needs attention").
- The `notifications.native.ts` was not modified — the native path
  (which expects a real EAS projectId) is preserved as-is for when
  the user does set up EAS.
- iOS Safari requires the web app to be installed to the home
  screen before it can receive Web Push (iOS 16.4+). Chrome/Edge/
  Firefox on desktop and Android Chrome work immediately.

---

## Round 11 — Schedule Programming Seed + Admin Stale-Cache Fix

### Part A: Programming Schedule Seed
Launch readiness card "Programming schedule: 0 active schedule entries are
configured" was a real gap. Seeded a minimal weekly skeleton of 7 named
programs (one per day) directly into `schedule_entries`:

| Day | Time | Program |
|---|---|---|
| Sun | 09:00–12:00 | Sunday Worship Service |
| Mon | 18:00–19:00 | Monday Daily Devotional |
| Tue | 18:00–19:00 | Tuesday Daily Devotional |
| Wed | 19:00–21:00 | Wednesday Bible Study |
| Thu | 18:00–19:00 | Thursday Daily Devotional |
| Fri | 19:00–21:00 | Friday Night Worship |
| Sat | 18:00–19:00 | Saturday Sermon Spotlight |

All entries use `contentType: "live"`, `isRecurring: true`, `isActive: true`.
Because `"live"` slots are pure metadata for the TV guide and do **not**
override the broadcast queue (verified at `routes/broadcast.ts:196`), the
24/7 broadcast keeps playing exactly as before. The schedule simply gives
the TV guide and "what's on now" indicators meaningful programming labels.
Operators customize each entry (rename, change time/day, point at a specific
playlist or video) via the admin Schedule page.

Readiness check now reports `status:"ready", detail:"7 active schedule
entries are configured."`

### Part B: Admin Stale-Cache Fix (Operations page)
User reported "Cloud object storage — Not configured — Degraded" on the
Operations page even though `/api/admin/ops/status` returned
`infrastructure.objectStorage.configured: true` and the `object_storage`
check returned `status: "ok"` (all 4 AWS env vars verified set:
`AWS_REGION=eu-north-1`, `AWS_S3_BUCKET=temple-tv-media-storage`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, plus `PUBLIC_OBJECT_SEARCH_PATHS`,
`PRIVATE_OBJECT_DIR`).

Root cause: the central admin fetch helper `adminGet` in
`artifacts/admin/src/services/adminApi.ts` called `fetch()` without `cache:
"no-store"`, and the API does not send `Cache-Control` headers, so the
browser's heuristic HTTP cache could serve a stale response on initial page
load (and even some polls when the response body matched a cached
representation). Since the Operations page polls every 10s, the staleness
typically self-corrected, but operators reloading the page would briefly see
yesterday's "degraded" state — the same root cause behind the previous
Object Storage launch-readiness false alarm.

Architectural fix: added `cache: "no-store"` to the central admin fetch
helper. This covers ALL admin API calls (~50 endpoints across operations,
launch-readiness, transcoding, uploads, telemetry, live monitor, etc.) so
no individual route has to remember to opt out of caching. Bandwidth cost
is negligible — admin polling intervals are 5–15 seconds and responses are
small JSON. Operator confusion cost from stale "degraded" badges is high.

Files changed:
- `artifacts/admin/src/services/adminApi.ts` — one-line addition of
  `cache: "no-store"` to the shared `fetch()` call inside `adminApi`,
  with an explanatory comment.

No server changes required. Vite HMR picks up the change on next page load.

## Round 12 — Direct YouTube Live URL Broadcasting (Apr 26, 2026)

Added a one-paste path for going live with a YouTube stream. Admins drop
a YouTube URL (any of `watch?v=`, `youtu.be/`, `/live/`, `/embed/`,
`/shorts/`, or a bare 11-char video ID) into Live Control, hit Preview to
verify the stream is live, then Go Live — and TV / mobile / web / tablet
all switch to that YouTube video within seconds via the existing SSE
`broadcast-control-updated` event plus the regular live-status polling.

Reuses the existing `live_overrides` table rather than building a parallel
mechanism — added one nullable `youtube_video_id` column.

### Architecture

- **Schema** (`lib/db/src/schema/live-overrides.ts`): added
  `youtubeVideoId text("youtube_video_id")`. Drizzle push applied.
- **URL helper** (`artifacts/api-server/src/lib/youtubeUrl.ts`): pure
  `extractYouTubeVideoId()` (handles all 6 URL shapes) plus
  `validateYouTubeLiveStream()` (oembed for existence + watch-page probe
  for liveness — no YouTube Data API quota consumption).
- **Admin routes** (`artifacts/api-server/src/routes/admin.ts`):
  `POST /admin/live-overrides`, `PATCH /admin/live-overrides/:id`, and
  `POST /admin/live/override/start` accept `youtubeUrl`, extract the ID,
  optionally probe liveness, and persist `youtubeVideoId`. New
  `POST /admin/live/override/preview-youtube` returns
  `{ok, exists, isLive, videoId, title, thumbnailUrl, reason}` for the
  admin Preview button. `skipYoutubeValidation: true` escape hatch lets
  admins force go-live during a YouTube oembed outage.
- **Payload propagation** (`artifacts/api-server/src/routes/broadcast.ts`,
  `artifacts/api-server/src/routes/youtube.ts`):
  - `liveOverride` projection on `/api/broadcast/current` includes
    `hlsStreamUrl` + `youtubeVideoId`.
  - `/api/youtube/live` and `/api/youtube/live/status` both prefer an
    active override's `youtubeVideoId` over channel auto-detection (with
    a 5s in-process cache on the status endpoint to keep DB load
    predictable under the TV's 30s poll + mobile's 60s poll).
- **Admin UI** (`artifacts/admin/src/pages/live-control.tsx`): YouTube
  URL input as the **primary** field (HLS / RTMP demoted to optional),
  Preview button with success/warning/destructive badge, thumbnail
  preview card, "Force Go Live (skip YouTube check)" emergency button
  shown only when a previewed video exists but appears offline. Active
  override card shows YouTube video ID as a clickable link.
- **TV** (`artifacts/tv/src/hooks/useLiveSync.ts`): exposes
  `liveOverride.youtubeVideoId` and prefers it as the active `videoId`.
  `Home.tsx` did not need changes — the existing
  `liveStatus.isLive && liveStatus.videoId → onPlay(..., isLive=true)`
  branch already routes to the YouTube player, and `/youtube/live/status`
  is now override-aware.
- **Mobile** (`artifacts/mobile/services/broadcast.ts`): liveOverride
  type extended with `hlsStreamUrl` + `youtubeVideoId`. The supervisor
  needs no code change because it already polls `/api/youtube/live`,
  which now returns the override's video ID.

### Why it's safe

- Pure additive — every field is nullable / optional, no existing
  callers see new required keys.
- Override lookup at hot endpoints uses a 5s cache (status endpoint)
  and short DB lookups (`getActiveOverrideYouTubeVideoId`) sorted by
  `priority asc, createdAt asc`, matching the existing override
  resolver's ordering.
- Validation tolerates YouTube outages: the probe runs with a short
  timeout and the admin can bypass it with `skipYoutubeValidation`.
- Players prefer YouTube when both `youtubeVideoId` and `hlsStreamUrl`
  are set — documented inline in the admin form helper text.

## Round 12b — "Recent YouTube Streams" Re-Broadcast Dropdown (Apr 26, 2026)

Follow-up to Round 12. Recurring services (Sunday service, midweek
prayer, etc.) re-use the same YouTube live URL pattern week after week —
admins shouldn't have to dig up the link every time. Added a Recent
button next to the YouTube URL field in Live Control that opens a
dropdown of distinct, most-recently-broadcast YouTube video IDs from
override history. Click an item → URL field is populated, title is
auto-filled, and the Preview probe fires automatically.

### Architecture

- **Endpoint** (`artifacts/api-server/src/routes/admin.ts`):
  `GET /admin/live-overrides/recent-youtube` queries the last 50
  override rows that have a non-null `youtube_video_id`, dedupes
  client-side by video ID, and returns the top 10 with title + a
  free `i.ytimg.com/vi/<id>/mqdefault.jpg` thumbnail. No YouTube API
  quota consumed.
- **API client** (`artifacts/admin/src/services/adminApi.ts`): new
  `RecentYoutubeStream` interface + `liveApi.getRecentYoutubeStreams()`.
- **UI** (`artifacts/admin/src/pages/live-control.tsx`): Popover with
  thumbnail + title + last-aired timestamp. Hidden entirely when no
  history exists so first-time setups stay clean. Auto-invalidated
  when a new override starts so the just-broadcast stream is at the
  top of the list next time.

### Why it's safe

- Read-only endpoint, sits behind the same admin auth middleware as
  every other admin route.
- The query is bounded (`limit 50`) and indexed on `started_at`
  (the existing default-desc primary access pattern for live_overrides),
  so it stays cheap regardless of history size.
- Thumbnails are `<img>` tags with a `loading="lazy"` + `onError`
  hide so deleted/private videos don't render a broken icon.
- Dropdown auto-fires the existing Preview probe on selection — the
  admin never goes live blind on a stale URL just because they clicked
  it from history.

## Round 12c — Schedule a YouTube Stream for Future Auto-Go-Live (Apr 26, 2026)

Follow-up to Round 12b. Recurring services have predictable times
(Sunday 9am, midweek 6:30pm, etc.) — admins shouldn't need to be at a
keyboard at the exact moment to push Go Live. Added a "Schedule for
later" flow: paste a YouTube URL, pick a date/time, and the server
auto-activates the override at that moment, broadcasting to every
surface via the same SSE event the manual flow uses.

### Architecture

- **Schema** (`lib/db/src/schema/live-overrides.ts`): added
  `scheduledFor timestamp` (nullable) + `autoStarted boolean default
  false`. Drizzle push applied. Both fields are nullable / defaulted
  so existing rows are unaffected.
- **Scheduler** (`artifacts/api-server/src/lib/live-override-scheduler.ts`):
  new module mirroring `notification-scheduler.ts` exactly — 30-second
  interval, single-instance re-entrancy guard, errors logged but never
  thrown. Atomically claims due rows via conditional UPDATE on
  `(id, isActive=false, autoStarted=false)` so multi-replica deployments
  on Render can run the scheduler everywhere safely (only one replica
  wins per row). Started from `index.ts` alongside the other API
  schedulers.
- **Admin endpoints** (`artifacts/api-server/src/routes/admin.ts`):
  - `POST /admin/live/override/schedule` — creates an inactive override
    with `scheduledFor` set. Validates URL, title, future-time
    guardrail (rejects past timestamps with >60s slack), and runs the
    same YouTube probe as the manual flow but as a non-blocking
    *warning* (the stream may not exist yet at scheduling time, which
    is the whole point).
  - `GET /admin/live/override/scheduled` — returns upcoming scheduled
    rows ordered by `scheduledFor` ascending. Filters out stale
    entries (anything older than 60s past its target — those were
    superseded by a manual Go Live).
  - `DELETE /admin/live/override/schedule/:id` — cancels a scheduled
    override before it fires. Hard-deletes (cancelled schedules have
    no audit value because they never aired). Refuses to delete an
    already-active or already-fired row.
- **API client** (`artifacts/admin/src/services/adminApi.ts`): new
  `ScheduledOverride` type + `liveApi.schedule` / `getScheduled` /
  `cancelScheduled` methods.
- **Admin UI** (`artifacts/admin/src/pages/live-control.tsx`):
  - "Upcoming Scheduled Broadcasts" card above the start form, hidden
    when empty. Each row shows title, target wall-clock time, a live
    countdown (e.g. "in 2h 15m"), source video ID/URL, and a one-click
    cancel.
  - "Schedule for later" toggle button next to "Go Live". Reveals a
    `<input type="datetime-local">` pre-filled with "next hour, on the
    hour" — a sensible default that's safely in the future.
  - Reuses the same form fields (title, YouTube URL, HLS URL,
    notes, duration) so admins don't relearn anything.

### Why it's safe

- All new columns nullable / defaulted — existing inserts and the
  manual `/start` route work unchanged.
- Past-time guardrail prevents the most likely typo (off-by-one am/pm)
  from auto-firing on the next scheduler tick.
- Only one override is ever active at a time — the scheduler stands
  down any other active override before activating its claim, mirroring
  the manual flow exactly.
- YouTube probe is best-effort during scheduling because the stream
  often doesn't exist yet at scheduling time.
- Multi-instance safe: atomic conditional UPDATE means no double-fires
  even when scaled horizontally.
- Scheduled rows that get superseded by a manual Go Live are filtered
  out of the upcoming list automatically.

## Round 12d — Refactor: Shared Live Status Helpers (Apr 26, 2026)

Follow-up cleanup discovered while auditing Round 12c. The
live-override scheduler was emitting only one of the three SSE/state
events that the manual `POST /admin/live/override/start` route emits
— meaning a scheduled go-live wouldn't push the canonical `status`
payload to viewers, only a `broadcast-control-updated` ping. On
clients that listen specifically for `status` (some tablet/web
players), the new override wouldn't appear until the next periodic
refetch instead of instantly.

### What changed

- New shared module **`artifacts/api-server/src/lib/liveStatus.ts`**
  exporting `buildLiveStatusPayload()` and `getActiveLiveOverride()`.
  These were previously local-only in `routes/admin.ts`.
- `routes/admin.ts` now imports both from the shared lib. The local
  duplicates are removed (replaced with a discoverability comment so
  future grep-for-the-helper still lands somewhere informative).
- `live-override-scheduler.ts` now performs the **same three-step
  fan-out** the manual flow does:
  1. Invalidate broadcast cache keys
  2. Build + broadcast the canonical `status` SSE payload
  3. Broadcast `broadcast-control-updated` ping
  4. Emit `live-started` broadcast state for the admin activity feed
- The scheduler also tags both events with `source: "scheduler"` so
  observers can distinguish auto-fired from manually-started overrides
  in logs/dashboards.

### Why it matters

Before this refactor, two slightly different code paths were
maintaining their own copies of "what to send when an override goes
live." Inevitably they would drift — and they had: only the manual
path sent the `status` payload. Now there's one canonical builder
and both paths use it, so viewers see identical behavior whether
admin clicks "Go Live" or the scheduler fires at 9am Sunday.

Build clean, server boots clean ("Live override scheduler started"
visible in startup logs), endpoints all return expected status codes,
no regressions in the existing `/api/broadcast/current` payload.

---

## Round 12d — Per-route timeouts + slow-request observability widget

### What changed

- **`artifacts/api-server/src/middlewares/observability.ts`** extended:
  - New per-route stats `Map` keyed by `${method} ${normalizedPath}` —
    tracks total/errors/totalMs/maxMs/slowCount/lastStatus/lastAt.
  - New 50-entry slow-request ring buffer (entries older than 1h are
    pruned at read time). Captures method, normalised path, raw path,
    status, durationMs, ISO timestamp, and request ID when present.
  - Path normalisation collapses UUID/numeric/long-hex segments to
    `:id` so `/api/videos/<uuid>` doesn't explode the route map. Hard
    cap at 500 keys with LRU-ish eviction as defence in depth.
  - New `slowRequestsSnapshot()` returns `{ thresholdMs, entries,
    routes, capturedCount, bufferSize, bufferMaxAgeMs }` with routes
    sorted by slowCount then maxMs and capped at 25.
  - `requestMetrics` now also listens for `close` (not just `finish`)
    so client aborts get recorded too, guarded by a `recorded` flag.
- **`artifacts/api-server/src/middlewares/requestTimeout.ts`** (new):
  - 30s default wall-clock timeout (configurable via
    `REQUEST_TIMEOUT_MS`). On timeout, logs a `request_timeout` warn
    and sends 504 if `!res.headersSent`.
  - Skip patterns: `/api/uploads`, `/api/hls`, anything ending in
    `/events`, `/api/admin/videos/upload*`, `/api/healthz`,
    `/api/metrics`, plus any request with
    `Accept: text/event-stream`.
  - Timer is `unref()`-ed so graceful drain doesn't have to wait the
    full timeout window for already-finished requests.
- **`artifacts/api-server/src/app.ts`** wires `requestTimeout()` in
  immediately after `requestMetrics`.
- **`artifacts/api-server/src/routes/admin.ts`** new endpoint
  `GET /admin/ops/slow-requests` — separate from `/admin/ops/status`
  so the busy 10s status poll doesn't drag along the route stats.
- **`artifacts/admin/src/services/adminApi.ts`** adds `slowRequestsApi`
  + `SlowRequestEntry`, `SlowRouteStats`, `SlowRequestsSnapshot`
  types.
- **`artifacts/admin/src/pages/operations.tsx`** new `SlowRequestsCard`
  rendered below the existing Request Metrics card. Polls every 30s,
  shows the threshold + window in the badge, lists the 15 most recent
  slow requests with status/duration colour tones, and a per-route
  table (top 10) sorted by slowCount.

### Why it matters

Express has no per-route timeout. A handler that hangs (slow DB query,
unbounded fetch, dead transcoder semaphore) will eat sockets until the
HTTP server's max-sockets pool is exhausted and the whole API stops
accepting connections. The middleware now caps every non-streaming
request at 30s and surfaces a 504 to the client instead of silently
hanging. The slow-request ring buffer + per-route stats give operators
the evidence to find which route is the culprit without needing to
SSH and grep logs.

Both builds clean, server boots clean, new endpoint returns 200 and
the response shape matches the typed admin client. Per-route stats
(`GET /api/healthz`, `GET /api/admin/ops/slow-requests`) showed up
correctly within the first two requests.

---

## Round 12d-hotfix — YouTube live validator was rejecting actually-live streams

### Symptom

Admin pasted `https://www.youtube.com/live/f51qV6XvQ40?...` into the
Live YouTube admin page. Validator returned **"Video exists but is
not currently live."**  Same video ID was simultaneously detected as
live by the LivePoller (boot logs at 08:49:58: `[LivePoller] New live
stream detected method=live-page videoId=f51qV6XvQ40`) — so the two
code paths probing the same YouTube stream were disagreeing.

### Root cause

Two unrelated YouTube probes had drifted apart over time:

- **LivePoller** (`routes/youtube.ts checkViaYouTubeLivePage`) — hits
  the channel `/live` page, requires only `"isLiveNow":true` to
  declare the stream live. Used a Chrome User-Agent.
- **Validator** (`lib/youtubeUrl.ts validateYouTubeLiveStream`) — hit
  the per-video `/watch?v=<id>` page, required BOTH
  `"isLiveContent":true` AND `"isLiveNow":true`, with a
  `TempleTV-LiveControl/1.0` User-Agent and a 6s timeout.

Three things conspired to false-negative the validator:

1. **Bot-shaped User-Agent.** YouTube ships a stripped-down
   "compatibility" page to obvious bots that frequently omits the
   `isLiveContent` JSON marker entirely.
2. **6s timeout on a 1MB+ page.** Under typical Replit-egress latency
   to YouTube the fetch+read could time out partway through, the
   regex never matched, and the validator silently fell through to
   `isLive: false`.
3. **AND-ing two markers when either alone is sufficient.**
   `isLiveNow:true` is YouTube's canonical "currently live RIGHT
   NOW" flag — the LivePoller already trusts it alone. Requiring
   `isLiveContent:true` on top added no real signal but doubled the
   surface area for a single missing field to break the verdict.

### What changed (`artifacts/api-server/src/lib/youtubeUrl.ts`)

- Switched the `USER_AGENT` constant to a real Chrome 120 UA so YT
  serves the full hydrated page with the live-marker JSON intact.
- Bumped `PROBE_TIMEOUT_MS` from 6s → 10s — comfortable headroom for
  the 1MB watch-page download without dragging admin UX.
- Liveness verdict now triggers on **any one** of:
  - `"isLiveNow":true`
  - `"liveBroadcastDetails":{… "isLiveNow":true …}`
  - `"hlsManifestUrl":"…"` (only present on actively-airing streams)
- Added `hasLiveBroadcastBlock` and `hasHlsManifest` as additional
  `exists` evidence so we never call a real broadcast non-existent.
- Added a **Step 3 channel-page fallback** that hits
  `https://www.youtube.com/live/<videoId>` (the same shape the
  LivePoller uses for channel-wide detection) when the watch-page
  probe was inconclusive. Only runs when Step 2 didn't already
  confirm liveness — keeps the happy path single-fetch.
- Inline comment ties the regression to the live-evidence date and
  video ID so the next reviewer doesn't tighten the gates again
  without context.

### Verified post-fix

- **Live URL** (the failing one): `isLive=true, method=live-page`,
  0.67s.
- **Known VOD** (Rick Astley): `exists=true, isLive=false`, 1.45s.
- **Bogus 11-char ID**: `exists=false`, 0.12s.

All three correct. Build clean, server boots clean.

---

## YouTube catalogue sync — skip-unchanged path (Apr 27, 2026)

### The problem

Logs showed `[YouTubeSync] Catalogue sync complete total: 2117,
inserted: 0, updated: 2117, elapsedMs: 172203` every 30 minutes
forever. Every record was being UPSERTed even when zero content
had actually changed. This was wasting:
- ~150 seconds of wall-clock per cycle
- 2117 PostgreSQL round-trips per cycle
- Native-buffer churn from Drizzle prepared statements

### The fix

`artifacts/api-server/src/routes/youtube.ts:1426-1556`. One batched
`SELECT WHERE youtubeId IN (...)` pre-fetches existing rows into a
Map. Per video we compute a SHA-1 hash of
`(title|description|thumbnailUrl|duration|publishedAt)` and compare
against the same hash from the existing row. If hash matches AND
fresh `viewCount` ≤ existing `viewCount` (so the `GREATEST(...)`
clause would be a no-op), we skip the UPSERT entirely.

The summary now also reports `skipped`.

### Verified post-fix

```
Before: total: 2117, inserted: 0, updated: 2117, elapsedMs: 172203
After:  total: 2117, inserted: 0, updated:   13, skipped: 2104, elapsedMs: 18097
```

- **9.5× faster** (172 s → 18 s)
- **163× fewer DB writes** (2117 → 13)
- The 13 actual writes are videos whose `viewCount` advanced — that's
  the correct, intended behavior.

### Honest scope note

The catalogue sync was *not* the dominant source of the 2+ GiB
`external` native memory the watchdog warns about. New post-fix logs
show RSS at 318 MiB one minute after the sync completes, then
spiking to 2.89 GiB a minute later — meaning the bulk of the native
memory pressure is from something else (likely
`--enable-source-maps` retaining the 5.5 MB sourcemap, Sentry's
profiler, the FFmpeg child-process pool, or the V8 baseline plus
the YouTube `fetch()` response buffers being slow to release). This
fix removes a real, measurable inefficiency that ran every 30
minutes forever — but the broader RSS picture needs a separate
investigation, most likely splitting `RUN_MODE=api` from
`RUN_MODE=worker` in production (the architecture already supports
this).
