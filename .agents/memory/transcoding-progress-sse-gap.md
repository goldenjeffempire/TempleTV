---
name: transcoding-progress SSE emission gap
description: The onProgress callback in transcoder.dispatcher.ts must emit the SSE event — DB update alone is not enough.
---

## The Rule

In `transcoder.dispatcher.ts`, the `onProgress` callback that runs every 5 seconds during FFmpeg encoding **must** call:

```ts
adminEventBus.push("transcoding-progress", {
  videoId: job.videoId,
  jobId: job.id,
  progress: pct,       // matches sse-context.tsx summarize() case: d.progress
  videoTitle,          // matches sse-context.tsx summarize() case: d.videoTitle
});
```

Without this, the DB `transcoding_percent` column is updated (for polling consumers) but no SSE event fires. The admin Library page (`videos.tsx`) and Master Control page (`broadcast-v2.tsx`) both subscribe to `"transcoding-progress"` and rely on it to drive real-time progress bars.

## Field names

`summarize()` in `sse-context.tsx` reads `d.progress` and `d.videoTitle` — the field names must match exactly.

**Why:** The DB update is throttled to every 5s and visible only on next polling cycle (which is suppressed to 60s while SSE is connected). Without the push, the progress bar is frozen for the operator until the transcoding job completes.

**How to apply:** Any refactor of `runHlsTranscode` or the progress-reporting loop must preserve the `adminEventBus.push("transcoding-progress", ...)` call inside `onProgress`.
