/**
 * Mobile Startup Regression Tests
 *
 * Covers the critical pure-JS functions in the mobile startup pipeline.
 * Run with: pnpm --filter @workspace/mobile test
 *
 * These tests guard against regressions in:
 *  - Route param parsing (player.tsx uses these for every navigation)
 *  - Playback queue operations (used by library + player for prev/next)
 *  - Startup lifecycle phase tracking
 *
 * Native-module-dependent code (TrackPlayer, expo-av, SecureStore) is
 * intentionally excluded — those require a real device or emulator.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Silence console.log/warn inside tests so CI output stays clean. */
let _origLog: typeof console.log;
let _origWarn: typeof console.warn;
before(() => {
  _origLog  = console.log;
  _origWarn = console.warn;
  console.log  = () => {};
  console.warn = () => {};
});
after(() => {
  console.log  = _origLog;
  console.warn = _origWarn;
});

// ─── parseBoolParam ───────────────────────────────────────────────────────────

describe("parseBoolParam", async () => {
  // Dynamic import because this module uses TS path aliases resolved by tsx
  const { parseBoolParam } = await import("../lib/params.js");

  it('returns true for "true"',  () => assert.equal(parseBoolParam("true"),  true));
  it('returns true for "1"',     () => assert.equal(parseBoolParam("1"),     true));
  it('returns true for "yes"',   () => assert.equal(parseBoolParam("yes"),   true));
  it('returns true for "TRUE"',  () => assert.equal(parseBoolParam("TRUE"),  true));
  it('returns false for "false"',() => assert.equal(parseBoolParam("false"), false));
  it('returns false for "0"',    () => assert.equal(parseBoolParam("0"),     false));
  it('returns false for ""',     () => assert.equal(parseBoolParam(""),      false));
  it("returns false for undefined", () => assert.equal(parseBoolParam(undefined), false));
  it("returns false for null",      () => assert.equal(parseBoolParam(null as never), false));
  it("handles array — uses first element", () => assert.equal(parseBoolParam(["true", "false"]), true));
  it("handles array — false element",      () => assert.equal(parseBoolParam(["false"]),         false));
});

// ─── parseNumberParam ─────────────────────────────────────────────────────────

describe("parseNumberParam", async () => {
  const { parseNumberParam } = await import("../lib/params.js");

  it("parses integer string",         () => assert.equal(parseNumberParam("42"),     42));
  it("parses float string",           () => assert.equal(parseNumberParam("3.14"),   3.14));
  it("returns fallback for empty",    () => assert.equal(parseNumberParam("", 5),    5));
  it("returns fallback for undefined",() => assert.equal(parseNumberParam(undefined, 10), 10));
  it("returns fallback for NaN text", () => assert.equal(parseNumberParam("abc", 7), 7));
  it("returns 0 when no fallback",    () => assert.equal(parseNumberParam(""),       0));
  it("handles negative numbers",      () => assert.equal(parseNumberParam("-5"),     -5));
  it("handles array input",           () => assert.equal(parseNumberParam(["30"]),   30));
  it("handles ms to seconds division",() => {
    // Mirrors how player.tsx converts startPositionMs to seconds
    const ms = parseNumberParam("90000", 0);
    assert.equal(ms / 1000, 90);
  });
});

// ─── startupLifecycle ─────────────────────────────────────────────────────────

describe("startupLifecycle", async () => {
  // Import fresh module — avoids contamination from prior phases recorded in
  // other tests (would only matter when running all tests in the same process).
  const {
    markStartupPhase,
    getStartupTrace,
    getLastStartupPhase,
    startupElapsedMs,
  } = await import("../lib/startupLifecycle.js");

  it("records a phase without throwing", () => {
    assert.doesNotThrow(() => markStartupPhase("sentry_init"));
  });

  it("getLastStartupPhase returns the most recent phase", () => {
    markStartupPhase("global_error_handler");
    assert.equal(getLastStartupPhase(), "global_error_handler");
  });

  it("getStartupTrace returns all recorded phases in order", () => {
    markStartupPhase("rntp_register");
    const trace = getStartupTrace();
    // At least the phases we just recorded should be present
    const phases = trace.map((r) => r.phase);
    assert.ok(phases.includes("sentry_init"), "should have sentry_init");
    assert.ok(phases.includes("global_error_handler"), "should have global_error_handler");
    assert.ok(phases.includes("rntp_register"), "should have rntp_register");
  });

  it("each trace entry has a non-negative elapsedMs", () => {
    const trace = getStartupTrace();
    for (const entry of trace) {
      assert.ok(entry.elapsedMs >= 0, `elapsedMs should be >= 0, got ${entry.elapsedMs}`);
    }
  });

  it("each trace entry has a timestamp in the past", () => {
    const now = Date.now();
    const trace = getStartupTrace();
    for (const entry of trace) {
      assert.ok(entry.timestamp <= now, "timestamp should be in the past");
    }
  });

  it("startupElapsedMs returns a positive number", () => {
    const ms = startupElapsedMs();
    assert.ok(ms >= 0, `expected >= 0, got ${ms}`);
  });

  it("is safe to call markStartupPhase with any valid phase", () => {
    const phases: import("../lib/startupLifecycle.js").StartupPhase[] = [
      "layout_module_load", "layout_mount", "fonts_loaded",
      "splash_hidden", "audio_session", "track_player_setup",
      "auth_restore_start", "auth_restore_done", "providers_ready",
    ];
    assert.doesNotThrow(() => {
      for (const p of phases) markStartupPhase(p);
    });
  });
});

// ─── playbackQueue ────────────────────────────────────────────────────────────

describe("playbackQueue", async () => {
  const {
    playbackQueue,
    getNextSermon,
    getPrevSermon,
    getCurrentIndex,
  } = await import("../lib/playbackQueue.js");

  // Minimal Sermon shape for testing (only the fields the queue cares about)
  const makeSermon = (id: string) => ({
    id,
    title:        `Sermon ${id}`,
    thumbnailUrl: null,
    hlsMasterUrl: null,
    localVideoUrl:null,
    youtubeId:    "",       // ← explicitly empty for local/MP4 sermons
    videoSource:  "upload" as const,
    duration:     null,
    preacher:     null,
    category:     null,
    description:  null,
    publishedAt:  null,
  });

  const s1 = makeSermon("aaa-111");
  const s2 = makeSermon("bbb-222");
  const s3 = makeSermon("ccc-333");

  it("set() stores items and sets currentId", () => {
    playbackQueue.set([s1, s2, s3], s1.id);
    const snap = playbackQueue.getSnapshot();
    assert.equal(snap.items.length, 3);
    assert.equal(snap.currentId, s1.id);
  });

  it("getNextSermon returns the item after currentId", () => {
    playbackQueue.set([s1, s2, s3], s1.id);
    const next = getNextSermon(playbackQueue.getSnapshot());
    assert.equal(next?.id, s2.id);
  });

  it("getPrevSermon returns null at the head", () => {
    playbackQueue.set([s1, s2, s3], s1.id);
    assert.equal(getPrevSermon(playbackQueue.getSnapshot()), null);
  });

  it("getPrevSermon returns the item before currentId", () => {
    playbackQueue.set([s1, s2, s3], s2.id);
    const prev = getPrevSermon(playbackQueue.getSnapshot());
    assert.equal(prev?.id, s1.id);
  });

  it("getNextSermon returns null at the tail", () => {
    playbackQueue.set([s1, s2, s3], s3.id);
    assert.equal(getNextSermon(playbackQueue.getSnapshot()), null);
  });

  it("getCurrentIndex returns correct 0-based position", () => {
    playbackQueue.set([s1, s2, s3], s2.id);
    assert.equal(getCurrentIndex(playbackQueue.getSnapshot()), 1);
  });

  it("extend() appends new items without duplicates", () => {
    playbackQueue.set([s1, s2], s1.id);
    playbackQueue.extend([s2, s3]); // s2 is a duplicate, only s3 should be added
    const snap = playbackQueue.getSnapshot();
    assert.equal(snap.items.length, 3);
    assert.equal(snap.items[2]?.id, s3.id);
  });

  it("extend() is a no-op when all items are already present", () => {
    playbackQueue.set([s1, s2, s3], s1.id);
    const rev = playbackQueue.getSnapshot().revision;
    playbackQueue.extend([s1, s2, s3]);
    // revision should NOT bump — no actual change
    assert.equal(playbackQueue.getSnapshot().revision, rev);
  });

  it("setCurrent() updates the pointer", () => {
    playbackQueue.set([s1, s2, s3], s1.id);
    playbackQueue.setCurrent(s3.id);
    assert.equal(playbackQueue.getSnapshot().currentId, s3.id);
  });

  it("clear() empties the queue", () => {
    playbackQueue.set([s1, s2, s3], s1.id);
    playbackQueue.clear();
    const snap = playbackQueue.getSnapshot();
    assert.equal(snap.items.length, 0);
    assert.equal(snap.currentId, null);
  });

  it("subscribe() fires on mutations", () => {
    let fired = 0;
    const unsub = playbackQueue.subscribe(() => { fired++; });
    playbackQueue.set([s1], s1.id);
    playbackQueue.clear();
    unsub();
    playbackQueue.set([s1, s2], s1.id); // should NOT trigger after unsub
    assert.equal(fired, 2);
  });

  // ── Shuffle key regression (prevents recurrence of youtubeId="" bug) ──────
  it("getSnapshot returns correct currentId for local/MP4 sermon with empty youtubeId", () => {
    // Regression guard: previously setQueue() was called with youtubeId (empty
    // string "") as the startId for buildShuffledQueue. The queue itself is not
    // the same as the shuffle logic inside PlayerContext, but this test validates
    // the id-based lookup path that both use.
    const localSermon = makeSermon("uuid-local-upload");
    playbackQueue.set([localSermon], localSermon.id);
    const snap = playbackQueue.getSnapshot();
    assert.equal(snap.currentId, localSermon.id);
    assert.equal(snap.currentId, "uuid-local-upload");
    // youtubeId is empty — verify it was NOT used as the id
    assert.notEqual(snap.currentId, localSermon.youtubeId);
  });
});
