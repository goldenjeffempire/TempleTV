---
name: expo-av to expo-video migration
description: Root-cause fix for ViewUtils ClassCastException + ExoPlayer/Media3 OOM crashes; full removal of deprecated expo-av in favor of expo-video.
---

## Root cause
`expo-av`'s native view-casting bug (`ViewUtils.tryRunWithVideoViewOnUiThread` ClassCastException) and its
looser Media3/ExoPlayer lifecycle management were the source of both the ClassCastException crash cluster
and a class of OOM crashes. expo-av is deprecated upstream (removed in SDK 54+) and the bug is not fixable
from app code — the only durable fix is migrating all playback off expo-av onto `expo-video`.

**Why:** expo-av has no forward path; patching around it just delays the same crash under different triggers.

## expo-video (57.x) confirmed API surface
- `useVideoPlayer(source, setupFn)` creates a `VideoPlayer` (a `SharedObject`). Call it unconditionally
  (Rules of Hooks) — never call it conditionally or per-source; swap sources on the *same* instance instead.
- `player.replaceAsync(source | null)` swaps the media source without allocating a new native player/decoder.
  Passing `null` releases the decoder/buffer memory immediately (use this before permanent unmount or when
  switching to a non-video mode e.g. radio-only).
- `player.play()` / `player.pause()` are synchronous (no `Async` suffix, unlike expo-av).
- `player.currentTime = seconds` is a property assignment for seeking (not a method call).
- Events via `player.addListener(name, handler)` → returns `{ remove() }`. Names: `statusChange`
  (`{status, oldStatus, error}`), `playingChange` (`{isPlaying}`), `timeUpdate` (`{currentTime,
  bufferedPosition}`), `playToEnd` (no payload), `sourceLoad` (`{duration, availableVideoTracks, ...}` —
  expo-video's equivalent of expo-av's `onLoad`), `videoTrackChange`.
- `<VideoView player={p} contentFit="contain"|"cover"|"fill" nativeControls={bool} onFirstFrameRender={fn} />`
  — `contentFit` replaces expo-av's `resizeMode`/`ResizeMode` enum (which no longer exists).
- `SharedObject.release()` exists for manual early release, but **`useVideoPlayer` already auto-releases the
  player in the hook's effect-cleanup phase on unmount** — you generally don't need to call it yourself except
  for early/explicit decoder release while the component is still mounted (e.g. `replaceAsync(null)`).

## Removal checklist (do all of these, not just the two call sites)
1. Migrate every `<Video>`/`useRef<Video>`/`AVPlaybackStatus` call site to the API above.
2. Remove `"expo-av"` from `package.json` dependencies AND from the `expo.doctor.reactNativeDirectoryCheck.exclude` list.
3. Remove the `["expo-av", {...}]` plugin entry from `app.json` plugins array.
4. Remove the `"expo-av@x.y.z": "patches/expo-av@x.y.z.patch"` entry from the root `package.json`
   `patchedDependencies` map AND delete the patch file — otherwise `pnpm install` fails hard with
   `ERR_PNPM_UNUSED_PATCH` the moment the dependency is gone.
5. Re-grep the whole repo for `expo-av`/`ResizeMode`/`AVPlaybackStatus` afterward — comment-only mentions
   (explaining migration history) are fine to leave or update for clarity, but any live import/JSX usage
   means the migration is incomplete.
6. `pnpm install` (regenerates lockfile), then `tsc --noEmit --skipLibCheck` on the affected package — expect
   pre-existing unrelated errors only (vitest/node-types in test files not part of the main tsconfig story).

## Gotcha found during this migration
`LocalVideoPlayer.tsx` was in a broken half-migrated state before this fix: it already imported and set up
`useVideoPlayer`/`VideoView` (expo-video) but its JSX render path still referenced undeclared expo-av
identifiers (`VideoComponent`, `videoRef`, `ResizeMode`, `AVPlaybackStatus`) that existed nowhere else in the
file. This is a real independent bug class — a "half-migrated" component can look done-ish (new hook present)
while the actual render path is unreachable dead code referencing removed symbols. Always check the full
render path compiles, not just that the new hook/import line exists.
