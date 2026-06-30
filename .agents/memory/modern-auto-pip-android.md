---
name: Modern Android auto-PiP (setAutoEnterEnabled)
description: How automatic Picture-in-Picture is wired across the native module, JS wrapper, and hook — and why the custom activity-level PiP is kept instead of a video-library's own PiP.
---

# Modern Android automatic PiP

**Rule:** "YouTube-style" auto-PiP (OS drops the video into a mini-window the
instant Home is pressed) is driven by `setAutoEnterEnabled(true)` +
`setSeamlessResizeEnabled(true)` inside `setPictureInPictureParams`, and is
**API 31+ only**. Below API 31 there is no system auto-enter — you must fall back
to a JS `AppState` `background`/`inactive` listener that calls
`enterPictureInPictureMode()` manually.

**How to apply:**
- Native must guard the `setAutoEnterEnabled` call behind an API>=31 check;
  pre-31 it is a no-op.
- Arm auto-enter in an effect (`updatePipParams(..., autoEnter=true)`) **and
  disarm on cleanup** (`autoEnter=false`). Disarming is critical — otherwise PiP
  can trigger from an unrelated screen after the player unmounts.
- Gate the JS `AppState` manual-enter fallback to `Platform.Version < 31`
  (Android `Platform.Version` is the API integer). On 31+ the native path owns
  auto-enter; a manual call there is only ever a benign redundant request.
- Keep both paths mutually safe with an `!inPip` guard.

**Why custom activity-level PiP (not expo-video's own PiP):**
The custom `expo-pip-android` module calls `Activity.enterPictureInPictureMode()`,
so it renders whatever is on screen into the PiP window **regardless of which
video library is playing** (expo-av, expo-video, a WebView/YouTube iframe, etc.).
If we later migrate players to expo-video, do **not** also enable expo-video's
built-in `allowsPictureInPicture` — two PiP controllers would compete. The
activity-level module stays the single source of PiP truth.

**Manifest:** `android:supportsPictureInPicture="true"` on MainActivity is what
actually enables PiP; the `<uses-feature android:name="android.software.picture_in_picture"
android:required="false"/>` declaration is the best-practice companion (advertises
capability to Play Console without restricting the install base). `configChanges`
must include `screenLayout|screenSize|smallestScreenSize|uiMode` or the activity
is recreated on every PiP enter/exit, destroying playback state.
