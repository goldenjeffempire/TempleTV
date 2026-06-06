---
name: Orchestrator probe must bypass media-proxy
description: Why server-side probes must call extractRawProbeUrl() to skip the media-proxy wrapper
---

## The rule

`BroadcastOrchestrator.scheduleProactiveProbe()` and `probeCurrentItem()` must call
`this.extractRawProbeUrl(url)` before passing the URL to `probeUrlReachability()`.

`extractRawProbeUrl()` strips any `…/api/v1/media-proxy?url=<encoded>` wrapper and
returns the raw upstream URL so the probe reaches the real origin directly.

**Why:**

Media-proxy uses `redirect: "manual"` as an SSRF guard (it follows the first request
but returns the redirect response body without following redirects to arbitrary IPs).
Production upload URLs (`/api/v1/uploads/…`) redirect to object storage signed URLs.
When the orchestrator probed through media-proxy the redirect was treated as a 403 →
`probeUrlReachability()` returned `false` → item was added to the bad-URL cache →
all prod-sync items were suspended → clients entered RECOVERING_PRIMARY.

**How to apply:**

Any new probe call-site in the orchestrator must use `extractRawProbeUrl()`.
Bad-URL cache stays keyed by the media-proxy URL (what clients see) — only the
actual HTTP probe request must bypass it.

Confirmed root cause June 2026 (dev API probing prod-sync items, all 5 items became
RECOVERING_PRIMARY because 3 prod-sync MP4s have no HLS and redirect on production).
