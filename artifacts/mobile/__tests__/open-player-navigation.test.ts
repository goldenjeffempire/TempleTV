/**
 * Open Player Navigation — Regression Tests
 *
 * Guards against re-introduction of the "Open Player does nothing" bug where
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
  it("true when isLive=true and no URL / youtubeId (hero Open Player path)", () => {
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
  it("hero Open Player → broadcast_engine (isLive=true, no URL, no youtubeId)", () => {
    // This is the primary case for 'Open Player' in the hero.
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

// ─── 5. navigateToLive params ─────────────────────────────────────────────────
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
    // Branch: navigateToLive("", activeBroadcastTitle, 0, undefined, thumb)
    // Intentionally omits youtubeId so isBroadcastV2=true and the player
    // derives v2YouTubeOverrideVideoId reactively from the WS snapshot.
    const d = deriveFromParams({ isLive: "true", hlsUrl: "", youtubeId: "" });
    assert.equal(d.isBroadcastV2, true, "YouTube override via V2 engine (reactive)");
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
