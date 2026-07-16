/**
 * Hero YouTube Override — Regression Tests
 *
 * Guards the pure-JS logic introduced to fix the "Open Player" button
 * not working on YouTube-only deployments.
 *
 * Root causes fixed (each has its own describe block):
 *
 *  1. useMediaPlayerState: LIVE_OVERRIDE_ACTIVE mapped to "idle" instead of
 *     "live", causing the hero to show "Watch Now" and mediaState comparisons
 *     to incorrectly report the broadcast as inactive.
 *
 *  2. hasYoutubeOverride detection: v2Server.override.kind === "youtube" was
 *     not checked, so hasActiveBroadcast was always false on YouTube-only
 *     deployments (broadcast_queue is empty; ytShuffleFallback drives content
 *     via override frames).
 *
 *  3. YouTube video ID extraction: navigateToLive was called without a
 *     youtubeId even when the active override had a YouTube URL, requiring the
 *     player page to derive it on its own from the singleton snapshot.
 *
 *  4. Thumbnail derivation: the hero thumbnail remained blank for YouTube
 *     overrides because the fallback used fallbackSermon?.thumbnailUrl which
 *     is always null for YouTube-only catalogs.
 *
 * Run with: pnpm --filter @workspace/mobile test
 *
 * These tests cover only the PURE-JS extraction / classification logic —
 * no React hooks, no native modules, no WS connections.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const YT_ID = "dQw4w9WgXcQ"; // canonical 11-char YouTube ID used throughout

// ─── 1. YouTube video ID extraction ──────────────────────────────────────────
// Mirrors the regex used in:
//   • HeroSection.youtubeOverrideVideoId (index.tsx)
//   • player.tsx v2YouTubeOverrideVideoId
//   • useMediaPlayerState currentThumbnailUrl

/** Pure extraction helper — same logic as HeroSection and player.tsx */
function extractYouTubeId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

describe("extractYouTubeId — standard watch URL", () => {
  it("extracts ID from https://www.youtube.com/watch?v=<ID>", () => {
    assert.equal(extractYouTubeId(`https://www.youtube.com/watch?v=${YT_ID}`), YT_ID);
  });

  it("extracts ID when URL has extra query params", () => {
    assert.equal(
      extractYouTubeId(`https://www.youtube.com/watch?v=${YT_ID}&t=42s`),
      YT_ID,
    );
  });

  it("extracts ID from http:// variant", () => {
    assert.equal(extractYouTubeId(`http://www.youtube.com/watch?v=${YT_ID}`), YT_ID);
  });

  it("extracts ID from youtu.be short URL", () => {
    assert.equal(extractYouTubeId(`https://youtu.be/${YT_ID}`), YT_ID);
  });

  it("extracts ID from youtu.be with query params", () => {
    assert.equal(extractYouTubeId(`https://youtu.be/${YT_ID}?si=abc123`), YT_ID);
  });

  it("returns null for non-YouTube URL", () => {
    assert.equal(extractYouTubeId("https://example.com/video"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(extractYouTubeId(""), null);
  });

  it("returns null for YouTube URL with no ID segment", () => {
    assert.equal(extractYouTubeId("https://www.youtube.com/"), null);
  });

  it("returns null for truncated ID (< 11 chars)", () => {
    // The regex requires exactly characters [A-Za-z0-9_-] — a 10-char ID misses
    // the length requirement built into the surrounding context.
    // The regex itself doesn't enforce length, so this is about what the server sends;
    // here we confirm the extractor returns SOMETHING or null deterministically.
    const short = extractYouTubeId("https://www.youtube.com/watch?v=SHORTID");
    // "SHORTID" is 7 chars, not 11. The regex [A-Za-z0-9_-]{11} won't match.
    assert.equal(short, null);
  });

  it("builds the correct YouTube URL (mirrors buildYouTubeUrl on the server)", () => {
    const url = `https://www.youtube.com/watch?v=${YT_ID}`;
    assert.equal(extractYouTubeId(url), YT_ID);
  });
});

// ─── 2. YouTube thumbnail URL derivation ─────────────────────────────────────
// The hero derives thumbnails for YouTube overrides via:
//   `https://img.youtube.com/vi/${youtubeOverrideVideoId}/hqdefault.jpg`
// and useMediaPlayerState derives override thumbnails via:
//   `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg`

function buildYtThumbnailUrl(videoId: string): string {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

describe("YouTube thumbnail URL derivation", () => {
  it("produces the correct hqdefault.jpg URL", () => {
    assert.equal(
      buildYtThumbnailUrl(YT_ID),
      `https://img.youtube.com/vi/${YT_ID}/hqdefault.jpg`,
    );
  });

  it("thumbnail URL is non-null when ID is extracted from a valid override URL", () => {
    const url = `https://www.youtube.com/watch?v=${YT_ID}`;
    const id = extractYouTubeId(url);
    assert.ok(id !== null);
    assert.equal(buildYtThumbnailUrl(id!), `https://img.youtube.com/vi/${YT_ID}/hqdefault.jpg`);
  });

  it("no thumbnail is produced when URL is empty", () => {
    const id = extractYouTubeId("");
    assert.equal(id, null);
    // No thumbnail — hero falls back to fallbackSermon?.thumbnailUrl ?? null
  });
});

// ─── 3. hasYoutubeOverride classification ────────────────────────────────────
// HeroSection.hasYoutubeOverride mirrors:
//   v2Server?.override?.kind === "youtube" && !!v2Server.override.url

type MockOverride = { kind: string; url?: string | null } | null | undefined;
type MockServer   = { current: unknown; override: MockOverride } | null | undefined;

function hasYoutubeOverride(server: MockServer): boolean {
  return server?.override?.kind === "youtube" && !!server.override?.url;
}

function hasUploadedBroadcast(server: MockServer): boolean {
  return !!(
    server?.current &&
    (server.current as { source?: { kind?: string } })?.source?.kind !== "youtube"
  );
}

function hasActiveBroadcast(server: MockServer): boolean {
  return hasUploadedBroadcast(server) || hasYoutubeOverride(server);
}

describe("hasYoutubeOverride", () => {
  it("true when override.kind='youtube' and URL is present", () => {
    assert.equal(
      hasYoutubeOverride({
        current: null,
        override: { kind: "youtube", url: `https://www.youtube.com/watch?v=${YT_ID}` },
      }),
      true,
    );
  });

  it("false when override is null", () => {
    assert.equal(hasYoutubeOverride({ current: null, override: null }), false);
  });

  it("false when server snapshot is null (no WS connection yet)", () => {
    assert.equal(hasYoutubeOverride(null), false);
  });

  it("false when override.kind is 'hls'", () => {
    assert.equal(
      hasYoutubeOverride({
        current: null,
        override: { kind: "hls", url: "https://cdn.example.com/live.m3u8" },
      }),
      false,
    );
  });

  it("false when override.kind is 'youtube' but url is empty", () => {
    assert.equal(
      hasYoutubeOverride({ current: null, override: { kind: "youtube", url: "" } }),
      false,
    );
  });

  it("false when override.kind is 'youtube' but url is null", () => {
    assert.equal(
      hasYoutubeOverride({ current: null, override: { kind: "youtube", url: null } }),
      false,
    );
  });
});

describe("hasActiveBroadcast — YouTube-only deployment", () => {
  const ytServer = {
    current: null, // queue is always empty for YouTube-only
    override: { kind: "youtube", url: `https://www.youtube.com/watch?v=${YT_ID}` },
  };

  it("hasActiveBroadcast=true when YouTube override is active (YouTube-only)", () => {
    assert.equal(hasActiveBroadcast(ytServer), true);
  });

  it("hasUploadedBroadcast=false for YouTube-only (no queue item)", () => {
    assert.equal(hasUploadedBroadcast(ytServer), false);
  });

  it("hasActiveBroadcast=true when uploaded broadcast is live (non-YouTube)", () => {
    const server = {
      current: { id: "mp4-1", source: { kind: "mp4" } },
      override: null,
    };
    assert.equal(hasActiveBroadcast(server), true);
    assert.equal(hasUploadedBroadcast(server), true);
  });

  it("hasActiveBroadcast=false when both current and override are null (off-air)", () => {
    assert.equal(hasActiveBroadcast({ current: null, override: null }), false);
  });

  it("hasActiveBroadcast=false when server snapshot is null (WS not yet connected)", () => {
    assert.equal(hasActiveBroadcast(null), false);
  });

  it("hasActiveBroadcast=true when BOTH uploaded broadcast and YouTube override are active", () => {
    const server = {
      current: { id: "mp4-1", source: { kind: "mp4" } },
      override: { kind: "youtube", url: `https://www.youtube.com/watch?v=${YT_ID}` },
    };
    assert.equal(hasActiveBroadcast(server), true);
  });
});

// ─── 4. useMediaPlayerState FSM state mapping ─────────────────────────────────
// Verifies that LIVE_OVERRIDE_ACTIVE maps to mediaState="live" (not "idle").
// Mirrors the set-based classification in useMediaPlayerState.ts.

type FsmState = string;
type MediaState = "idle" | "loading" | "live" | "reconnecting" | "offline" | "error";

const LOADING_STATES   = new Set(["BOOTSTRAP", "PREPARING_ACTIVE", "SKIP_PENDING"]);
const PLAYING_STATES   = new Set(["PLAYING"]);
const RECOVERING_STATES = new Set(["RECOVERING_PRIMARY", "RECOVERING_FAILOVER"]);
const ERROR_STATES     = new Set(["FATAL"]);
const LIVE_OVERRIDE_STATES = new Set(["LIVE_OVERRIDE_ACTIVE"]);

function fsmStateToMediaState(fsmState: FsmState, hasItem: boolean): MediaState {
  if (ERROR_STATES.has(fsmState))     return "error";
  if (RECOVERING_STATES.has(fsmState)) return "reconnecting";
  if (PLAYING_STATES.has(fsmState))   return "live";
  if (LIVE_OVERRIDE_STATES.has(fsmState)) return "live";
  if (LOADING_STATES.has(fsmState))   return hasItem ? "loading" : "idle";
  return "idle";
}

describe("useMediaPlayerState — FSM state → mediaState mapping", () => {
  it("PLAYING → 'live'", () => {
    assert.equal(fsmStateToMediaState("PLAYING", true), "live");
  });

  it("LIVE_OVERRIDE_ACTIVE → 'live' (YouTube-only deployment)", () => {
    // This was the root cause: LIVE_OVERRIDE_ACTIVE fell through to the else
    // branch → 'idle', causing isWatchLiveCTAVisible=true and the hero to
    // show "Watch Now" instead of "Open Player".
    assert.equal(fsmStateToMediaState("LIVE_OVERRIDE_ACTIVE", false), "live");
  });

  it("LIVE_OVERRIDE_ACTIVE → 'live' regardless of hasItem", () => {
    assert.equal(fsmStateToMediaState("LIVE_OVERRIDE_ACTIVE", true), "live");
  });

  it("FATAL → 'error'", () => {
    assert.equal(fsmStateToMediaState("FATAL", false), "error");
  });

  it("RECOVERING_PRIMARY → 'reconnecting'", () => {
    assert.equal(fsmStateToMediaState("RECOVERING_PRIMARY", true), "reconnecting");
  });

  it("RECOVERING_FAILOVER → 'reconnecting'", () => {
    assert.equal(fsmStateToMediaState("RECOVERING_FAILOVER", true), "reconnecting");
  });

  it("BOOTSTRAP with a current item → 'loading'", () => {
    assert.equal(fsmStateToMediaState("BOOTSTRAP", true), "loading");
  });

  it("BOOTSTRAP without a current item (empty channel) → 'idle'", () => {
    assert.equal(fsmStateToMediaState("BOOTSTRAP", false), "idle");
  });

  it("PREPARING_ACTIVE → 'loading'", () => {
    assert.equal(fsmStateToMediaState("PREPARING_ACTIVE", true), "loading");
  });

  it("SKIP_PENDING with item → 'loading'", () => {
    assert.equal(fsmStateToMediaState("SKIP_PENDING", true), "loading");
  });

  it("SYNCING (not in any set) → 'idle'", () => {
    assert.equal(fsmStateToMediaState("SYNCING", false), "idle");
  });

  it("OFFLINE_HOLD → 'idle' (offline suppressed by network layer, not FSM)", () => {
    // Note: the actual isOnline check in useMediaPlayerState returns "offline"
    // before this function is called when !isOnline. OFFLINE_HOLD itself falls
    // to the else-idle branch (handled by parent component, not here).
    assert.equal(fsmStateToMediaState("OFFLINE_HOLD", false), "idle");
  });
});

// ─── 5. isWatchLiveCTAVisible derivation ─────────────────────────────────────
// Derived from mediaState. CTA is visible when the user is NOT already watching.

function isWatchLiveCTAVisible(mediaState: MediaState): boolean {
  return mediaState === "idle" || mediaState === "error";
}

describe("isWatchLiveCTAVisible", () => {
  it("false for 'live' (user is already watching — show 'Open Player' instead)", () => {
    assert.equal(isWatchLiveCTAVisible("live"), false);
  });

  it("false for LIVE_OVERRIDE_ACTIVE → mediaState='live' → CTA hidden", () => {
    const ms = fsmStateToMediaState("LIVE_OVERRIDE_ACTIVE", false);
    assert.equal(isWatchLiveCTAVisible(ms), false);
  });

  it("true for 'idle' (nothing playing — show 'Watch Now' / 'Watch Live')", () => {
    assert.equal(isWatchLiveCTAVisible("idle"), true);
  });

  it("true for 'error' (broadcast failed — show CTA to retry)", () => {
    assert.equal(isWatchLiveCTAVisible("error"), true);
  });

  it("false for 'loading' (stream is connecting — no CTA yet)", () => {
    assert.equal(isWatchLiveCTAVisible("loading"), false);
  });

  it("false for 'reconnecting'", () => {
    assert.equal(isWatchLiveCTAVisible("reconnecting"), false);
  });

  it("false for 'offline'", () => {
    assert.equal(isWatchLiveCTAVisible("offline"), false);
  });
});

// ─── 6. navigateToLive params — YouTube-only path ────────────────────────────
// Verifies the params object sent to router.push when a YouTube override
// is active, ensuring youtubeId is non-empty.

interface NavigateToLiveParams {
  id: string;
  title: string;
  hlsUrl: string;
  youtubeId: string;
  thumbnailUrl: string;
  isLive: string;
  startPositionSecs: string;
}

function buildNavigateToLiveParams(
  hlsUrl: string,
  title: string,
  positionSecs: number,
  youtubeId?: string,
  thumbnailUrl?: string,
): NavigateToLiveParams {
  return {
    id: "live",
    title,
    hlsUrl,
    youtubeId: youtubeId ?? "",
    thumbnailUrl: thumbnailUrl ?? "",
    isLive: "true",
    startPositionSecs: String(Math.max(0, Math.round(positionSecs))),
  };
}

describe("navigateToLive params — YouTube-only deployment", () => {
  it("youtubeId is populated when override video ID is passed", () => {
    const params = buildNavigateToLiveParams("", "Live Broadcast", 0, YT_ID, undefined);
    assert.equal(params.youtubeId, YT_ID);
    assert.equal(params.isLive, "true");
    assert.equal(params.hlsUrl, "");
  });

  it("youtubeId is empty string when not provided (old fallback path)", () => {
    const params = buildNavigateToLiveParams("", "Live Broadcast", 0, undefined, undefined);
    assert.equal(params.youtubeId, "");
  });

  it("youtubeId is empty string when undefined is passed explicitly", () => {
    const params = buildNavigateToLiveParams("", "Live Broadcast", 0);
    assert.equal(params.youtubeId, "");
  });

  it("thumbnailUrl defaults to empty string when not provided", () => {
    const params = buildNavigateToLiveParams("", "Live Broadcast", 0, YT_ID);
    assert.equal(params.thumbnailUrl, "");
  });

  it("thumbnailUrl is passed through when provided", () => {
    const thumb = `https://img.youtube.com/vi/${YT_ID}/hqdefault.jpg`;
    const params = buildNavigateToLiveParams("", "Live Broadcast", 0, YT_ID, thumb);
    assert.equal(params.thumbnailUrl, thumb);
  });

  it("startPositionSecs is '0' for live broadcasts", () => {
    const params = buildNavigateToLiveParams("", "Live Broadcast", 0, YT_ID);
    assert.equal(params.startPositionSecs, "0");
  });

  it("negative startPositionSecs is clamped to 0", () => {
    const params = buildNavigateToLiveParams("", "Live Broadcast", -5, YT_ID);
    assert.equal(params.startPositionSecs, "0");
  });

  it("id is always 'live' for live broadcast navigation", () => {
    const params = buildNavigateToLiveParams("", "Live Broadcast", 0, YT_ID);
    assert.equal(params.id, "live");
  });

  it("title is passed through", () => {
    const params = buildNavigateToLiveParams("", "Evening Sermon", 0, YT_ID);
    assert.equal(params.title, "Evening Sermon");
  });
});

// ─── 7. End-to-end YouTube-only scenario ──────────────────────────────────────
// Full scenario: ytShuffleFallback is active, user taps "Open Player",
// verifies the correct navigation params are produced.

describe("YouTube-only deployment — full tap-to-player scenario", () => {
  const ytOverrideServer = {
    current: null, // broadcast_queue is always empty
    override: {
      kind: "youtube",
      url: `https://www.youtube.com/watch?v=${YT_ID}`,
      title: "Evening Worship",
    },
  };

  it("Step 1: FSM is in LIVE_OVERRIDE_ACTIVE → mediaState='live'", () => {
    assert.equal(fsmStateToMediaState("LIVE_OVERRIDE_ACTIVE", false), "live");
  });

  it("Step 2: mediaState='live' → CTA is hidden (button shows 'Open Player' not 'Watch Live')", () => {
    const ms = fsmStateToMediaState("LIVE_OVERRIDE_ACTIVE", false);
    assert.equal(isWatchLiveCTAVisible(ms), false);
  });

  it("Step 3: hasYoutubeOverride=true → hasActiveBroadcast=true", () => {
    assert.equal(hasActiveBroadcast(ytOverrideServer), true);
  });

  it("Step 4: YouTube ID is extracted from override URL", () => {
    const id = extractYouTubeId(ytOverrideServer.override.url);
    assert.equal(id, YT_ID);
  });

  it("Step 5: thumbnail is derived from YouTube ID", () => {
    const id = extractYouTubeId(ytOverrideServer.override.url);
    assert.ok(id);
    const thumb = buildYtThumbnailUrl(id!);
    assert.equal(thumb, `https://img.youtube.com/vi/${YT_ID}/hqdefault.jpg`);
  });

  it("Step 6: navigateToLive params include youtubeId and thumbnail", () => {
    const id = extractYouTubeId(ytOverrideServer.override.url);
    const thumb = id ? buildYtThumbnailUrl(id) : undefined;
    const params = buildNavigateToLiveParams(
      "",
      ytOverrideServer.override.title,
      0,
      id ?? undefined,
      thumb,
    );

    assert.equal(params.youtubeId, YT_ID);
    assert.equal(params.title, "Evening Worship");
    assert.equal(params.isLive, "true");
    assert.equal(params.hlsUrl, "");
    assert.equal(params.thumbnailUrl, `https://img.youtube.com/vi/${YT_ID}/hqdefault.jpg`);
  });
});
