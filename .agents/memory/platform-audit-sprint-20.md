---
name: Comprehensive platform audit — sprint 20
description: 9 bugs fixed across auth, DB schema, player core, mobile, TV, API — transaction safety, SSRF hardening, clock skew, schema correctness.
---

## Fixes

1. **`changePassword` missing transaction** (`auth.service.ts`) — was `Promise.all([update user, revoke tokens])`. Partial failure left new password with old sessions valid. Fixed: `db.transaction()` wrapping both writes with shared `now = new Date()`.

2. **`forgotPassword` missing transaction** (`auth.service.ts`) — invalidate-old-tokens UPDATE and insert-new-token INSERT were separate awaits. Crash between them left user with no valid reset token. Fixed: wrapped both in `db.transaction()`.

3. **`hls_ready` missing from DB CHECK constraint** (`lib/db/src/schema/videos.ts`) — transcoder writes `transcodingStatus = 'hls_ready'` but the CHECK only listed `'none','queued','encoding','processing','ready','failed'`. Would cause PostgreSQL violations when transcoder runs. Fixed: added `'hls_ready'` to the IN list. Schema pushed.

4. **`playlist_videos` missing unique constraint** (`lib/db/src/schema/playlists.ts`) — no constraint prevented adding the same video to a playlist twice. Fixed: added `uniqueIndex("playlist_videos_playlist_video_uniq_idx").on(t.playlistId, t.videoId)` + service-layer 409 ConflictError check before insert. Schema pushed.

5. **Media proxy SSRF via open redirect** (`media-proxy.routes.ts`) — fetch used default `redirect: "follow"`, allowing a signed CDN URL that redirects to a private IP. Fixed: `redirect: "manual"` + explicit 3xx rejection with WARN log including redirect target host.

6. **Player-core stale-snapshot guard clock skew** (`lib/player-core/src/machine.ts`) — two guards compared `server.current.endsAtMs` to raw `Date.now()` instead of `Date.now() + this.clockOffsetMs`. On devices with >1s NTP drift this could fail to suppress stale snapshots. Fixed: applied `clockOffsetMs` at both guard sites (lines ~448 and ~473).

7. **`useWatchProgress` AsyncStorage side-effect in state updater** (`artifacts/mobile/hooks/useWatchProgress.ts`) — `setProgressMap(prev => { AsyncStorage.setItem(...); return updated; })` is a React anti-pattern (updater may run twice in StrictMode/Concurrent). Fixed: added `progressMapRef` as authoritative in-memory store; writes go directly through the ref, avoiding state updater side effects. All three mutating paths (load, save, clear, clearAll) updated.

8. **`BroadcastLiveCompanion` unused `floats` state** (`artifacts/tv/src/components/BroadcastLiveCompanion.tsx`) — `useState` + `void setFloats` placeholder (broken SSE reaction channel). Fixed: removed state and `void setFloats`; left placeholder comment + `@keyframes tvCompanionFloat` for future re-wire.

9. **Admin login password toggle missing `aria-label`** (`artifacts/admin/src/pages/login.tsx`) — Eye/EyeOff icon button had no accessible label. Fixed: added `aria-label={showPw ? "Hide password" : "Show password"}`.

10. **`pruneExpiredProbeCache` never called** (`prod-queue-sync.ts`) — function defined but TypeScript TS6133 unused-declaration error. Fixed: call `pruneExpiredProbeCache()` inside `done()` before each cache write, bounding the map at `DURATION_PROBE_CACHE_MAX` entries.

## False positives (confirmed correct)
- `Promise.all` at auth.service.ts line 220 — parallel JWT signing (pure crypto, no DB I/O), followed by a proper transaction for DB writes.
- `Date.now()` at machine.ts lines 705/729 — fallback `startsAtMs` for "item has no server timestamp", not a clock-comparison guard; position resolves to 0 correctly.
- `LocalVideoPlayer` load timeout — STALL_FAIL_MS=15s watchdog already exists.

**Why:** These represent transaction atomicity, schema completeness, and clock-correctness disciplines that must be consistent across the codebase.
