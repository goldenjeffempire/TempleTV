---
name: Expo preview startup capture
description: Why an initial blank Expo web screenshot does not establish that the app failed to render.
---

An Expo preview screenshot can capture a white page before the font-loading gate finishes, even when Metro compiled successfully and the app finishes initialization shortly afterward.

**Why:** The capture browser recorded only layout mounting before taking its image; subsequent workflow logs showed providers ready, fonts loaded, splash hidden, and authentication restored around 1.7 seconds after startup. Repeating the screenshot recreated the same early capture.

**How to apply:** Check startup completion logs before diagnosing a blank capture as a rendering regression. Do not repeatedly take fresh screenshots expecting them to retain the previous browser's initialized state. Use a browser that waits for readiness when visual verification is necessary, and use an actual Android build/device for native window or bitmap behavior. A successful Metro bundle or TypeScript check does not validate native compilation.
