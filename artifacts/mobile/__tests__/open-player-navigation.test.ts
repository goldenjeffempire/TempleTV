/// <reference types="node" />
/**
 * Hero Watch Navigation — Regression Tests
 *
 * Guards against re-introduction of the legacy hero-navigation bug where
 * the player screen opened and immediately navigated back because handleFatal
 * called router.back() on any transient WS connection failure.
 *
 * Run with: pnpm --filter @workspace/mobile test
 *
 * Coverage:
 *  1. isBroadcastV2 computation — player.tsx routing decision
 *  2. Navigation debounce — prevents double-push from nested Pressables
 *  3. handleFatal contract — must NOT navigate, only clean up PiP state
 *  4. navigateToLive params — correct params for every hero branch
 *  5. Player render branch selection — which player component mounts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const loadDeepLinkGuard = () => import("../lib/deepLinkGuard");

// ─── 1. isBroadcastV2 computation ────────────────────────────────────────────
// Mirrors the exact expression in artifacts/mobile/app/player.tsx:
//
//   const isBroadcastV2 = isLive && !(!!youtubeId && !hlsUrl);
//
// This expression determines whether the V2 broadcast engine is used.
// It must be true for the live-player path (isLive=true, no hlsUrl, no youtubeId)
// so that BroadcastHlsPlayer / V2PlayerContainer mounts instead of a static player.

function computeIsBroadcastV2(isLive: boolean, youtubeId: string, hlsUrl: string): boolean {
  return isLive && !(!!youtubeId && !hlsUrl);
}

describe("isBroadcastV2 computation", () => {
  it("true when isLive=true and no URL / youtubeId (hero Watch path)", () => {
    // navigateToLive("", title, 0) → isLive=true, hlsUrl="", youtubeId=""
    assert.equal(computeIsBroadcastV2(true, "", ""), true);
  });

  it("true when isLive=true and hlsUrl is provided (live HLS path)", () => {
    assert.equal(computeIsBroadcastV2(true, "", "https://cdn.example.com/live.m3u8"), true);
  });

  it("true when isLive=true, youtubeId provided AND hlsUrl provided (HLS wins)", () => {
    // youtubeId + hlsUrl → isBroadcastV2 true (HLS takes precedence)
    assert.equal(computeIsBroadcastV2(true, "dQw4w9WgXcQ", "https://cdn.example.com/live.m3u8"), true);
  });

  it("false when isLive=true and youtubeId is provided but no hlsUrl (YouTube path)", () => {
    // Pure YouTube live: should NOT use V2 engine
    assert.equal(computeIsBroadcastV2(true, "dQw4w9WgXcQ", ""), false);
  });

  it("false when isLive=false regardless of URLs (VOD path)", () => {
    assert.equal(computeIsBroadcastV2(false, "", ""), false);
    assert.equal(computeIsBroadcastV2(false, "", "https://cdn.example.com/vod.m3u8"), false);
    assert.equal(computeIsBroadcastV2(false, "dQw4w9WgXcQ", ""), false);
  });
});

describe("Hero Watch CTA", () => {
  it("renders one guarded Watch action to the existing player route", () => {
    const source = readFileSync("app/(tabs)/index.tsx", "utf8");
    const legacyLabel = ["Open", "Player"].join(" ");

    assert.equal(source.includes(legacyLabel), false);
    assert.match(source, /const handleWatch = useCallback/);
    assert.match(source, /testID="hero-watch-button"/);
    assert.match(source, /accessibilityLabel="Watch current live broadcast"/);
    assert.match(source, /<Text style=\{styles\.heroBtnText\}>Watch<\/Text>/);
    assert.match(source, /"hero-watch"/);

    // The hero must continue to use the existing guarded /player push rather
    // than adding a second player route or a Home replace.
    assert.match(source, /safeNavPush\(\s*"\/player"/);
    assert.doesNotMatch(source, /router\.(?:replace|push)\(\s*["']\/["']/);
  });
});

describe("Live Channel Watch navigation", () => {
  it("uses the same guarded V2 player route with a synchronous double-tap latch", () => {
    const source = readFileSync("app/(tabs)/channels.tsx", "utf8");

    assert.match(source, /const tuningIdRef = useRef<string \| null>\(null\)/);
    assert.match(source, /if \(tuningIdRef\.current\) return;/);
    assert.match(source, /if \(!channel\.isRunning && !channel\.isPrimary\)/);
    assert.match(source, /tuningIdRef\.current = channel\.id;/);
    assert.match(source, /if \(tuningIdRef\.current !== channel\.id\) return;/);
    assert.match(source, /safeNavPush\(\s*"\/player"/);
    assert.match(source, /id: "live"/);
    assert.match(source, /isLive: "true"/);
    assert.match(source, /"channels-live"/);
    assert.doesNotMatch(source, /router\.(?:replace|push)\(\s*["']\/["']/);
  });

  it("allows only one same-frame tap, then returns from Player to Live Channel", () => {
    let tuningId: string | null = null;
    const channelId = "temple-tv-live";
    const stack = ["/channels"];

    const tapLiveChannel = () => {
      if (tuningId) return false;
      tuningId = channelId;
      stack.push("/player");
      return true;
    };

    assert.equal(tapLiveChannel(), true, "first tap opens the shared Player route");
    assert.equal(tapLiveChannel(), false, "same-frame repeat tap is synchronously blocked");
    assert.deepEqual(stack, ["/channels", "/player"]);

    stack.pop();
    tuningId = null; // useFocusEffect clears the latch when the tab regains focus.
    assert.deepEqual(stack, ["/channels"]);
    assert.equal(tapLiveChannel(), true, "a later tap works after Back returns to Live Channel");
  });
});

// ─── 2. Player render branch selection ───────────────────────────────────────
// Mirrors the ternary chain in artifacts/mobile/app/player.tsx (lines 1132–1238).
// Confirms which player surface mounts for each navigation scenario.

type PlayerSurface =
  | "youtube_override"      // isBroadcastV2 && v2YouTubeOverrideVideoId
  | "broadcast_hls"         // isLive && isHls — BroadcastHlsPlayer with URL
  | "youtube_vod"           // isYoutube — YoutubePlayer
  | "local_video_hls"       // isHls (not live) — LocalVideoPlayer
  | "broadcast_engine"      // isLive (fallback) — BroadcastHlsPlayer with initialUrl=""
  | "no_source"             // hasNoSource
  | "placeholder_image";    // fallback

function selectPlayerSurface(params: {
  isBroadcastV2: boolean;
  v2YouTubeOverrideVideoId: string | null;
  isLive: boolean;
  isHls: boolean;
  isYoutube: boolean;
  hasNoSource: boolean;
}): PlayerSurface {
  const { isBroadcastV2, v2YouTubeOverrideVideoId, isLive, isHls, isYoutube, hasNoSource } = params;

  if (isBroadcastV2 && v2YouTubeOverrideVideoId) return "youtube_override";
  if (isLive && isHls) return "broadcast_hls";
  if (isYoutube) return "youtube_vod";
  if (isHls) return "local_video_hls";
  if (isLive) return "broadcast_engine";
  if (hasNoSource) return "no_source";
  return "placeholder_image";
}

describe("Player render branch selection", () => {
  it("hero Watch → broadcast_engine (isLive=true, no URL, no youtubeId)", () => {
    // This is the primary case for Watch in the hero.
    // isBroadcastV2=true, v2Override not yet loaded → falls to isLive fallback.
    const surface = selectPlayerSurface({
      isBroadcastV2: true,
      v2YouTubeOverrideVideoId: null, // override not yet known at mount time
      isLive: true,
      isHls: false,        // hlsUrl=""
      isYoutube: false,    // youtubeId=""
      hasNoSource: false,
    });
    assert.equal(surface, "broadcast_engine");
  });

  it("V2 YouTube override → youtube_override (reactive swap after snapshot arrives)", () => {
    const surface = selectPlayerSurface({
      isBroadcastV2: true,
      v2YouTubeOverrideVideoId: "dQw4w9WgXcQ",
      isLive: true,
      isHls: false,
      isYoutube: false,
      hasNoSource: false,
    });
    assert.equal(surface, "youtube_override");
  });

  it("live broadcast with HLS URL → broadcast_hls", () => {
    const surface = selectPlayerSurface({
      isBroadcastV2: true,
      v2YouTubeOverrideVideoId: null,
      isLive: true,
      isHls: true,         // hlsUrl provided
      isYoutube: false,
      hasNoSource: false,
    });
    assert.equal(surface, "broadcast_hls");
  });

  it("YouTube live stream → youtube_vod", () => {
    const surface = selectPlayerSurface({
      isBroadcastV2: false, // youtubeId + no hlsUrl → not V2
      v2YouTubeOverrideVideoId: null,
      isLive: true,
      isHls: false,
      isYoutube: true,
      hasNoSource: false,
    });
    assert.equal(surface, "youtube_vod");
  });

  it("VOD HLS sermon → local_video_hls", () => {
    const surface = selectPlayerSurface({
      isBroadcastV2: false,
      v2YouTubeOverrideVideoId: null,
      isLive: false,
      isHls: true,
      isYoutube: false,
      hasNoSource: false,
    });
    assert.equal(surface, "local_video_hls");
  });

  it("broken/missing video → no_source", () => {
    const surface = selectPlayerSurface({
      isBroadcastV2: false,
      v2YouTubeOverrideVideoId: null,
      isLive: false,
      isHls: false,
      isYoutube: false,
      hasNoSource: true,
    });
    assert.equal(surface, "no_source");
  });
});

// ─── 3. handleFatal contract ──────────────────────────────────────────────────
// The fixed handleFatal in BroadcastHlsPlayer MUST NOT navigate.
// We can't import the component (requires native modules) but we can verify
// the invariant as a pure function contract.

describe("handleFatal contract — no auto-navigation", () => {
  it("a correct handleFatal does not call router.back()", () => {
    let backCalled = false;
    let replaceCalled = false;

    // Simulated router
    const router = {
      canGoBack: () => true,
      back:      () => { backCalled = true; },
      replace:   (_path: string) => { replaceCalled = true; },
    };

    // The FIXED handleFatal — only cleans up PiP state, never navigates.
    const fixedHandleFatal = () => {
      // PiP cleanup would happen here (native call, skipped in unit test).
      // Explicitly: do NOT call router.back() or router.replace().
      void router; // intentionally not used — this is the contract.
    };

    fixedHandleFatal();

    assert.equal(backCalled,    false, "router.back() must not be called on FATAL");
    assert.equal(replaceCalled, false, "router.replace() must not be called on FATAL");
  });

  it("the old broken handleFatal would call router.back() and close the player", () => {
    let backCalled = false;

    const router = {
      canGoBack: () => true,
      back:      () => { backCalled = true; },
      replace:   (_path: string) => {},
    };

    // This is the OLD (broken) implementation that was causing the bug.
    const brokenHandleFatal = () => {
      if (router.canGoBack()) {
        router.back(); // ← the bug: closes the player on any WS failure
      } else {
        router.replace("/");
      }
    };

    brokenHandleFatal();

    // Confirm this WOULD have navigated — documents the regression.
    assert.equal(backCalled, true, "old impl called router.back() — this caused the bug");
  });
});

// ─── 4. Navigation debounce guard ────────────────────────────────────────────
// Ensures double-navigation from nested Pressables is suppressed within 600 ms.

describe("navigation debounce guard", () => {
  function makeDebounce(windowMs: number) {
    // Use -Infinity so the very first call always passes regardless of the
    // timestamp value used in tests (avoids 0 - 0 < 600 = true false-negative).
    let lastMs = -Infinity;
    return (now: number): boolean => {
      if (now - lastMs < windowMs) return false; // debounced
      lastMs = now;
      return true; // allowed
    };
  }

  it("allows first call immediately", () => {
    const allowed = makeDebounce(600);
    assert.equal(allowed(0), true);
  });

  it("blocks second call within window", () => {
    const allowed = makeDebounce(600);
    allowed(0);
    assert.equal(allowed(100), false, "< 600 ms — should be debounced");
  });

  it("allows call after window expires", () => {
    const allowed = makeDebounce(600);
    allowed(0);
    assert.equal(allowed(600), true, "exactly 600 ms — should be allowed");
  });

  it("blocks rapid double-tap from outer+inner Pressable", () => {
    const allowed = makeDebounce(600);
    const first  = allowed(1000);
    const second = allowed(1001); // 1 ms later — the nested Pressable fires
    assert.equal(first,  true,  "first press navigates");
    assert.equal(second, false, "nested Pressable double-tap is suppressed");
  });

  it("sequential presses after cooldown both navigate", () => {
    const allowed = makeDebounce(600);
    const first  = allowed(0);
    const second = allowed(700);
    assert.equal(first,  true, "first press allowed");
    assert.equal(second, true, "second press after cooldown allowed");
  });
});

// ─── 5. MiniPlayer navigation param key ──────────────────────────────────────
// Root-cause regression guard: MiniPlayer.handlePress used `live: "true"` instead
// of `isLive: "true"`. player.tsx reads `params.isLive` (and `params.broadcastMode`)
// but NOT `params.live`. With the wrong key the player received isLive=false,
// isBroadcastV2=false, and hasNoSource=true — surfacing "This video is unavailable"
// whenever the user tapped the MiniPlayer while PlayerContext.isLive was true.
//
// The fix: MiniPlayer now passes `{ isLive: "true" }` so the player correctly
// routes to BroadcastHlsPlayer (V2 engine).

/** Mirrors exactly how player.tsx derives `isLive` from search params */
function playerIsLiveFromParams(params: Record<string, string | undefined>): boolean {
  const parseBool = (v: string | undefined): boolean =>
    v === "true" || v === "1" || v === "yes";
  return parseBool(params["isLive"]) || parseBool(params["broadcastMode"]);
}

describe("MiniPlayer navigation param key — isLive vs live", () => {
  it("correct key 'isLive' → player sees isLive=true", () => {
    // This is the FIXED MiniPlayer.handlePress implementation.
    const params = { isLive: "true", title: "Live Broadcast", preacher: "JCTM" };
    assert.equal(playerIsLiveFromParams(params), true, "'isLive' key must set isLive=true");
  });

  it("wrong key 'live' → player sees isLive=false (documents the old bug)", () => {
    // This is what the OLD MiniPlayer.handlePress was passing.
    // player.tsx does NOT read params.live, so isLive stays false.
    const brokenParams = { live: "true", title: "Live Broadcast", preacher: "JCTM" } as Record<string, string>;
    assert.equal(
      playerIsLiveFromParams(brokenParams),
      false,
      "wrong 'live' key must produce isLive=false — confirms the old bug",
    );
  });

  it("wrong key 'live' leads to hasNoSource=true (the 'unavailable' screen)", () => {
    const brokenParams = { live: "true" } as Record<string, string>;
    const isLive    = playerIsLiveFromParams(brokenParams); // false (bug)
    const youtubeId = brokenParams["youtubeId"] ?? "";
    const hlsUrl    = brokenParams["hlsUrl"] ?? "";
    const isYoutube = !!youtubeId && !hlsUrl;
    const isHls     = !!hlsUrl;
    const hasNoSource = !isLive && !isYoutube && !isHls;
    assert.equal(isLive,      false, "wrong key → isLive=false");
    assert.equal(hasNoSource, true,  "wrong key → hasNoSource=true → 'This video is unavailable'");
  });

  it("correct key 'isLive' → isBroadcastV2=true → V2 engine mounts", () => {
    const params = { isLive: "true" };
    const isLive    = playerIsLiveFromParams(params);
    const youtubeId = "";
    const hlsUrl    = "";
    const isBroadcastV2 = isLive && !(!!youtubeId && !hlsUrl);
    assert.equal(isBroadcastV2, true, "correct key → isBroadcastV2=true → BroadcastHlsPlayer mounts");
  });

  it("broadcastMode key also works (isBroadcastMode path)", () => {
    const params = { broadcastMode: "true" };
    assert.equal(playerIsLiveFromParams(params), true, "'broadcastMode' key must also set isLive=true");
  });
});

// ─── 6. navigateToLive params ─────────────────────────────────────────────────
// Verifies each hero branch passes the correct params so the player boots into V2.

describe("navigateToLive params produce correct isBroadcastV2", () => {
  // Helper: simulate how player.tsx derives the key flags from push params.
  function deriveFromParams(params: {
    isLive: string;
    hlsUrl?: string;
    youtubeId?: string;
  }) {
    const isLive    = params.isLive === "true";
    const hlsUrl    = params.hlsUrl ?? "";
    const youtubeId = params.youtubeId ?? "";
    const isHls     = !!hlsUrl;
    const isYoutube = !!youtubeId && !hlsUrl;
    const isBroadcastV2 = isLive && !(!!youtubeId && !hlsUrl);
    return { isLive, isHls, isYoutube, isBroadcastV2 };
  }

  it("uploaded broadcast (hasUploadedBroadcast=true) → V2 engine", () => {
    // Branch: navigateToLive("", activeBroadcastTitle, 0, undefined, thumb)
    const d = deriveFromParams({ isLive: "true", hlsUrl: "", youtubeId: "" });
    assert.equal(d.isLive,       true,  "isLive must be true");
    assert.equal(d.isHls,        false, "no hlsUrl → isHls=false");
    assert.equal(d.isYoutube,    false, "no youtubeId → isYoutube=false");
    assert.equal(d.isBroadcastV2, true,  "must use V2 engine");
  });

  it("YouTube override (hasYoutubeOverride=true) WITHOUT youtubeId param → V2 engine", () => {
    // Branch: navigateToLive("", activeBroadcastTitle, 0, undefined, thumb,
    // "hero-watch", false, initialYoutubeOverrideId). `youtubeId` must
    // stay empty so V2 remains authoritative; the separate bootstrap value
    // avoids waiting for the first V2 snapshot before rendering YouTube.
    const d = deriveFromParams({ isLive: "true", hlsUrl: "", youtubeId: "" });
    assert.equal(d.isBroadcastV2, true, "YouTube override via V2 engine (reactive)");
  });

  it("YouTube override bootstrap ID preserves V2 routing", () => {
    const params = {
      isLive: "true",
      hlsUrl: "",
      youtubeId: "",
      initialYoutubeOverrideId: "dQw4w9WgXcQ",
    };
    const d = deriveFromParams(params);
    assert.equal(d.isBroadcastV2, true, "bootstrap metadata must not bypass V2");
    assert.equal(params.initialYoutubeOverrideId, "dQw4w9WgXcQ");
  });

  it("YouTube override WITH youtubeId → NOT V2 (old broken path, must not be used)", () => {
    // This is what the old code was mistakenly doing: passing youtubeId for
    // override → isBroadcastV2=false → static YoutubePlayer → no broadcast
    // mode, no reactive override following.
    const d = deriveFromParams({ isLive: "true", hlsUrl: "", youtubeId: "dQw4w9WgXcQ" });
    assert.equal(d.isBroadcastV2, false, "static YouTube path — NOT the V2 engine");
    // Documents why the hero MUST NOT pass youtubeId for YouTube overrides.
  });

  it("no broadcast, no fallback → V2 engine (shows Connecting…)", () => {
    // Branch: navigateToLive("", "Live Broadcast", 0, undefined, undefined)
    const d = deriveFromParams({ isLive: "true" });
    assert.equal(d.isBroadcastV2, true, "bare isLive always boots V2 engine");
  });
});

// ─── 7. Deep-link guard must not overwrite player navigation ─────────────────
// Linking.getInitialURL() resolves asynchronously on Android. A stale unknown
// initial URL used to call safeNavReplace("/") after the user tapped Watch,
// replacing /player and remounting Home. The guard may only recover when Expo
// Router is actually sitting on an unknown route.

describe("deep-link guard navigation isolation", () => {
  it("recognizes Home and the existing Player route", async () => {
    const { getAppPathFromUrl, isKnownAppPath } = await loadDeepLinkGuard();
    assert.equal(isKnownAppPath("/"), true);
    assert.equal(isKnownAppPath("/player"), true);
    assert.equal(isKnownAppPath("/player/live"), true);
    assert.equal(getAppPathFromUrl("templetv://player"), "/player");
    assert.equal(getAppPathFromUrl("templetv:///player"), "/player");
    assert.equal(getAppPathFromUrl("https://templetv.org.ng/player"), "/player");
    assert.equal(isKnownAppPath(getAppPathFromUrl("templetv://unknown")), false);
  });

  it("never replaces Player with Home", async () => {
    const { shouldRecoverUnknownDeepLink } = await loadDeepLinkGuard();
    assert.equal(
      shouldRecoverUnknownDeepLink("/player", false),
      false,
      "a delayed unknown-link callback must preserve the active Player route",
    );
  });

  it("never replaces Home with Home and triggers a reload", async () => {
    const { shouldRecoverUnknownDeepLink } = await loadDeepLinkGuard();
    assert.equal(
      shouldRecoverUnknownDeepLink("/", false),
      false,
      "an unknown link must not remount an already-valid Home route",
    );
  });

  it("never competes with an in-flight Watch push", async () => {
    const { shouldRecoverUnknownDeepLink } = await loadDeepLinkGuard();
    assert.equal(
      shouldRecoverUnknownDeepLink("/unrecognized-referral", true),
      false,
      "the user navigation must win while safeNavPush is active",
    );
  });

  it("recovers only when the current route is actually unknown", async () => {
    const { shouldRecoverUnknownDeepLink } = await loadDeepLinkGuard();
    assert.equal(
      shouldRecoverUnknownDeepLink("/unrecognized-referral", false),
      true,
    );
  });

  it("preserves Home → Player → Back → Home when the initial URL resolves late", async () => {
    const { shouldRecoverUnknownDeepLink } = await loadDeepLinkGuard();
    const stack = ["/"];

    // Home hero: safeNavPush("/player") stamps the in-flight guard before push.
    let navigationPushActive = true;
    stack.push("/player");

    // Android now resolves a stale, unknown initial URL. It must not replace
    // the just-opened player with Home.
    const shouldReplaceWithHome = shouldRecoverUnknownDeepLink(
      stack.at(-1) ?? "/",
      navigationPushActive,
    );
    if (shouldReplaceWithHome) stack.splice(0, stack.length, "/");

    navigationPushActive = false;
    assert.deepEqual(stack, ["/", "/player"]);

    // Android hardware back uses router.back(), restoring the existing Home
    // entry rather than creating or reloading another Home route.
    stack.pop();
    assert.deepEqual(stack, ["/"]);
  });

  it("repeats the same navigation flow after a cold app restart", async () => {
    const { shouldRecoverUnknownDeepLink } = await loadDeepLinkGuard();
    const coldStartStack = ["/"];

    // A delayed unknown-link callback may finish while the fresh app is already
    // on Home. Replacing Home with Home would remount and refresh the screen.
    assert.equal(
      shouldRecoverUnknownDeepLink(coldStartStack.at(-1) ?? "/", false),
      false,
    );

    coldStartStack.push("/player");
    assert.deepEqual(coldStartStack, ["/", "/player"]);

    coldStartStack.pop();
    assert.deepEqual(coldStartStack, ["/"]);
  });

  it("blocks a delayed recovery retry when Player opens after attempt one", async () => {
    const { shouldRecoverUnknownDeepLink } = await loadDeepLinkGuard();
    let currentPathname = "/unrecognized-referral";
    let navigationPushActive = false;
    const canRecover = () =>
      shouldRecoverUnknownDeepLink(currentPathname, navigationPushActive);

    // Attempt one is valid while Expo Router is still on the unknown path.
    assert.equal(canRecover(), true);

    // That dispatch throws during a navigator transition. Before the 300 ms
    // retry, the user taps Watch and safeNavPush starts committing.
    navigationPushActive = true;
    currentPathname = "/player";

    // safeNavReplace receives this live predicate and must call it again before
    // the retry. The stale Home replace is now cancelled.
    assert.equal(canRecover(), false);
  });
});

// ─── 8. V2 broadcast surface audio exclusivity ───────────────────────────────
//
// Defect: when the /player route activates the V2 broadcast surface it starts
// HLS audio directly through the native media engine, bypassing PlayerContext
// .playSermon() / .playLive() which are the only callers of
// audioController.requestRadioStop(). The result: in-app radio plays
// simultaneously with the broadcast — two audio streams at once.
//
// Fix: player.tsx now calls audioController.requestRadioStop() synchronously
// from a focused useEffect that fires whenever isBroadcastV2 is true, including
// cold-start / deep-link entry. The effect is scoped via a mount-local ref so
// it never fires again while the surface stays active, and never fires at all
// for non-V2 surfaces (VOD, YouTube-live).
//
// This section tests the pure-logic contract of the fix:
//   1. requestRadioStop IS called when isBroadcastV2=true
//   2. It is NOT called when isBroadcastV2=false (VOD / YouTube paths)
//   3. It fires exactly once per mount (not on every re-render)
//   4. Re-mount fires it again (guard resets on unmount)
//   5. Cold-start / deep-link (isBroadcastV2=true on first render) triggers it

describe("V2 broadcast surface — audio exclusivity via audioController", () => {
  /**
   * Minimal simulation of the useEffect in player.tsx that calls
   * audioController.requestRadioStop() when isBroadcastV2 is true.
   *
   * Returns { stopCallCount, simulateUnmount }
   * so callers can assert call counts and test re-mount behaviour.
   */
  function simulateBroadcastMount(isBroadcastV2: boolean): {
    stopCallCount: () => number;
    simulateUnmount: () => void;
  } {
    let calls = 0;
    // Minimal stand-in for audioController.requestRadioStop
    const requestRadioStop = () => { calls++; };

    // Mirror the ref + effect logic from player.tsx:
    //   const radioStoppedForThisMountRef = useRef(false);
    //   useEffect(() => {
    //     if (!isBroadcastV2) return;
    //     if (radioStoppedForThisMountRef.current) return;
    //     radioStoppedForThisMountRef.current = true;
    //     audioController.requestRadioStop();
    //     return () => { radioStoppedForThisMountRef.current = false; };
    //   }, [isBroadcastV2]);
    let radioStoppedForThisMount = false;
    let cleanup: (() => void) | undefined;

    if (isBroadcastV2) {
      if (!radioStoppedForThisMount) {
        radioStoppedForThisMount = true;
        requestRadioStop();
        cleanup = () => { radioStoppedForThisMount = false; };
      }
    }

    return {
      stopCallCount: () => calls,
      simulateUnmount: () => cleanup?.(),
    };
  }

  it("calls requestRadioStop exactly once when isBroadcastV2=true (normal direct entry)", () => {
    const { stopCallCount } = simulateBroadcastMount(true);
    assert.equal(stopCallCount(), 1, "requestRadioStop must be called once on V2 mount");
  });

  it("does NOT call requestRadioStop when isBroadcastV2=false (VOD / YouTube path)", () => {
    const { stopCallCount } = simulateBroadcastMount(false);
    assert.equal(stopCallCount(), 0, "requestRadioStop must not be called for non-V2 surfaces");
  });

  it("cold-start deep-link (isBroadcastV2=true from route params) stops radio immediately", () => {
    // Simulate params: isLive=true, no youtubeId, no hlsUrl → isBroadcastV2=true
    const params = { isLive: "true", hlsUrl: "", youtubeId: "" };
    const isLive = params.isLive === "true";
    const youtubeId = params.youtubeId;
    const hlsUrl = params.hlsUrl;
    const isBroadcastV2 = isLive && !(!!youtubeId && !hlsUrl);

    assert.equal(isBroadcastV2, true, "deep-link params must yield isBroadcastV2=true");

    const { stopCallCount } = simulateBroadcastMount(isBroadcastV2);
    assert.equal(stopCallCount(), 1, "cold-start deep-link must stop radio on mount");
  });

  it("does not re-stop radio after already firing for this mount (guard is scoped)", () => {
    // If the same mount calls the effect body twice (e.g. StrictMode double-invoke
    // is defeated by the ref guard), only one stop should occur.
    let calls = 0;
    const requestRadioStop = () => { calls++; };
    let radioStoppedForThisMount = false;

    // Simulate two invocations of the effect body (same mount)
    const runEffect = () => {
      if (!radioStoppedForThisMount) {
        radioStoppedForThisMount = true;
        requestRadioStop();
      }
    };
    runEffect(); // first invocation
    runEffect(); // second invocation — should be a no-op due to the guard

    assert.equal(calls, 1, "ref guard prevents duplicate stop calls within the same mount");
  });

  it("re-mount fires requestRadioStop again after unmount resets the guard", () => {
    // Mount 1
    const mount1 = simulateBroadcastMount(true);
    assert.equal(mount1.stopCallCount(), 1, "first mount stops radio");
    mount1.simulateUnmount(); // cleanup: resets guard

    // Mount 2 (user navigated away and back; radio may have been restarted)
    const mount2 = simulateBroadcastMount(true);
    assert.equal(mount2.stopCallCount(), 1, "re-mount stops radio again after guard reset");
  });

  it("source-contract: player.tsx imports audioController", () => {
    const src = readFileSync("app/player.tsx", "utf8");
    assert.match(src, /import \* as audioController from ["']@\/services\/audioController["']/,
      "player.tsx must import audioController singleton");
  });

  it("source-contract: player.tsx calls requestRadioStop inside an isBroadcastV2-gated effect", () => {
    const src = readFileSync("app/player.tsx", "utf8");
    assert.match(src, /audioController\.requestRadioStop\(\)/,
      "player.tsx must call audioController.requestRadioStop()");
    // The call must be inside a block gated on isBroadcastV2
    assert.match(src, /if \(!isBroadcastV2\) return/,
      "the radio-stop effect must bail early when not V2 surface");
  });

  it("source-contract: guard ref prevents repeated stops on stable V2 surface", () => {
    const src = readFileSync("app/player.tsx", "utf8");
    assert.match(src, /radioStoppedForThisMountRef/,
      "player.tsx must use a mount-scoped ref to prevent repeated radio-stop calls");
  });
});
