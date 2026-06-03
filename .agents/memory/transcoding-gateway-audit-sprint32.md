---
name: Transcoding/gateway audit sprint 32
description: 3 confirmed bugs fixed across CODECS injection, faststart status guard, and SSE replay buffer.
---

## Bug 1 — CODECS profile mismatch for 720p/1080p

**File**: `artifacts/api-server/src/modules/transcoder/transcoder.service.ts`

`h264CodecStr` hardcoded Main profile (`avc1.4D40XX`) for ALL renditions, but 720p/1080p are encoded with `-profile:v high`. High profile CODECS string is `avc1.6400XX` (0x64 = 100 = High, no constraints).

**Fix**: `h264CodecStr(level, profile)` — `profile` param; if `"high"` returns `avc1.6400XX`, else `avc1.4D40XX`. Profile derived from `rendition.height >= 720 ? "high" : "main"` in the render loop — mirrors the FFmpeg encoder arg at line 144.

**Why**: Samsung Tizen 2.x/3.x and strict ExoPlayer builds use the CODECS attribute to select hardware decoder. Wrong profile → software fallback or black screen for 720p/1080p content.

## Bug 2 — Faststart can overwrite `encoding` → `ready`

**File**: `artifacts/api-server/src/modules/transcoder/faststart.service.ts`

Success path WHERE guard (line 410): `ne(transcodingStatus, "hls_ready")` — missing `ne(transcodingStatus, "encoding")`.
Failure restore path (line 494): same gap.

Scenario: large file → faststart slow → admin triggers HLS → HLS sets `encoding` → faststart finishes last → writes `ready` over `encoding` → dispatcher watchdog confused.

**Fix**: Both WHERE clauses now include `ne(videos.transcodingStatus, "encoding")` alongside the existing `ne(videos.transcodingStatus, "hls_ready")`.

## Bug 3 — SSE gateway missing frameQueue buffer during replay

**File**: `artifacts/api-server/src/modules/broadcast-v2/io/sse.gateway.ts`

WS gateway correctly buffers live frames during async `replayFrom` (lines 156-194 of ws.gateway.ts) so no events are lost between replay completion and live subscription. SSE gateway had no such buffer — frames emitted during the DB await were silently dropped.

**Fix**: SSE gateway now registers a `bufferFrame` listener BEFORE the `replayFrom` await, flushes buffered frames after replay completes, then switches to the live `onFrame` listener. Identical pattern to the WS gateway.

## False positives confirmed (do NOT re-investigate)

- YouTube RSS overwrites duration → ALREADY FIXED via `CASE WHEN excluded.duration = ''` in upsert
- Orphaned HLS after video delete → ALREADY HANDLED via `deleteByPrefix("transcoded/${id}/")` in admin-videos.routes.ts:431
- Assembly retry permanently blocked → FALSE POSITIVE: completedVideoId cleared at lines 1168-1171 on failure
- Audio probe defaults false on timeout → INTENTIONAL: safer than FFmpeg crash on no-audio input
