---
name: Orchestrator reachability probe HEAD→GET fallback
description: Why broadcast-orchestrator probeUrlReachability must fall back to ranged GET on HEAD 4xx, and why the GET body must be cancelled
---

# Orchestrator reachability probe must not trust HEAD alone

`probeUrlReachability()` in `broadcast-orchestrator.ts` decides whether a queue
item's media URL is healthy enough to stay in the live rotation. Returning `false`
**drops the item from the broadcast**, so a false negative = healthy content
pulled off air.

## Rule
For non-HLS sources the probe must do `HEAD (Range bytes=0-0)` first, and on a
**4xx** HEAD fall back to a **ranged GET (bytes=0-1023)** before concluding the URL
is bad. Only `false` when BOTH HEAD and GET are 4xx. `5xx`/timeout/network →
`null` (ambiguous, never drops content). HLS path is unchanged: GET + `#EXTM3U`
body check (HEAD can't validate manifest content).

**Why:** Many origins/proxies/CDNs reject HEAD (404/405/403) but serve GET 200 —
including Replit's own public media-proxy URL (confirmed HEAD 404 / GET 200). A
HEAD-only probe falsely marks such healthy large MP4s bad and yanks them off the
24/7 broadcast. The media-integrity-scanner already had this fallback; the
orchestrator's proactive/current-item probe did not, so they disagreed.

## The GET body MUST be cancelled
The shared `fetchProbeStatus(url, method, range)` helper must call
`await res.body?.cancel()` (try/catch, GET only) right after reading the status.
**Why:** some origins ignore the `Range` header and reply `200` with the *full*
payload — for a multi-GB MP4 a "cheap probe" would otherwise keep streaming the
whole file. The scanner does the same cancel; keep them mirrored.

## How to apply
Any new reachability/liveness probe for broadcast media: never HEAD-only for
content that decides air/no-air; always GET-fallback on 4xx; always cancel the GET
body; reserve `false` for genuine 4xx on both verbs and keep 5xx/timeout as
ambiguous `null`.
