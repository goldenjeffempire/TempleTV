# Offline broadcast recordings

## Scope and policy

Offline playback means a complete saved **recording**, never a live stream.
Only first-party app-hosted MP4/M4V/MOV assets served by this API are eligible.
YouTube, HLS/DASH manifests, arbitrary third-party media, and DRM providers are
not download sources. The public catalog is not changed to expose uploads.
The live player can offer a download for its current managed recording.

The current authorization policy is for public recordings only. Access is
rechecked when connectivity returns (at most once an hour per completed copy),
with a **7-day offline access window**. An expired copy needs an online renewal.
This is an app-level policy, not DRM: it cannot enforce instantaneous remote
revocation on a disconnected or modified device. Do not apply it to paid/private
content without an authenticated entitlement and an appropriate license design.

## Data and integrity

- `GET /api/videos/:id/offline` returns an approved first-party source, authoritative
  byte length, recording metadata, and a server SHA-256 when available. Responses
  are not cached; the route has a per-client rate limit.
- Older uploads do not all have server checksums. Their first download relies on
  HTTPS and the exact server byte length, then records a local SHA-256. Where the
  server supplies a checksum, the first transfer must match it as well.
- Downloaded bytes are streamed by Expo FileSystem into an app-private `.part`
  file. Hashing uses a native file handle with bounded 1 MiB reads and incremental
  SHA-256; the whole movie is never converted to base64 or loaded into JavaScript.
- Promotion to the final file happens only after integrity verification.
  Playback checks the saved size and SHA-256 again without an API request.
- A file hash detects incomplete transfers and later local corruption; a locally
  established hash does not prove that a legacy source was valid before upload.
  The existing server asset-validation gates still apply.
- Ordered AsyncStorage writes preserve the queue and bookmarks. Final recording
  paths are derived from validated IDs, not from arbitrary saved file paths.
- Cached artwork is optional, size-limited, and time-limited. A bundled placeholder
  is used when artwork cannot be cached; the offline library never needs remote
  images to render.

Full-file hashing is intentionally not added to the API request path. This
deployment's memory-constrained API also serves broadcast media, so unrelated
downloads must not trigger unbounded blob reads or expensive integrity scans.

## Lifecycle

Two downloads can run concurrently. Progress notifications are limited to four
per second per file. Low-storage checks retain a 32 MiB reserve. Cancellation
fences late completion callbacks before removing metadata and files.

Connectivity loss and app backgrounding park transfers. Native pause checkpoints
are persisted before releasing a queue slot. Foreground/reconnection resumes
automatically parked transfers but not manually paused transfers. Temporary
failures use bounded exponential retries; permanent rejection and storage failure
are surfaced to the user. Expo's Android legacy HTTP client has 60-second connect
and read timeouts. A force-close without a native checkpoint may require restarting
that partial transfer rather than resuming it. Partial files are never playable.

On startup, completed copies are checked for existence and byte length, interrupted
work is parked, and abandoned temporary files are removed. Unknown completed files
are not silently deleted. A crash after file promotion can recover the verified
copy on its next online authorization without downloading it again.

The separate `/offline-player` route has no live session, viewer-tracking hook,
or authorization fetch. It uses the existing Expo Video player with local controls.
It saves a bookmark every five seconds and on background/exit. Backgrounding
unmounts its video surface. The live player yields its video surface and viewer
lease if retained underneath this route in the navigation stack.

Connectivity recovery does not force the recording back to live playback. The
screen remains labeled **SAVED RECORDING · NOT LIVE**.

## Verification and release gates

Automated engine tests cover queue deduplication, integrity checks, corrupted
copies, cancellation, concurrent transfers, low storage, pause/reconnect,
background/foreground, app restart, expiry, backend rejection, and local playback
without authorization requests. Backend policy tests cover provider exclusion,
unsafe paths, terminal assets, and malformed checksum metadata.

Browser checks can validate navigation and failure messages only. Web deliberately
does not emulate native downloads or pretend to support native filesystem playback.
An Android JavaScript export is also not an installed-device test.

Before describing this feature as production-validated:

1. Deploy the matching backend endpoint to the intended test API.
2. Install the resulting production-compatible Android build on supported devices.
3. Save an authorized recording, fully close the app, enable airplane mode, reopen
   Offline Broadcasts, and verify playback, pause, seek, bookmark restoration and
   deletion without an API connection.
4. Interrupt a large transfer with Wi-Fi/mobile-data changes and force-close/reboot.
   Verify safe recovery, explicit manual pause behavior, and no duplicate transfer.
5. Reconnect after an API restart, including while verifying and while canceling.
   Verify recording access and metadata recovery without duplicate work.
6. Test exhausted storage and file corruption. Neither may produce a playable
   “Downloaded” entry.
7. Confirm the original live broadcast still plays and offline playback never
   adds a live viewer lease in either mobile or admin statistics.
8. Check low-memory Android, tablet/TV/device compatibility, and app-update
   preservation using the signed release, not Expo Web or Expo Go.

These native acceptance gates must remain explicitly open until actually run.
