---
name: Mobile Android 15 keyboard mode audit
description: Findings from the mobile app production audit targeting Android 15 / targetSdk 35 compliance, PiP, and crash rate.
---

## Rule
`softwareKeyboardLayoutMode` in `app.json` must be `"unspecified"`, NOT `"resize"`.

**Why:** `adjustResize` is deprecated with Android 15 edge-to-edge enforcement (targetSdk 35). The OS silently ignores it under edge-to-edge, and Play Console flags it as a deprecated API warning. `react-native-keyboard-controller` (already in use via `KeyboardProvider` in `_layout.tsx`) manages keyboard insets via `WindowInsetsAnimation` — it requires `adjustUnspecified` to function correctly.

**How to apply:** Any time targetSdk or edge-to-edge configuration is touched, verify `softwareKeyboardLayoutMode: "unspecified"` remains in `app.json`. MiniPlayer.tsx comment at the keyboard-avoidance section explains the Android side is handled by keyboard-controller, not the layout engine.

## Other audit findings (all green)
- Edge-to-edge plugin strategy: `with-enable-edge-to-edge.js` + `with-edge-to-edge.js` + `with-android-activity-flags.js` are coherent and correct for API 35/36.
- `with-predictive-back.js`: `android:enableOnBackInvokedCallback="true"` correctly set on `<application>` — covers all Activities including Play Core dialogs.
- `with-foreground-service-type.js`: `mediaPlayback` foreground service type correctly enforced on MusicService for Android 14 (targetSdk 34+) compliance.
- `usePictureInPicture.ts`: API 31+ auto-enter, fallback for <31, proper disarm on cleanup — production-safe.
- `V2PlayerContainer.tsx`: all watchdog timers cleared on unmount, midnight-prayers singleton torn down when last listener detaches, PiP buffer-swap refresh guard in place, YouTubeInPip exit guard covers both entry orderings.
- Audio session coordination via `waitForAudioSession()` + `lib/audio-session.ts` is correct and prevents the iOS "audio session already active" race on cold-start deep-links.
- `index.ts` startup hardening: `AbortSignal.timeout` polyfill, guarded RNTP load, global fatal handler — correct.
