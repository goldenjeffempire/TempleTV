---
name: Daemon REST proxy compression zero-body bug
description: Why valid daemon JSON became an HTTP 200 with Content-Length 0 behind Cloudflare/Render.
---

## Rule

Disable `@fastify/compress` on daemon REST proxy routes that forward pre-serialized payloads. Validate health JSON, then send the validated bytes with explicit framing.

**Why:** Cloudflare advertises gzip/br to the Render origin even when an end client requests identity. Fastify compression on the pre-serialized daemon payload emitted a compressed response with `Content-Length: 0`, so Cloudflare returned a dynamic zero-byte HTTP 200 despite the daemon providing valid ON AIR JSON.

**How to apply:**
- Set `compress: false` on the proxy's REST catch-all routes; SSE and WebSocket paths are separate.
- Keep health responses fail-closed for empty, malformed, or wrong-runtime JSON.
- Regression-test with `Accept-Encoding: gzip`, `br`, and `gzip, br`; each decoded body must be non-empty and valid, with no origin compression.
- A response-byte marker can distinguish healthy upstream bytes from a downstream framing failure during production diagnosis.