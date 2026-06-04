---
name: x264-params deblock delimiter + orphaned ffmpeg-promise crash
description: Why the libx264 -x264-params colon delimiter broke 100% of HLS transcodes under ffmpeg 7.x, and why a long-lived ffmpeg promise must be rejection-guarded
---

# x264-params uses COLON as its option delimiter

Inside ffmpeg's `-x264-params "a=1:b=2:..."`, the colon (`:`) separates options.
So a value that itself needs two sub-values (like libx264 `deblock=alpha:beta`)
MUST use a comma there, not a colon. `deblock=-1:-1` is parsed as `deblock=-1`
plus a stray `-1` token, which makes libx264 reject the ENTIRE param string
("Error setting option x264-params ... Invalid argument") and ffmpeg exits 234
on every job.

**Why it matters:** this broke 100% of HLS transcoding under ffmpeg 7.x. Correct
form is `me=umh:subme=7:direct=auto:deblock=-1,-1` (comma between the deblock
alpha/beta pair, colons between the top-level options).

**How to apply:** any libx264 sub-option that takes a pair (deblock, etc.) must be
comma-separated when embedded in `-x264-params`. Verify a param change by running a
real one-rendition HLS encode and confirming exit 0 + a valid `index.m3u8` + a `.ts`
segment — a `-f null` probe is not enough to catch muxer-stage issues.

# A long-lived ffmpeg promise must be rejection-guarded

In the transcoder, the HLS encode promise is created early but only awaited later
(after `await generateThumbnail(...)` + progressive-uploader setup). If ffmpeg
fails FAST (e.g. an invalid encoder option that exits before encoding), the
rejection lands in that async gap with no handler attached → Node fires
`unhandledRejection` → the process-level handler does `FATAL: unhandledRejection
— exiting`, taking the whole API + broadcast engine down. Because the failed job
stays queued, this is a CRASH LOOP, not a one-off.

**Fix pattern:** attach a no-op `promise.catch(() => {})` immediately after creating
any promise that won't be awaited until after an `await`. `.catch()` returns a NEW
promise, so the original rejection is still observed by the real `await` site (the
360p-fallback / re-throw logic) — the no-op only marks it "handled" so it can never
escalate to a fatal unhandledRejection.

**How to apply:** whenever you create a Promise (especially around `spawn`) and there
is any `await` between its creation and the point you actually await it, add the
no-op catch guard. If a promise is created and awaited in the same expression
(`await new Promise(...)`), no guard is needed.

**Env note:** the transcoder dispatcher is disabled in the Replit dev container via
`TRANSCODER_DISABLE=true` (transcoding is CPU-heavy), so uploads air as faststart
MP4 there and HLS jobs don't run. Verify transcoder changes with a standalone ffmpeg
invocation, not the live dispatcher. The fix takes effect in production where the
dispatcher is enabled.
