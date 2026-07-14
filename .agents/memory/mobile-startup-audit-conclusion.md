---
name: Mobile startup lifecycle deep-audit conclusion
description: Result of a full production audit of the mobile app's cold-start path (July 2026) — what was checked and why no further changes were made.
---

A full-scope audit request ("eliminate all startup crashes — Application.onCreate, Expo init, Hermes,
Fabric, TurboModules, native module registration, navigation/deep-link/auth restoration, zero startup
crashes") was carried out by directly reading the actual startup-path source, not just grepping for
patterns. Files reviewed in full: `index.ts` (true JS entry — polyfills, Sentry init, global error
handlers, gated RNTP registration), `app/_layout.tsx` (splash, fonts, deep-link safety net, notification
tap routing), `context/AuthContext.tsx` (SecureStore restore with keystore-race retry), `context/PlayerContext.tsx`,
`services/nowPlaying.ts`, `services/notifications.native.ts`, all 7 custom Expo config plugins in `plugins/`,
and both custom native Kotlin modules (`expo-in-app-updates`, `expo-pip-android`).

**Conclusion: no new crash-causing gaps were found.** Every classic startup-crash vector (unguarded native
module reads, synchronous throws before Sentry init, JSON.parse without try/catch, missing Android 14/15
manifest attributes, missing foreground-service-type, EMC 3.x suspend-function misuse, keystore boot race,
malformed deep links, killed-app notification-tap routing) already has a defensive fix in place — these were
put there across many prior rounds referenced elsewhere in this memory file (see mobile-player-open-fixes,
nav-phantom-channels-fix, expo-modules-core-coroutine-dsl, android15-edge-to-edge-pip, panresponder-stale-closure,
reanimated-v4-worklets, modern-auto-pip-android, mobile-cache-stale-closure).

**How to apply:** if a *future* "deep startup audit" request comes in, don't re-read every file from scratch —
check this note first, diff against what's changed since, and focus new effort only on genuinely new code paths
(e.g. a native module or plugin added after this date) rather than re-verifying the already-covered surface.
