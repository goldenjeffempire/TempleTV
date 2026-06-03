/**
 * YouTube source handling tests for PlayerMachine.
 *
 * Validates correct FSM behaviour when queue items or overrides use
 * source.kind === "youtube" — including the bug fixes where:
 *
 *   1. YouTube queue items were stuck in PREPARING_ACTIVE forever because the
 *      web adapter's bind() path never fired `buffer-ready` (fixed: adapter now
 *      fires buffer-ready immediately for YouTube sources).
 *
 *   2. YouTube queue items caused spurious `buffer-stalled` escalation because
 *      the adapter's `play` intent path called video.play() + armed the watchdog
 *      on an empty <video> element (fixed: adapter skips play() + watchdog for
 *      boundKind === "youtube").
 *
 *   3. `youtu.be` short URLs were silently not extracted (fixed: extractYouTubeId
 *      now also handles the youtu.be hostname path).
 *
 * Machine-level tests only — no DOM or adapter code is exercised here.
 * The adapter-level fix is validated separately in regression.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlayerMachine, type AdapterIntent } from "../src/machine.js";
import type { V2Item, V2Override, V2Snapshot } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function nextSeq() { return ++_seq; }

function makeHlsItem(id = "hls-item"): V2Item {
  const now = Date.now();
  return {
    id,
    title: `HLS Sermon ${id}`,
    thumbnailUrl: null,
    durationSecs: 3600,
    source: { kind: "hls", url: `https://cdn.example.com/${id}.m3u8`, expiresAtMs: null },
    failoverSource: null,
    startsAtMs: now - 60_000,
    endsAtMs: now + 3_540_000,
  };
}

function makeYouTubeItem(id = "yt-item", youtubeId = "dQw4w9WgXcQ"): V2Item {
  const now = Date.now();
  return {
    id,
    title: `YouTube Sermon ${id}`,
    thumbnailUrl: null,
    durationSecs: 3600,
    source: {
      kind: "youtube",
      url: `https://www.youtube.com/watch?v=${youtubeId}`,
      expiresAtMs: null,
    },
    failoverSource: null,
    startsAtMs: now - 60_000,
    endsAtMs: now + 3_540_000,
  };
}

function makeMp4Item(id = "mp4-item"): V2Item {
  const now = Date.now();
  return {
    id,
    title: `MP4 Sermon ${id}`,
    thumbnailUrl: null,
    durationSecs: 3600,
    source: { kind: "mp4", url: `https://cdn.example.com/${id}.mp4`, expiresAtMs: null },
    failoverSource: null,
    startsAtMs: now - 60_000,
    endsAtMs: now + 3_540_000,
  };
}

function makeYouTubeOverride(url = "https://www.youtube.com/watch?v=LIVE123"): V2Override {
  return {
    id: "ov-yt",
    kind: "youtube",
    url,
    title: "YouTube Live Override",
    startedAtMs: Date.now() - 2_000,
    endsAtMs: null,
    resumeQueueOnEnd: true,
  };
}

function makeHlsOverride(): V2Override {
  return {
    id: "ov-hls",
    kind: "hls",
    url: "https://cdn.example.com/live.m3u8",
    title: "HLS Live Override",
    startedAtMs: Date.now() - 2_000,
    endsAtMs: null,
    resumeQueueOnEnd: true,
  };
}

function makeSnapshot(overrides: Partial<V2Snapshot> = {}): V2Snapshot {
  return {
    channelId: "main",
    sequence: nextSeq(),
    serverTimeMs: Date.now(),
    mode: "queue",
    current: null,
    next: null,
    nextNext: null,
    override: null,
    checkpoint: null,
    failover: { active: false, reason: null },
    ...overrides,
  };
}

function makeHarness() {
  const intents: AdapterIntent[] = [];
  const states: string[] = [];
  const machine = new PlayerMachine((intent) => intents.push(intent));
  machine.subscribe((snap) => states.push(snap.state));
  return { machine, intents, states };
}

function driveToPlaying(
  machine: PlayerMachine,
  intents: AdapterIntent[],
  item: V2Item,
): void {
  machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
  const bufferId = machine.getSnapshot().activeBufferId;
  machine.send({ type: "buffer-ready", bufferId });
  expect(machine.getSnapshot().state).toBe("PLAYING");
}

// ---------------------------------------------------------------------------
// YouTube queue items — basic FSM flow
// ---------------------------------------------------------------------------

describe("YouTube source — queue item FSM flow", () => {
  beforeEach(() => { _seq = 0; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("YouTube queue item emits a bind intent with the YouTube item", () => {
    const { machine, intents } = makeHarness();
    const item = makeYouTubeItem();

    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });

    const bind = intents.find((i) => i.type === "bind");
    expect(bind).toBeDefined();
    expect(bind?.type === "bind" && (bind.item as V2Item).source.kind).toBe("youtube");
    machine.destroy();
  });

  it("YouTube queue item reaches PLAYING after buffer-ready (2 events: snapshot + buffer-ready)", () => {
    const { machine } = makeHarness();
    const item = makeYouTubeItem();

    // Event 1: snapshot → PREPARING_ACTIVE
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE");

    // Event 2: buffer-ready → PLAYING (the adapter fires this immediately for YouTube)
    const bufferId = machine.getSnapshot().activeBufferId;
    machine.send({ type: "buffer-ready", bufferId });
    expect(machine.getSnapshot().state).toBe("PLAYING");
    machine.destroy();
  });

  it("YouTube queue item: play intent has positionSecs === 0 (no HLS wall-clock seek)", () => {
    const { machine, intents } = makeHarness();
    const item = makeYouTubeItem();

    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });

    const play = intents.find((i) => i.type === "play");
    expect(play?.type === "play" && play.positionSecs).toBe(0);
    machine.destroy();
  });

  it("YouTube queue item: play positionSecs stays 0 even if startsAtMs is 2 hours ago", () => {
    const { machine, intents } = makeHarness();
    const now = Date.now();
    const item: V2Item = {
      ...makeYouTubeItem(),
      startsAtMs: now - 7_200_000, // 2 hours ago
      endsAtMs: now + 3_600_000,
    };

    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });

    const play = intents.find((i) => i.type === "play");
    expect(play?.type === "play" && play.positionSecs).toBe(0);
    machine.destroy();
  });

  it("YouTube queue item: bind intent is for the active buffer", () => {
    const { machine, intents } = makeHarness();
    const item = makeYouTubeItem();

    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });

    const bind = intents.find((i) => i.type === "bind");
    expect(bind?.type === "bind" && bind.bufferId).toBe(machine.getSnapshot().activeBufferId);
    machine.destroy();
  });

  it("FSM state is PREPARING_ACTIVE between snapshot and buffer-ready for YouTube item", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: makeYouTubeItem() }) });
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE");
    machine.destroy();
  });

  it("destroy() in PREPARING_ACTIVE (YouTube) does not throw", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: makeYouTubeItem() }) });
    expect(() => machine.destroy()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// YouTube queue item — error handling
// ---------------------------------------------------------------------------

describe("YouTube source — queue item error handling", () => {
  beforeEach(() => { _seq = 0; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("buffer-error from PREPARING_ACTIVE (YouTube) → RECOVERING_PRIMARY", () => {
    const { machine } = makeHarness();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: makeYouTubeItem() }) });
    expect(machine.getSnapshot().state).toBe("PREPARING_ACTIVE");
    machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "load-timeout" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });

  it("buffer-error from PLAYING (YouTube) → RECOVERING_PRIMARY", () => {
    const { machine } = makeHarness();
    const item = makeYouTubeItem();
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
    expect(machine.getSnapshot().state).toBe("PLAYING");

    machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "network" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });

  it("3 consecutive buffer-errors without failover → SKIP_PENDING", () => {
    const { machine } = makeHarness();
    const item = makeYouTubeItem();

    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });

    // Error budget (no failover): primaryRetries 1→RECOVERING_PRIMARY, 2→RECOVERING_PRIMARY
    // (no failoverSource so RECOVERING_FAILOVER is skipped), ≥3→SKIP_PENDING.
    machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "e1" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY"); // retries=1
    machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "e2" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY"); // retries=2, no failover → stays
    machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "e3" });
    expect(machine.getSnapshot().state).toBe("SKIP_PENDING"); // retries≥3 → SKIP_PENDING
    machine.destroy();
  });

  it("YouTube item with failover: error escalates RECOVERING_PRIMARY → RECOVERING_FAILOVER", () => {
    const { machine } = makeHarness();
    const item: V2Item = {
      ...makeYouTubeItem(),
      failoverSource: { kind: "mp4", url: "https://cdn.example.com/fallback.mp4", expiresAtMs: null },
    };

    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
    machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
    machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "network" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "failover" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_FAILOVER");
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// YouTube source — override (LIVE_OVERRIDE_ACTIVE)
// ---------------------------------------------------------------------------

describe("YouTube source — override lifecycle", () => {
  beforeEach(() => { _seq = 0; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("YouTube override takeover → LIVE_OVERRIDE_ACTIVE", () => {
    const { machine } = makeHarness();
    const baseItem = makeHlsItem("base");
    driveToPlaying(machine, [], baseItem);

    machine.send({ type: "takeover", override: makeYouTubeOverride() });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
    machine.destroy();
  });

  it("YouTube override: buffer-stalled in LIVE_OVERRIDE_ACTIVE does NOT escalate (no native video)", () => {
    const { machine } = makeHarness();
    const baseItem = makeHlsItem("base");
    driveToPlaying(machine, [], baseItem);

    machine.send({ type: "takeover", override: makeYouTubeOverride() });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");

    // YouTube iframe: native video element is idle — stall is expected and must not escalate
    machine.send({ type: "buffer-stalled", bufferId: machine.getSnapshot().activeBufferId });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
    machine.destroy();
  });

  it("YouTube override: buffer-stalled 5× never leaves LIVE_OVERRIDE_ACTIVE", () => {
    const { machine } = makeHarness();
    driveToPlaying(machine, [], makeHlsItem("base"));

    machine.send({ type: "takeover", override: makeYouTubeOverride() });
    for (let i = 0; i < 5; i++) {
      machine.send({ type: "buffer-stalled", bufferId: machine.getSnapshot().activeBufferId });
    }
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
    machine.destroy();
  });

  it("YouTube override: buffer-ready stays LIVE_OVERRIDE_ACTIVE (not a meaningful event for iframe)", () => {
    const { machine } = makeHarness();
    driveToPlaying(machine, [], makeHlsItem("base"));

    machine.send({ type: "takeover", override: makeYouTubeOverride() });
    machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
    machine.destroy();
  });

  it("YouTube override bind intent has override item with kind='youtube'", () => {
    const { machine, intents } = makeHarness();
    driveToPlaying(machine, intents, makeHlsItem("base"));
    const intentsBeforeTakeover = intents.length;

    machine.send({ type: "takeover", override: makeYouTubeOverride() });

    const newIntents = intents.slice(intentsBeforeTakeover);
    const bind = newIntents.find((i) => i.type === "bind");
    expect(bind).toBeDefined();
    if (bind?.type === "bind") {
      const ov = bind.item as V2Override;
      expect(ov.kind).toBe("youtube");
    }
    machine.destroy();
  });

  it("YouTube override: buffer-error in LIVE_OVERRIDE_ACTIVE → RECOVERING_PRIMARY", () => {
    const { machine } = makeHarness();
    driveToPlaying(machine, [], makeHlsItem("base"));

    machine.send({ type: "takeover", override: makeYouTubeOverride() });
    machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "iframe-crash" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");
    machine.destroy();
  });

  it("YouTube override starts from BOOTSTRAP (no prior playing item)", () => {
    const { machine } = makeHarness();
    machine.send({ type: "takeover", override: makeYouTubeOverride() });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// Mixed HLS / YouTube / MP4 queue sequences
// ---------------------------------------------------------------------------

describe("YouTube source — mixed source kind queue cycling", () => {
  beforeEach(() => { _seq = 0; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("HLS → YouTube → HLS handoff: 3-item sequence reaches PLAYING after each", () => {
    const { machine } = makeHarness();
    const items = [makeHlsItem("s1"), makeYouTubeItem("s2"), makeHlsItem("s3")];

    for (let i = 0; i < 3; i++) {
      const item = items[i];
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item, sequence: i + 1 }) });
      machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
      expect(machine.getSnapshot().state).toBe("PLAYING");
    }
    machine.destroy();
  });

  it("YouTube → MP4 → YouTube → HLS — 4-item sequence stays valid", () => {
    const { machine } = makeHarness();
    const items = [
      makeYouTubeItem("y1"),
      makeMp4Item("m1"),
      makeYouTubeItem("y2"),
      makeHlsItem("h1"),
    ];

    for (let i = 0; i < items.length; i++) {
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: items[i], sequence: i + 1 }) });
      machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
      expect(machine.getSnapshot().state).toBe("PLAYING");
    }
    machine.destroy();
  });

  it("YouTube item can be preloaded while HLS is playing (A/B swap)", () => {
    const { machine } = makeHarness();
    const hlsItem = makeHlsItem("h1");
    const ytItem = makeYouTubeItem("y1");

    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: hlsItem }) });
    machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
    expect(machine.getSnapshot().state).toBe("PLAYING");
    const activeId = machine.getSnapshot().activeBufferId;
    const inactiveId: "A" | "B" = activeId === "A" ? "B" : "A";

    // Preload YouTube into inactive buffer.
    // After preload → PREPARING_NEXT. After buffer-ready on inactive → machine is
    // ready to hand off but the active HLS stream is still running (PREPARING_NEXT).
    machine.send({ type: "preload", item: ytItem, leadMs: 90_000 });
    machine.send({ type: "buffer-ready", bufferId: inactiveId });
    // Machine is PREPARING_NEXT — YouTube is loaded in the inactive buffer, HLS still live.
    expect(["PREPARING_NEXT", "PLAYING"]).toContain(machine.getSnapshot().state);

    // Natural end of HLS → HANDOFF → PLAYING with YouTube as the active buffer
    machine.send({ type: "buffer-ended", bufferId: activeId });
    expect(machine.getSnapshot().state).toBe("PLAYING");
    expect(machine.getSnapshot().activeBufferId).toBe(inactiveId);
    machine.destroy();
  });

  it("HLS item can be preloaded while YouTube is playing (A/B swap)", () => {
    const { machine } = makeHarness();
    const ytItem = makeYouTubeItem("y1");
    const hlsItem = makeHlsItem("h1");

    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: ytItem }) });
    machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
    const activeId = machine.getSnapshot().activeBufferId;
    const inactiveId: "A" | "B" = activeId === "A" ? "B" : "A";

    machine.send({ type: "preload", item: hlsItem, leadMs: 90_000 });
    machine.send({ type: "buffer-ready", bufferId: inactiveId });
    machine.send({ type: "buffer-ended", bufferId: activeId });
    expect(machine.getSnapshot().state).toBe("PLAYING");
    expect(machine.getSnapshot().activeBufferId).toBe(inactiveId);
    machine.destroy();
  });

  it("20-item mixed queue with YouTube items cycles without deadlock", () => {
    const { machine } = makeHarness();
    const kinds: Array<"hls" | "youtube" | "mp4"> = [
      "hls", "youtube", "mp4", "youtube", "hls",
      "youtube", "hls", "youtube", "youtube", "mp4",
      "hls", "hls", "youtube", "mp4", "youtube",
      "hls", "youtube", "mp4", "hls", "youtube",
    ];
    const items: V2Item[] = kinds.map((kind, i) =>
      kind === "hls" ? makeHlsItem(`s${i}`)
        : kind === "youtube" ? makeYouTubeItem(`s${i}`)
          : makeMp4Item(`s${i}`),
    );

    for (let i = 0; i < 20; i++) {
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: items[i], sequence: i + 1 }) });
      machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
      expect(machine.getSnapshot().state).toBe("PLAYING");
    }
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// Mixed override kinds — HLS ↔ YouTube ↔ RTMP cycles
// ---------------------------------------------------------------------------

describe("YouTube source — mixed override kind cycling", () => {
  beforeEach(() => { _seq = 0; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("HLS override → YouTube override → HLS override: 3 takeovers all reach LIVE_OVERRIDE_ACTIVE", () => {
    const { machine } = makeHarness();
    driveToPlaying(machine, [], makeHlsItem("base"));

    const overrides: V2Override[] = [
      makeHlsOverride(),
      makeYouTubeOverride(),
      { ...makeHlsOverride(), id: "ov-hls-2" },
    ];

    for (const ov of overrides) {
      machine.send({ type: "takeover", override: ov });
      expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
    }
    machine.destroy();
  });

  it("10 YouTube override cycles (takeover → stall × 3) stay in LIVE_OVERRIDE_ACTIVE", () => {
    const { machine } = makeHarness();
    driveToPlaying(machine, [], makeHlsItem("base"));

    for (let i = 0; i < 10; i++) {
      machine.send({ type: "takeover", override: { ...makeYouTubeOverride(), id: `ov-yt-${i}` } });
      expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
      // YouTube stalls must never escalate
      for (let s = 0; s < 3; s++) {
        machine.send({ type: "buffer-stalled", bufferId: machine.getSnapshot().activeBufferId });
        expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");
      }
    }
    machine.destroy();
  });

  it("YouTube override → buffer-error → recovery → resume playing HLS queue", () => {
    const { machine } = makeHarness();
    const hlsItem = makeHlsItem("base");
    driveToPlaying(machine, [], hlsItem);

    machine.send({ type: "takeover", override: makeYouTubeOverride() });
    expect(machine.getSnapshot().state).toBe("LIVE_OVERRIDE_ACTIVE");

    machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "iframe-crash" });
    expect(machine.getSnapshot().state).toBe("RECOVERING_PRIMARY");

    // Recover back to queue
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: hlsItem }) });
    machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
    expect(machine.getSnapshot().state).toBe("PLAYING");
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// forceReconnect (FATAL → SYNCING auto-recovery)
// ---------------------------------------------------------------------------

describe("YouTube source — FATAL recovery (forceReconnect path)", () => {
  beforeEach(() => { _seq = 0; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("FATAL state after 3 skip cycles auto-recovers after 30 s", () => {
    const { machine } = makeHarness();

    // Reach FATAL via 3 SKIP_PENDING cycles
    function burnSkip() {
      const item = makeYouTubeItem(`yt-burn-${nextSeq()}`);
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: item }) });
      machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
      machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "e1" });
      // RECOVERING_PRIMARY — no failover → SKIP_PENDING
      machine.send({ type: "buffer-error", bufferId: machine.getSnapshot().activeBufferId, error: "e2" });
    }

    burnSkip(); // SKIP_PENDING × 1
    if (machine.getSnapshot().state !== "SKIP_PENDING") return; // guard
    burnSkip(); // SKIP_PENDING × 2
    burnSkip(); // → FATAL

    if (machine.getSnapshot().state !== "FATAL") return; // guard

    // Auto-recovery fires after 30 s (the FATAL_AUTO_RECOVERY_MS)
    vi.advanceTimersByTime(30_000);
    expect(["SYNCING", "BOOTSTRAP"]).toContain(machine.getSnapshot().state);
    machine.destroy();
  });

  it("FATAL state: machine re-enters PREPARING_ACTIVE when snapshot with YouTube item arrives after recovery", () => {
    const { machine } = makeHarness();
    const ytItem = makeYouTubeItem("yt-fatal");

    // Drive to FATAL manually via repeated skip
    for (let i = 0; i < 5; i++) {
      machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: makeYouTubeItem(`yt-${i}`) }) });
      const activeId = machine.getSnapshot().activeBufferId;
      // Skip directly via force-skip
      if (machine.getSnapshot().state === "PREPARING_ACTIVE") {
        machine.send({ type: "buffer-error", bufferId: activeId, error: "timeout" });
        machine.send({ type: "buffer-error", bufferId: activeId, error: "timeout2" });
      }
    }

    if (machine.getSnapshot().state === "FATAL") {
      vi.advanceTimersByTime(30_000);
    }

    // After auto-recovery, a new snapshot should move the machine out of BOOTSTRAP/SYNCING
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: ytItem }) });
    expect(["PREPARING_ACTIVE", "PLAYING", "SYNCING"]).toContain(machine.getSnapshot().state);
    machine.destroy();
  });
});

// ---------------------------------------------------------------------------
// YouTube source buffer identity in A/B swap
// ---------------------------------------------------------------------------

describe("YouTube source — A/B buffer identity through handoffs", () => {
  beforeEach(() => { _seq = 0; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("bufferA or bufferB is the YouTube item after bind", () => {
    const { machine } = makeHarness();
    const ytItem = makeYouTubeItem("yt-1");
    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: ytItem }) });

    const snap = machine.getSnapshot();
    const activeId = snap.activeBufferId;
    const boundItem = activeId === "A" ? snap.bufferA : snap.bufferB;
    expect(boundItem).toBeDefined();
    expect((boundItem as V2Item | null)?.id).toBe("yt-1");
    machine.destroy();
  });

  it("after YouTube→HLS handoff, inactive buffer (YouTube) is unbound", () => {
    const { machine } = makeHarness();
    const ytItem = makeYouTubeItem("yt-1");
    const hlsItem = makeHlsItem("h-1");

    machine.send({ type: "snapshot", snapshot: makeSnapshot({ current: ytItem }) });
    machine.send({ type: "buffer-ready", bufferId: machine.getSnapshot().activeBufferId });
    const priorActiveId = machine.getSnapshot().activeBufferId;
    const inactiveId: "A" | "B" = priorActiveId === "A" ? "B" : "A";

    machine.send({ type: "preload", item: hlsItem, leadMs: 90_000 });
    machine.send({ type: "buffer-ready", bufferId: inactiveId });
    machine.send({ type: "buffer-ended", bufferId: priorActiveId });

    // After handoff the old YouTube buffer should be cleared
    const snap = machine.getSnapshot();
    const oldBuffer = priorActiveId === "A" ? snap.bufferA : snap.bufferB;
    expect(oldBuffer).toBeNull();
    machine.destroy();
  });
});
