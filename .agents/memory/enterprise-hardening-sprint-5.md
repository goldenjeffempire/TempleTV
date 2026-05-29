---
name: Enterprise hardening sprint 5
description: Queue validator false-positives, TV stall watchdog, CDN allowlist expansion, prod-sync ffprobe tuning, admin polling tightening, 3 TypeScript fixes.
---

## Fixes applied

**Queue integrity validator — PLACEHOLDER_DURATION false-positive**
HLS items carry no `duration_secs` themselves (they self-report via the manifest). The validator was warning for items where `duration_secs === PLACEHOLDER_DURATION (1800)` but `hlsMasterUrl` was set. Fix: suppress the warning when `qHlsUrl || vHlsUrl` is set (HLS self-reports) or when `videoSource === "youtube"`. Remaining 2 warnings in dev are legitimate: MP4-only prod-sync items with remote URLs that ffprobe hasn't yet probed.

**Why:** HLS manifest carries accurate duration; ffprobe probing of the MP4 is only needed for non-HLS items.

**TV HlsVideoPlayer — continuous stall watchdog**
Samsung/LG TV browsers sometimes buffer-stall mid-playback without firing any hls.js recovery event. Added `STALL_FAIL_MS=15_000` + `stallTimerRef` + event listeners on `stalled`, `waiting`, `playing`, `timeupdate`, `canplay` — restarts timer on activity, fires `onError` after 15 s of silence. Dependency array: `[activeSlot, hlsUrl]`.

**Why:** TV browser `<video>` element can stall silently; hls.js internal watchdog only fires on HLS-level errors, not mid-segment hang.

**Source resolver CDN allowlist expansion**
Added: Akamai (`.akamaized.net`, `.akamaihd.net`, `.edgekey.net`, `.edgesuite.net`), Fastly (`.fastly.net`, `.fastlylb.net`), JW Player/Wowza (`.jwpcdn.com`, `.jwplatform.com`, `.wowza.com`), Azure Media Services (`.azureedge.net`, `.azurefd.net`, `.streaming.media.azure.net`), Mux (`.mux.com`, `.muxdata.com`), Dailymotion (`dailymotion.com`, `.dmcdn.net`).

**Prod-sync ffprobe timeout + probesize**
Timeout 20 s → 45 s; `-analyzeduration` and `-probesize` 5 000 000 → 20 000 000. Remote MP4 files without faststart (moov at end) require 2 HTTP range requests which can exceed 20 s over cross-continental links for large files.

**Admin polling tightening**
- Dashboard: `engineHealth` 30 s → 10 s / staleTime 25 s → 8 s; `readyz` 30 s → 15 s / 25 s → 12 s; SSE `broadcast-queue-updated` also invalidates `dashboard-engine-health`.
- Broadcast editor (broadcast.tsx): queue 30 s → 15 s (staleTime 10 s), health 30 s → 15 s (staleTime 12 s).
- broadcast-v2 diagnostics stays at 30 s (validator runs every 10 min — 30 s is ample).
- queue-sync-status stays at 60 s (prod-sync cycle is 30 s — 60 s is fine).

**TypeScript fixes (3 errors)**
- `broadcast-v2.tsx`: removed unused `Label` import.
- `diagnostics.tsx`: removed unused `ScanSearch` import.
- `stream-health.tsx`: added `bufferUtilizationPct?: number` to `DiagnosticsAnalytics` interface (field was used in JSX but missing from the type).
