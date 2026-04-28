# OOM Diagnosis — Production API, April 28 2026

## Summary

The Render `temple-tv-api` service was hitting the 2 GiB cgroup ceiling and getting
SIGKILL'd by the OOM killer every ~5 minutes. The leak was **not** in the V8 heap
(`heapUsed` stayed around 50–80 MiB the entire time) but in **`arrayBuffers`**,
which climbed monotonically to ~462 MiB before death.

## Evidence

From `/api/admin/ops/status` and the production logs immediately preceding a kill:

```
heapUsed:     54 MB
heapTotal:   123 MB
external:    466 MB
arrayBuffers: 462 MB   ← all the growth lives here
RSS:        ~2.0 GB → SIGKILL
```

The spike correlates exactly with `[YouTubeSync] Warmup complete (totalSeeded: 2117)`
and with each subsequent `pollLiveStatus()` tick. Startup also reported:

```json
{ "runMode": "all", "runsApi": true, "runsWorker": true,
  "hlsTranscoder": { "runsInThisProcess": true } }
```

— meaning the running container was the legacy single-process role even though
`render.yaml` declares `RUN_MODE=api` for `temple-tv-api`. The dashboard env-var
on the actual service was overriding the manifest. (Action item below.)

## Root cause

Two compounding issues in the YouTube live-status / catalogue code paths:

### 1. Unbounded HTTP response bodies

Both `routes/youtube.ts` (the `pollLiveStatus()` ticker) and `lib/youtubeUrl.ts`
(the admin URL validator) call `await response.text()` on YouTube's
`/watch?v=…`, `/@channel/live`, and `/live/<id>` pages. These pages are
**500 KB–1 MB** of inlined `ytInitialPlayerResponse` JSON wrapped in an HTML
shell. Every poll allocates a megabyte of `arrayBuffer` for the response body
even though the regex markers we actually care about (`isLiveNow`, `videoId`,
`hlsManifestUrl`, `concurrentViewers`, `title`) all live in the first ~150 KiB.

With concurrent fetches in the catalogue warm-up plus the 15 s burst-mode
poll cadence after a state change, transient `arrayBuffers` could touch
hundreds of MiB.

### 2. V8 substring-sharing pinning

`String.prototype.match()` in V8 returns a `SlicedString` that shares the
**original 1 MB backing buffer**. When `pollLiveStatus()` extracts a 11-char
`videoId` and stores it in `cachedLiveStatus.videoId` (a module-level variable
that lives forever), V8 keeps the entire 1 MB HTML page alive even though
only those 11 chars are reachable from any GC root. Repeat every 60 s
steady-state and `arrayBuffers` ratchets up monotonically.

The same pattern existed for `title`, returned through `validateLiveStream()`
into long-lived live-override-scheduler state.

### Why it amplifies — single-process role

Production was running `RUN_MODE=all`: API + scheduled YouTube polling +
HLS transcoder + live-event SSE bus + cache GC all in one process. The
YouTube leak alone wasn't necessarily fatal, but adding ffmpeg child stdio
buffers (each transcode adds 100–300 MiB of `external` memory under
`-threads 2`) on top of the `arrayBuffers` ratchet pushed RSS over 2 GiB
every 5–8 minutes. Splitting the worker off (RUN_MODE=api / RUN_MODE=worker)
removes the ffmpeg amplifier but does not fix the underlying leak.

## Fixes applied

### Code (this PR)

1. **New helper `lib/boundedFetch.ts`** with two utilities:
   - `boundedText(response, maxBytes = 256 KiB)` — reads the response body
     via `ReadableStream.getReader()`, stops at `maxBytes`, calls
     `reader.cancel()` to release the upstream socket, and decodes through
     `Buffer.concat(...).toString("utf8")` (which produces a fresh
     `SeqString`, never a `SlicedString`).
   - `freshString(s)` — round-trips through `Buffer` to materialize a
     fresh, independently-backed string. Defeats V8 substring-sharing on
     any `match[1]` result destined for long-lived storage.

2. **`routes/youtube.ts` patches**:
   - `checkViaYouTubeLivePage()`: `response.text()` → `boundedText()`,
     and `videoId` / `title` extracted via `freshString()` so they
     don't pin the backing HTML.
   - `scrapeViewerCount()`: `response.text()` → `boundedText()`.
   - `fetchDirect()` (RSS): `response.text()` → `boundedText()`.

3. **`lib/youtubeUrl.ts` patches**:
   - Both watch-page and `/live/<id>` probes now use `boundedText()`.
   - The watch-page `<meta name="title">` extraction is materialized with
     `Buffer.from(...).toString("utf8")` before being assigned to the
     long-lived `title` variable returned from `validateLiveStream()`.

4. **No API contract changes.** Every existing return shape, status code,
   and cache key is preserved. The cap is set deliberately above the
   ~150 KiB offset of every YouTube marker we test for.

### Operations (action items for the operator)

1. **Verify the Render env override on `temple-tv-api`.** The production
   process is logging `runMode: "all"` despite `render.yaml` declaring
   `RUN_MODE=api` for that service. Either (a) sync the manifest from
   the Render dashboard, or (b) delete the dashboard `RUN_MODE` env-var
   override on `temple-tv-api` so the manifest's `api` value takes
   effect. Keep `temple-tv-transcoder` at `RUN_MODE=worker`.

2. **Replit Deployments alternative.** `.replit` is now configured for
   an `autoscale` deployment of the API role with the same memory
   hardening as Render:
   - `MALLOC_ARENA_MAX=2` (glibc fragmentation cap)
   - `--max-old-space-size=1280` (V8 heap cap = 1.25 GiB, leaves ~700 MiB
     for `external` memory under the autoscale 2 GiB tier)
   - `MEMORY_WARN_RSS_MB=1500` (75 % WARN line before OOM)
   - `RUN_MODE=api` (no transcoder in this process)

   Click **Publish** in Replit to deploy. Choose the **2 vCPU / 2 GiB**
   autoscale tier. The API will run on `*.replit.app` (or your custom
   domain). Keep the existing Render `temple-tv-transcoder` worker
   running for HLS transcoding — Replit's `autoscale` target is
   stateless-HTTP-only, so the worker stays on Render until/unless we
   add a separate Replit Reserved-VM deployment for it.

## Validation

- Local typecheck: clean (`pnpm --filter @workspace/api-server run typecheck`).
- Workflow restart: clean boot, `arrayBuffersMb: 4` at idle.
- Cap rationale: 256 KiB is 1.7× the largest observed marker offset in
  production captures of the YouTube live page, with comfortable headroom
  for layout drift.

## Defence in depth

The existing `MEMORY_RESTART_RSS_MB` setting in the production env
(disabled in render.yaml since the 2026-04-27 rolling-restart incident,
deliberately) can be re-enabled at e.g. `1700` once the leak fix is
verified in production for 24 h — it would catch any future leak class
with a graceful drain instead of an uncatchable SIGKILL. Kept disabled
for now to avoid masking the diagnostic signal of the underlying fix.
