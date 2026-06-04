---
name: Media-proxy fetch-stream teardown on client disconnect
description: Proxying a fetch web ReadableStream through Fastify must explicitly abort the upstream on client disconnect, or HLS segment aborts leak sockets and log "stream closed prematurely".
---

## The rule

Any route that streams a `fetch()` web `ReadableStream` body to the client (e.g. `media-proxy.routes.ts` sending `upstream.body`) MUST tear the upstream down when the client disconnects mid-stream:

1. Convert to a Node stream you own: `Readable.fromWeb(upstream.body)`.
2. `reply.raw.once("close", teardown)` where `teardown` calls `ctrl.abort()` + `bodyStream.destroy()` **only when `!reply.raw.writableFinished`** (so normal completion is a no-op — `close` fires after `finish` on success).
3. Attach `bodyStream.on("error")` that swallows `AbortError` / `ERR_STREAM_PREMATURE_CLOSE` (normal client aborts) and warns on anything else.

The TTFB `AbortController` (`ctrl`) is cleared (`clearTimeout`) after first byte but the controller stays attached to the fetch — aborting it later still cancels the in-flight body. Reuse that same `ctrl` for the disconnect teardown; do not create a second one.

## Why

HLS players abort segment/MP4 fetches constantly — ABR variant switches (e.g. v0↔v3), seeks, stops, reconnect loops. Without explicit teardown the upstream `fetch` keeps downloading into a body nobody reads: wasted origin/CDN bandwidth, a leaked upstream socket per aborted segment, and Node `ERR_STREAM_PREMATURE_CLOSE` ("stream closed prematurely") logged as an error on every abort. That error noise is the operator-visible symptom; the leak is the hidden cost.

## Scope note (don't over-fix)

The local HLS path (`video-serve.routes.ts` `/hls/:videoId/*`) sends `obj.body` — a **Node** Readable from S3 `getObject`. Fastify's stream pipeline destroys a Node source on premature close, and that route already wires `decrementConcurrent` on `close`. It does NOT need the `Readable.fromWeb` teardown — only the **fetch web-stream** proxy path does. The distinction is web ReadableStream (needs manual teardown) vs Node Readable (Fastify handles it).
