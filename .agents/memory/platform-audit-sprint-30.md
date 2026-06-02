---
name: Comprehensive platform audit — sprint 30
description: 9 bugs fixed across API, broadcast engine, auth, admin frontend, player-core; 10 false positives documented.
---

## Bugs fixed

1. **media-uploads.routes.ts — void .catch() crash risk**: `void markDbSessionCompleted()` and `void invalidateVideosCatalogCache()` had no `.catch()`. Unhandled rejections crash Node ≥15. Fixed: replaced `void` with explicit `.catch((e) => req.log.warn(...))`.

2. **broadcast-orchestrator.ts — autoSkipAttempts not reset after allBlocked TTL**: After `allBlockedSinceMs` expires and `clearAllBadUrls()` fires, `autoSkipAttempts` stayed at 5 (its cap). The next BAD_URL_TTL cycle couldn't attempt any skips for queues > 5 items, leaving the channel in permanent dead air. Fixed: `this.autoSkipAttempts = 0` added after `this.allBlockedSinceMs = null` in the TTL-expiry branch.

3. **broadcast-orchestrator.ts — HEAD probe for HLS .m3u8 returns 200 for empty manifests**: `probeUrlReachability()` used `method: "HEAD"` for all URLs. CDN edge nodes return HTTP 200 on HEAD even for empty/invalid `.m3u8` manifests, causing dead HLS streams to pass the pre-air filter. Fixed: for URLs matching `/\.m3u8(?:$|\?|#)/i`, use `method: "GET"` and validate `text.trimStart().startsWith("#EXTM3U")`.

4. **App.tsx — top-level ErrorBoundary crashes entire dashboard**: A runtime error in any lazy page destroyed the sidebar/layout too (one global boundary wrapping everything). Fixed: added a second `<ErrorBoundary>` wrapping only `<Suspense><Switch>` inside `AuthenticatedApp`. Page crashes now show the error UI in the content area while the sidebar stays intact.

5. **midnight-prayers.tsx — `queueData?.videos.length` null crash**: Optional chaining stopped at `queueData?` but `.videos.length` could still throw if the API returned `{videos: null}`. Fixed: `queueData?.videos?.length`.

6. **live-monitor.tsx — `data!.` non-null assertions**: `data!.viewersByPlatform` and `data!.bitrateLadder` inside ternary guards. Replaced with `data?.viewersByPlatform?.` and `data?.bitrateLadder?.`.

7. **launch-readiness.tsx — `summary!.`, `counts!.`, `categories!.` non-null assertions**: Destructured from `data ?? {}` so TypeScript typed them as possibly-undefined. Inside the `data && ...` JSX block they're safe at runtime, but assertions are a trap if the block logic changes. Fixed: optional chaining with `?? 0` / `?? []` fallbacks.

8. **player-core react.ts janitor — machine.destroy() not called on eviction**: Janitor called `machineUnsub()` and `transport.stop()` but not `machine.destroy()`. `PlayerMachine` has `sourceExpiryTimer` and `fatalRecoveryTimer` that keep the event loop alive after eviction. Fixed: `entry.session.machine.destroy()` called first in the eviction block.

9. **brute-force-guard.ts — GC Map grows unbounded (slow-drip attacker)**: GC timer checked `v.failTimes.every(t => now - t > windowMs)` without first pruning `failTimes`. A slow-drip attacker (one fail per window interval) always kept one fresh entry → condition never true → Map grows to O(distinct IPs). Fixed: prune `v.failTimes = v.failTimes.filter(t => now - t <= windowMs)` before the length check.

## Confirmed false positives

- **ws.gateway.ts WS resume desync** — listener IS restored after both try and catch paths (code after try/catch always runs).
- **transcoder.service.ts CODECS orphan segments** — already-uploaded segments get overwritten on retry (same videoId path); dispatcher periodic watchdog handles stale `processing` rows.
- **RadioStreamContext.tsx audio leak** — line 323 `if (cancelled) await sound.unloadAsync()` already handles unmount-during-createAsync.
- **useChat.ts orphan WS** — effect cleanup at line 64–66 already calls `client.stop()`.
- **stale `processing` transcoding rows** — dispatcher already resets on startup (line 210) and via periodic watchdog (line 390).
- **mobile player.tsx router.back()** — already guarded with `if (router.canGoBack()) router.back(); else router.replace("/")`.
- **broadcast.tsx swallowed reload** — `.catch(() => {})` is intentional (reload is best-effort optimization after add/remove).
- **mobile _layout.tsx malformed deep-link** — `new URL()` already wrapped in try/catch on both cold-start and foreground paths.
- **mobile _layout.tsx push token null gap** — no push-token null handling gap found.
- **diagnostics.tsx non-null assertions** — no non-null assertions found (false positive from audit).

## Key patterns

- `void somePromise()` without `.catch()` = unhandled rejection = process crash in Node ≥15. Always use `.catch()` on fire-and-forget async calls.
- ErrorBoundary at the app root is correct for catastrophic failures, but add a second boundary at the content area so page crashes don't destroy the shell layout.
- GC timers that check array contents must prune first to avoid unbounded Map growth with slow-drip inputs.
- Janitor/eviction code must call `destroy()` on stateful objects with internal timers, not just unsubscribe.
- `probeUrlReachability` HEAD → GET for `.m3u8`: CDN HEAD=200 ≠ valid manifest content.
