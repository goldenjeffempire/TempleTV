---
name: HLS.js buffer tuning for 24/7 broadcast TV
description: Correct buffer sizes for Tizen/webOS long-session stability; rationale for backBufferLength=0 on TV.
---

## Rule
For all broadcast TV HLS.js instances (HlsVideoPlayer, LiveBroadcastV2), use:
- `maxBufferLength: 30` (not 60)
- `backBufferLength: 0` (not 60/90)
- `maxMaxBufferLength: 60` (not 120)

For admin preview only, keep `backBufferLength: 30` (operators scrub back to review).

**Why:** Samsung Tizen / LG webOS keep YUV texture data in GPU memory proportional
to buffered segment count. 60 s forward + 90 s back = ~75 segments × ~300 KB =
~22 MB of VRAM permanently occupied, growing as long as the tab is open. After
6–8 hours of continuous 24/7 broadcast this causes progressive frame drops and
eventual compositor OOM. 30 s forward is ample for smooth broadcast replay;
backBufferLength=0 on TV is safe because broadcast content is never seeked backward.

**How to apply:** Whenever a new HLS.js instance is created for a TV/broadcast surface,
start from these numbers. Only increase if a specific rebuffer regression is observed.
