---
name: Raw SSE response headers
description: Fastify hijacked streams must preserve approved CORS headers; a successful curl without Origin does not establish browser compatibility.
---

Preserve Fastify's already-approved response headers when starting a hijacked SSE response. Do not implement this by reflecting the request Origin or allowing every origin.

**Why:** Production returned HTTP 200 and valid SSE frames while omitting cross-origin permission for the separately hosted admin panel. The browser repeatedly reconnected despite healthy readiness checks. Raw response writes bypass Fastify's normal header flush.

**How to apply:** Check both an approved and an unapproved Origin at the raw-stream boundary. Verify actual response headers, not just received server frames or health endpoints. Keep stream-specific headers authoritative and remove any stale Content-Length. Treat a reconnect loop as a possible browser policy failure before attributing it to daemon downtime or a memory leak.
