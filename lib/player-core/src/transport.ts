import type { PlayerEvent, V2ServerFrame, V2Snapshot } from "./types.js";

/**
 * Transport: connects to the v2 WebSocket gateway, dispatches frames into
 * the player machine via a callback, and auto-reconnects with exponential
 * backoff. Falls back to SSE if WebSocket is unavailable (e.g. corporate
 * proxies that strip the Upgrade header).
 *
 * Both transports use the same `Last-Event-ID` / `resume {lastSequence}`
 * mechanism for replay on reconnect.
 */

/**
 * Pluggable synchronous key-value storage adapter.
 *
 * The transport's snapshot cache and sequence persistence default to
 * `localStorage` / `sessionStorage` on the web. On React Native those APIs
 * are `undefined`, so the cache silently no-ops and every app wake starts
 * from BOOTSTRAP. Calling `configureMobileStorage()` once at app boot
 * (before any V2Transport is constructed) redirects all storage I/O through
 * this adapter — typically an in-memory Map backed by AsyncStorage writes.
 *
 * Design constraints:
 *   • Reads MUST be synchronous (called from the Transport constructor and
 *     `loadStoredSequence`).
 *   • Writes may fire-and-forget async side-effects (the adapter itself keeps
 *     an in-memory copy that is the source of truth for reads).
 */
export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Module-level adapter override — null = use browser localStorage/sessionStorage. */
let _mobileStorage: StorageAdapter | null = null;

/**
 * Override the transport's storage backend before creating any transport.
 * Intended for React Native: call once at app startup (e.g. in the root
 * _layout module) with an in-memory adapter backed by AsyncStorage.
 *
 * Safe to call multiple times — the last call wins.
 */
export function configureMobileStorage(adapter: StorageAdapter): void {
  _mobileStorage = adapter;
}

export interface TransportConfig {
  baseUrl: string;
  channel?: string;
  onPlayerEvent: (event: PlayerEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
  /**
   * Called whenever a `hello`, `heartbeat`, or `snapshot` frame arrives from
   * the server carrying a `serverTimeMs` timestamp. The argument is the
   * computed clock offset: `serverTimeMs − Date.now()` at the moment the
   * frame was parsed (before any async work). A positive value means the
   * server clock is ahead of the local clock; negative means it's behind.
   *
   * Wire this to `PlayerMachine.setClockOffsetMs(offsetMs)` in the hook that
   * owns both the transport and machine so that all subsequent
   * `resolvePositionSecs` calls use server-calibrated time rather than the
   * (potentially skewed) local device clock. On mobile devices where the OS
   * clock can be 30+ seconds wrong, this is the primary driver of admin-mobile
   * broadcast desync for VOD HLS content.
   */
  onClockCalibration?: (offsetMs: number) => void;
}

/**
 * Maximum reconnect backoff cap.
 *
 * 30 s is deliberately higher than the previous 6 s for extended outages.
 * With ±25 % full-jitter the effective window at max backoff is 22–37 s,
 * which smooths a fleet of hundreds of clients into a gentle ramp rather than
 * a synchronised thundering herd on a restarting server. Brief disconnects
 * (tab-switch, single missed heartbeat) are unaffected — they reconnect at
 * INITIAL_BACKOFF_MS via forceReconnect() before backoff ever accumulates.
 */
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 300;

function effectiveMaxBackoffMs(): number {
  return MAX_BACKOFF_MS;
}

/**
 * Dead-connection detection: if no frame arrives (heartbeat, snapshot,
 * event) for this many ms, the socket is a zombie — force-reconnect.
 * Server heartbeat interval is 10 000 ms; allowing 2.2 missed beats (22 s)
 * absorbs genuine single-missed-beat jitter on flaky 3G/4G mobile links
 * (where an occasional 12–15 s delivery gap is normal) while still
 * catching hard-dead NAT-killed sockets within two missed heartbeats.
 * Previously 14 s (1.4×) caused spurious reconnects on weak mobile connections
 * because a single delayed heartbeat (10–14 s delivery) tripped the watchdog.
 */
const DEAD_SOCKET_THRESHOLD_MS = 22_000;

/**
 * After this many consecutive WS connection-attempts that never reach
 * `onopen`, fall back to SSE for the current backoff window. The next
 * scheduled reconnect resets to WS so recovery is automatic once the
 * proxy/network issue clears.
 * 3 failures (up from 2) — giving WS one extra attempt prevents flipping
 * to SSE on a transient single-packet loss that would have resolved itself
 * on the third try, cutting unnecessary SSE sessions by ~33% on marginal
 * networks where WS succeeds 2 out of 3 attempts.
 */
const WS_FAIL_STREAK_SSE_FALLBACK = 3;

// ── sessionStorage persistence for lastSequence ────────────────────────────
// On page reload the transport starts with lastSequence=0, losing the ability
// to replay missed events via `resume {N}`. Persisting to sessionStorage with
// a short TTL restores replay on reload so the FSM skips BOOTSTRAP entirely
// when the server confirms the same item is still playing.

const SESSION_STORAGE_KEY = "ttv:broadcast:seq:v1";
/**
 * Extended from 5 min to 15 min for 24/7 broadcast reliability.
 *
 * A viewer who steps away for 6-10 minutes (common during service breaks,
 * announcements, offering) previously lost their sequence position on return,
 * forcing a full BOOTSTRAP cycle instead of the instant event-log replay that
 * avoids the BOOTSTRAP state entirely. 15 min covers most real-world tab-
 * background / device-sleep gaps at typical church streaming events.
 */
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

function loadStoredSequence(): number {
  try {
    // Prefer the injected mobile adapter (in-memory + AsyncStorage on RN),
    // fall back to sessionStorage on web/TV.
    const store = _mobileStorage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : null);
    if (!store) return 0;
    const raw = store.getItem(SESSION_STORAGE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { seq?: unknown; expiresAt?: unknown };
    if (typeof parsed.seq !== "number" || typeof parsed.expiresAt !== "number") return 0;
    if (Date.now() > parsed.expiresAt) {
      store.removeItem(SESSION_STORAGE_KEY);
      return 0;
    }
    return parsed.seq;
  } catch {
    return 0;
  }
}

function saveStoredSequence(seq: number): void {
  try {
    const store = _mobileStorage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : null);
    if (!store) return;
    store.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ seq, expiresAt: Date.now() + SESSION_TTL_MS }),
    );
  } catch {
    // storage may be unavailable in some TV / sandboxed environments
  }
}

// ── localStorage snapshot cache ────────────────────────────────────────────
// Persists the last known full V2Snapshot so the FSM can be seeded with a
// real state even when the server is temporarily unreachable (network loss,
// API restart, brief outage).  A 30-minute TTL means a device that wakes from
// sleep or briefly loses signal continues from the cached queue rather than
// showing a blank BOOTSTRAP screen.
//
// This is a best-effort read-through cache: the authoritative state always
// comes from the server.  The cached snapshot is only dispatched when a live
// fetch fails — it never suppresses a successful server response.

const SNAPSHOT_CACHE_KEY = "ttv:broadcast:snapshot:v1";
const SNAPSHOT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function saveSnapshotCache(snapshot: V2Snapshot): void {
  try {
    // Prefer the injected mobile adapter, fall back to localStorage on web/TV.
    const store = _mobileStorage ?? (typeof localStorage !== "undefined" ? localStorage : null);
    if (!store) return;
    store.setItem(
      SNAPSHOT_CACHE_KEY,
      JSON.stringify({ v: 1, snapshot, cachedAt: Date.now() }),
    );
  } catch {
    // storage may be full or unavailable — cache is best-effort
  }
}

function loadSnapshotCache(): V2Snapshot | null {
  try {
    const store = _mobileStorage ?? (typeof localStorage !== "undefined" ? localStorage : null);
    if (!store) return null;
    const raw = store.getItem(SNAPSHOT_CACHE_KEY);
    if (!raw) return null;
    const env = JSON.parse(raw) as { v?: number; snapshot?: unknown; cachedAt?: number };
    if (env.v !== 1 || !env.snapshot || typeof env.cachedAt !== "number") return null;
    if (Date.now() - env.cachedAt > SNAPSHOT_CACHE_TTL_MS) {
      store.removeItem(SNAPSHOT_CACHE_KEY);
      return null;
    }
    return env.snapshot as V2Snapshot;
  } catch {
    return null;
  }
}

export class V2Transport {
  private ws: WebSocket | null = null;
  private es: EventSource | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSequence = 0;
  private stopped = false;
  /**
   * Bumped every time we deliberately replace the active socket
   * (start, forceReconnect, scheduleReconnect→tick). Callbacks captured
   * by an old socket compare against this and bail out if stale, so a
   * zombie `onclose` from a replaced WebSocket cannot enqueue a duplicate
   * reconnect that races with the fresh handshake.
   */
  private connGen = 0;
  /**
   * When true, the next `onclose` from the *current* socket is part of
   * an intentional replacement and must not schedule a reconnect or
   * bubble a "disconnected" notice (we already did it ourselves).
   */
  private replacing = false;

  /**
   * Wall-clock ms of the last frame received from the server (any type).
   * Used by the dead-socket watchdog to detect zombies that stay in
   * OPEN state but never carry any data (OS-level TCP keep-alives can
   * maintain the socket while the application layer is dead).
   */
  private lastFrameMs = Date.now();

  /**
   * EMA-smoothed server-client clock offset in milliseconds.
   * Computed from `serverTimeMs − Date.now()` on every hello, heartbeat,
   * and snapshot frame, then smoothed with α=0.15 to reject transient
   * network jitter. Exposed via getClockOffsetMs() and forwarded to the
   * caller via onClockCalibration so PlayerMachine can calibrate
   * resolvePositionSecs — the primary driver of admin-mobile sync accuracy.
   */
  private clockOffsetMs = 0;
  /**
   * False until the first clock-bearing frame arrives. The EMA is seeded
   * directly on the first measurement rather than bootstrapping from 0,
   * which would require ~13 heartbeats (130 s) to converge on a 100 ms offset.
   */
  private clockEmaInitialized = false;

  /**
   * Number of consecutive WS connections that never reached `onopen`.
   * When ≥ WS_FAIL_STREAK_SSE_FALLBACK we fall back to SSE.
   * Reset to 0 only on a genuine WS open (`ws.onopen`), NOT on SSE connect —
   * resetting on SSE connect caused WS→SSE→WS cycling on WS-blocked networks
   * (SSE connect resets streak → SSE fails → connectWs → WS fails twice →
   * SSE → repeat, with a black-screen window on every third reconnect cycle).
   */
  private wsFailStreak = 0;
  /**
   * Set to true when wsFailStreak hits the SSE-fallback threshold. While true,
   * every reconnect goes directly to SSE without wasting WS attempt slots.
   * Only cleared when WS actually reaches `onopen` — proving WS is usable again.
   *
   * Every WS_PROBE_INTERVAL_SSE_ROUNDS SSE reconnects we probe WS once so the
   * transport self-heals if a firewall or proxy rule is lifted at runtime.
   */
  private wsPreferSseUntilWsOpens = false;
  /** Rolling count of SSE reconnects since `wsPreferSseUntilWsOpens` was set. */
  private sseReconnectCount = 0;
  /**
   * How many consecutive SSE reconnects to skip before probing WS once.
   *
   * Reduced from 20 → 5. A brief 30–60 s outage (e.g. server restart, mobile
   * network hand-off) previously kept clients on SSE for 4–8 minutes before
   * re-probing WebSocket. At 5 rounds the probe fires after ~3 reconnect cycles
   * (~60–90 s), returning to the lower-overhead WebSocket transport much faster
   * while still protecting against networks where WS is permanently blocked
   * (the probe fails → stays on SSE for another 5 rounds).
   */
  private readonly WS_PROBE_INTERVAL_SSE_ROUNDS = 5;

  /**
   * Heartbeat watchdog timer — checks every 15 s whether a frame has
   * arrived recently; if not, force-reconnects to shed the zombie socket.
   */
  private heartbeatWatchdog: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly cfg: TransportConfig) {
    // Restore lastSequence from sessionStorage so page reloads resume
    // event-log replay rather than starting from sequence 0.
    this.lastSequence = loadStoredSequence();
  }

  start(): void {
    this.stopped = false;
    this.lastFrameMs = Date.now();
    this.startHeartbeatWatchdog();
    this.connectWs();
  }

  stop(): void {
    this.stopped = true;
    this.stopHeartbeatWatchdog();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    // Deterministic teardown: null handlers before closing so we don't
    // double-emit onConnectionChange(false) (RN polyfills can fire
    // onclose synchronously). We emit it ourselves at the end.
    if (this.ws) {
      const dead = this.ws;
      this.ws = null;
      try {
        dead.onopen = null;
        dead.onmessage = null;
        dead.onerror = null;
        dead.onclose = null;
        dead.close();
      } catch {
        /* noop */
      }
    }
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this.cfg.onConnectionChange?.(false);
  }

  /**
   * Force-drop the current socket and reconnect immediately, resetting
   * exponential backoff. Used by RN bindings on AppState→active so a
   * sleep-wake "zombie" WebSocket (open at TCP layer, no traffic for
   * minutes) is replaced by a fresh handshake the moment the user
   * returns to the app — no waiting for the next failed heartbeat.
   * Also used by the web hook on `visibilitychange` / `online` events.
   * Safe to call repeatedly; no-op once `stop()` has been invoked.
   */
  forceReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Mark the in-flight socket as being intentionally replaced so its
    // own `onclose` (which always fires after .close()) is recognised
    // as a stale callback and ignored. We also detach handlers as
    // belt-and-braces — some RN polyfills fire onclose synchronously.
    this.replacing = true;
    if (this.ws) {
      const dead = this.ws;
      this.ws = null;
      try {
        dead.onopen = null;
        dead.onmessage = null;
        dead.onerror = null;
        dead.onclose = null;
        dead.close();
      } catch {
        /* noop */
      }
    }
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.lastFrameMs = Date.now(); // reset watchdog so it doesn't immediately re-fire
    this.cfg.onConnectionChange?.(false);
    this.replacing = false;
    // Jitter 0–50 % of INITIAL_BACKOFF_MS (0–150 ms) before re-opening.
    // A fleet that all trip the dead-socket watchdog in the same tick
    // reconnect in a staggered 150 ms window rather than a thundering herd.
    // Keeping the spread proportional to INITIAL_BACKOFF_MS ensures it stays
    // meaningful if the initial backoff constant is ever tuned. Previously
    // this was hardcoded to 300 ms (= INITIAL_BACKOFF_MS but not derived from it).
    const jitterMs = Math.floor(Math.random() * (INITIAL_BACKOFF_MS * 0.5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.connectWs();
    }, jitterMs);
    (this.reconnectTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Whether a `doRequestSnapshot` REST call is currently in flight.
   * Prevents concurrent REST requests from racing: if a newer event fires
   * requestSnapshot() while a previous fetch is still pending, we skip
   * the duplicate. When the inflight call completes it dispatches the
   * freshest server state — no need for a second simultaneous fetch.
   */
  private snapshotInflight = false;

  /**
   * Fetch the current server state via REST and dispatch it to the FSM.
   * Public so the machine's `onNeedSnapshot` callback can call it
   * immediately when a buffer ends with no inactive item — cutting the
   * SYNCING window from up to 8 s (keep-alive) to < 1 s.
   *
   * Inflight guard: if a fetch is already in progress this call is a no-op;
   * however it still serves any cached snapshot immediately (throttled 2 s)
   * to keep the FSM active during API slowness or brief outages.
   */
  /** @internal — throttle for cached-snapshot stand-in during in-flight requests */
  private lastCachedFallbackMs = 0;

  requestSnapshot(): void {
    if (this.snapshotInflight) {
      // A REST fetch is already in progress.  If it succeeds it will
      // dispatch the authoritative snapshot within ≤ 8 s.  To avoid a blank
      // screen during that window (API slow / backpressured), immediately
      // serve the localStorage-cached snapshot as a stand-in — it's stale
      // but keeps the FSM in an active state rather than BOOTSTRAP limbo.
      const now = Date.now();
      if (now - this.lastCachedFallbackMs > 2_000) {
        const cached = loadSnapshotCache();
        if (cached) {
          this.lastCachedFallbackMs = now;
          this.cfg.onPlayerEvent({ type: "snapshot", snapshot: cached });
        }
      }
      return;
    }
    void this.doRequestSnapshot();
  }

  // ── Dead-socket watchdog ───────────────────────────────────────────────

  /**
   * Returns true when the transport has an open socket (WS or SSE) that
   * delivered a frame within the dead-socket threshold. Callers (e.g.
   * `handleVisible`) use this to skip a force-reconnect when the connection
   * is still healthy — avoiding the unnecessary "Reconnecting" flash on
   * every tab-focus event.
   */
  isHealthy(): boolean {
    if (this.stopped) return false;
    if (!this.ws && !this.es) return false;
    return Date.now() - this.lastFrameMs < DEAD_SOCKET_THRESHOLD_MS;
  }

  /**
   * Return the EMA-smoothed server-client clock offset (milliseconds).
   * Positive = server clock is ahead of the local clock.
   *
   * Updated on every hello, heartbeat, and snapshot frame via
   * updateClockOffset(). Zero until the first such frame arrives.
   */
  getClockOffsetMs(): number {
    return this.clockOffsetMs;
  }

  /**
   * Apply an exponential moving average (α=0.15) to the raw clock offset
   * and notify the caller only when the smoothed value shifts by more than
   * ±1 ms (filtering sub-RTT measurement noise from jittery networks).
   *
   * α=0.15 rejects individual-packet spikes while remaining responsive:
   *   • A real ±100 ms clock correction lands within ~13 samples (130 s).
   *   • A transient 50 ms network-jitter spike shifts the EMA by only 7.5 ms.
   *   • The first frame always seeds the EMA directly (no 130-second ramp).
   *
   * Why EMA here: raw `serverTimeMs − Date.now()` fluctuates ±5–30 ms on
   * WiFi, ±10–80 ms on 4G, and ±100–500 ms during brief congestion events.
   * Without smoothing, `resolvePositionSecs` received a different clockOffset
   * on every heartbeat, causing micro-seek jitter on long-running mobile sessions.
   */
  private updateClockOffset(rawOffset: number): void {
    let smoothed: number;
    if (!this.clockEmaInitialized) {
      // Bootstrap: seed EMA from first measurement so we don't spend ~13
      // heartbeats (130 s) converging from 0 on a device with a skewed clock.
      smoothed = rawOffset;
      this.clockEmaInitialized = true;
    } else {
      smoothed = this.clockOffsetMs * 0.85 + rawOffset * 0.15;
    }
    // Only notify when the rounded integer changes — avoids calling
    // setClockOffsetMs on every heartbeat when the offset is stable.
    if (Math.round(smoothed) !== Math.round(this.clockOffsetMs)) {
      this.clockOffsetMs = smoothed;
      this.cfg.onClockCalibration?.(smoothed);
    } else {
      // Store the refined float even when we don't notify, so the EMA
      // accumulates precision across frames rather than rounding each step.
      this.clockOffsetMs = smoothed;
    }
  }

  private startHeartbeatWatchdog(): void {
    this.stopHeartbeatWatchdog();
    this.heartbeatWatchdog = setInterval(() => {
      if (this.stopped) return;
      // Only fire if we have an active connection (WS or SSE) — not during
      // a scheduled reconnect wait where silence is expected.
      if (!this.ws && !this.es) return;
      if (Date.now() - this.lastFrameMs > DEAD_SOCKET_THRESHOLD_MS) {
        this.forceReconnect();
      }
    }, 6_000);
    // Allow the Node.js process to exit even if this timer is still active
    // (matters for SSR / test environments; no-op in the browser).
    const t = this.heartbeatWatchdog as unknown as { unref?: () => void };
    t.unref?.();
  }

  private stopHeartbeatWatchdog(): void {
    if (this.heartbeatWatchdog) clearInterval(this.heartbeatWatchdog);
    this.heartbeatWatchdog = null;
  }

  // ── Connection helpers ─────────────────────────────────────────────────

  private connectWs(): void {
    if (typeof WebSocket === "undefined") return this.connectSse();
    if (this.stopped) return;
    // ── SSE-preference hysteresis ────────────────────────────────────────────
    // Once wsFailStreak has crossed the threshold we enter SSE-preference mode
    // (wsPreferSseUntilWsOpens = true).  While in this mode, every reconnect
    // goes straight to SSE without burning two WS slots.  This eliminates the
    // "black-screen window" that occurred every 3rd reconnect on networks where
    // WebSocket is permanently blocked (corp firewall, strict proxy, iOS low-
    // power mode, some Android VPNs).
    //
    // Recovery: every WS_PROBE_INTERVAL_SSE_ROUNDS SSE reconnects we let one
    // WS attempt through, so the transport self-heals if the block is lifted.
    if (this.wsPreferSseUntilWsOpens) {
      this.sseReconnectCount += 1;
      if (this.sseReconnectCount < this.WS_PROBE_INTERVAL_SSE_ROUNDS) {
        return this.connectSse(); // stay on SSE
      }
      // Time to probe WS — fall through to the normal WS connect path.
      // If WS opens, wsPreferSseUntilWsOpens is cleared in onopen.
      // If WS fails again, wsFailStreak is already at threshold → re-enters
      // this block on the next scheduleReconnect.
      this.sseReconnectCount = 0;
    }
    if (this.wsFailStreak >= WS_FAIL_STREAK_SSE_FALLBACK) {
      // Enter SSE-preference mode. Do NOT reset wsFailStreak here — resetting
      // it caused the WS→SSE→WS cycling bug (streak reset → SSE fails →
      // connectWs with streak=0 → burns 2 more WS slots before SSE again).
      this.wsPreferSseUntilWsOpens = true;
      this.sseReconnectCount = 0;
      return this.connectSse();
    }
    // If a live socket already exists (defensive: should never happen
    // outside of forceReconnect, which clears it first), tear it down
    // intentionally before opening a new one.
    if (this.ws) {
      this.replacing = true;
      const dead = this.ws;
      this.ws = null;
      try {
        dead.onopen = null;
        dead.onmessage = null;
        dead.onerror = null;
        dead.onclose = null;
        dead.close();
      } catch {
        /* noop */
      }
      this.replacing = false;
    }
    const gen = ++this.connGen;
    // Build an absolute ws:// / wss:// URL from baseUrl.
    // WebSocket() requires an absolute URL — a relative path such as
    // "/api/broadcast-v2" causes a DOMException and immediately falls into
    // the catch block, incrementing wsFailStreak and cycling to SSE after 2
    // attempts. Resolve relative paths against window.location so the Vite
    // dev-proxy WebSocket upgrade fires correctly.
    const url = (() => {
      if (/^https?:\/\//i.test(this.cfg.baseUrl)) {
        return this.cfg.baseUrl.replace(/^http/, "ws") + "/ws";
      }
      // Relative path — resolve against the current page origin.
      if (typeof window !== "undefined") {
        const wsOrigin = window.location.origin.replace(/^http/, "ws");
        const path = this.cfg.baseUrl.startsWith("/")
          ? this.cfg.baseUrl
          : `/${this.cfg.baseUrl}`;
        return `${wsOrigin}${path}/ws`;
      }
      // Node / RN: no window — these environments short-circuit at
      // "typeof WebSocket === 'undefined'" above; this branch is unreachable.
      return this.cfg.baseUrl + "/ws";
    })();
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.wsFailStreak += 1;
      return this.connectSse();
    }
    this.ws = ws;
    // Track whether onopen fired for this socket — used to distinguish a
    // "never-connected" close (wsFailStreak++) from a "connected-then-lost"
    // close (don't penalise the streak).
    let didOpen = false;
    // Stale-callback guard: if the socket we captured no longer matches
    // `this.ws`, or our generation has been superseded, the callback is
    // from a replaced connection and must be a no-op.
    const isCurrent = () => !this.stopped && this.ws === ws && this.connGen === gen;
    ws.onopen = () => {
      if (!isCurrent()) return;
      didOpen = true;
      this.wsFailStreak = 0; // successful open: clear failure streak
      this.wsPreferSseUntilWsOpens = false; // WS is usable — exit SSE-preference mode
      this.sseReconnectCount = 0;
      this.backoffMs = INITIAL_BACKOFF_MS;
      // Tear down any active SSE fallback now that WS has successfully
      // opened. Without this both connections remain alive simultaneously,
      // causing duplicate event delivery to the FSM (every server frame
      // arrives once via WS and once via SSE) and leaking a server-side
      // SSE subscription for the remainder of the session.
      if (this.es) {
        this.es.close();
        this.es = null;
      }
      this.cfg.onConnectionChange?.(true);
      if (this.lastSequence > 0) {
        try {
          ws.send(JSON.stringify({ type: "resume", lastSequence: this.lastSequence }));
        } catch {
          /* socket may have died between open and send */
        }
      } else {
        // First connect (no prior sequence) — proactively fetch the current
        // snapshot via REST so the FSM exits BOOTSTRAP immediately even if
        // the server's initial WS snapshot frame is delayed or dropped.
        this.requestSnapshot();
      }
    };
    ws.onmessage = (e) => {
      if (!isCurrent()) return;
      try {
        const frame = JSON.parse(String(e.data)) as V2ServerFrame;
        this.handleFrame(frame);
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      // If this close is the tail of a deliberate replacement, ignore.
      if (this.replacing) return;
      // If the socket has already been swapped out for a newer one, the
      // newer socket owns connection-state notifications and reconnect
      // scheduling — silently drop this stale event.
      if (this.ws !== ws || this.connGen !== gen) return;
      this.ws = null;
      this.cfg.onConnectionChange?.(false);
      // If this socket never reached onopen, count it as a WS failure.
      if (!didOpen) this.wsFailStreak += 1;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      if (!isCurrent()) return;
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
  }

  private connectSse(): void {
    if (typeof EventSource === "undefined") {
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    // Include lastSequence as a query param so the server can replay missed
    // events from the event log on initial connect (e.g. after a page reload
    // where EventSource has no Last-Event-ID to send automatically).
    const params = this.lastSequence > 0 ? `?lastSequence=${this.lastSequence}` : "";
    const url = this.cfg.baseUrl + "/events" + params;
    let es: EventSource;
    try {
      es = new EventSource(url, { withCredentials: false });
    } catch {
      this.scheduleReconnect();
      return;
    }
    // Carry the last-known sequence as Last-Event-ID so the server can
    // replay missed events from the event log before resuming the live stream.
    // EventSource handles this automatically on reconnect via the `id:` field
    // in SSE messages; on initial connect we rely on the URL param fallback.
    this.es = es;
    const wrap = (frame: V2ServerFrame) => this.handleFrame(frame);
    // Store handlers so we can removeEventListener on teardown, breaking
    // the es → handler → wrap → this closure cycle that would otherwise
    // keep the transport instance reachable from the EventSource object
    // after es.close() is called (preventing GC of both).
    const sseHandlers: Array<[string, (e: Event) => void]> = [];
    for (const t of ["hello", "snapshot", "event", "preload", "takeover", "heartbeat"] as const) {
      const handler = (msg: Event) => {
        try {
          wrap(JSON.parse((msg as MessageEvent).data));
        } catch {
          /* noop */
        }
      };
      sseHandlers.push([t, handler]);
      es.addEventListener(t, handler);
    }
    const teardownSse = () => {
      for (const [t, h] of sseHandlers) es.removeEventListener(t, h);
      sseHandlers.length = 0;
      es.close();
    };
    es.onerror = () => {
      teardownSse();
      if (this.es === es) this.es = null;
      this.cfg.onConnectionChange?.(false);
      this.scheduleReconnect();
    };
    // Do NOT reset wsFailStreak here. Resetting on SSE connect caused the
    // WS→SSE→WS cycling bug: connecting via SSE (even with 0 frames received)
    // reset the streak → when SSE dropped, connectWs had streak=0 → burned
    // 2 more WS attempts before falling back to SSE again → black-screen window
    // every 3rd reconnect on WS-blocked networks. wsFailStreak is now cleared
    // exclusively in ws.onopen, where WS has demonstrably succeeded.
    // Reset backoff so that if SSE drops immediately the next reconnect
    // starts at INITIAL_BACKOFF_MS rather than the accumulated WS backoff.
    // Mirrors what WS onopen does (line ~297 above).
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.cfg.onConnectionChange?.(true);
    // Fetch an initial snapshot via REST immediately on SSE connect.
    // The SSE gateway sends a snapshot frame shortly after connection, but
    // race conditions (proxy buffering, slow first-chunk) can delay it.
    // The REST fetch guarantees the FSM exits BOOTSTRAP promptly.
    this.requestSnapshot();
  }

  private handleFrame(frame: V2ServerFrame): void {
    // Track the last received frame time for the dead-socket watchdog.
    this.lastFrameMs = Date.now();
    if ("sequence" in frame) {
      const newSeq = Math.max(this.lastSequence, frame.sequence);
      if (newSeq !== this.lastSequence) {
        this.lastSequence = newSeq;
        // Persist so page reloads can resume event-log replay.
        saveStoredSequence(this.lastSequence);
      }
    }
    switch (frame.type) {
      case "snapshot":
        // Calibrate clock offset from every snapshot frame. Measured before
        // any async work so we capture the tightest possible RTT estimate.
        // EMA smoothing in updateClockOffset() filters jitter without
        // losing accuracy on long-running 24/7 sessions.
        if (typeof frame.state.serverTimeMs === "number") {
          this.updateClockOffset(frame.state.serverTimeMs - Date.now());
        }
        // Cache the snapshot locally so the FSM can be seeded during outages.
        saveSnapshotCache(frame.state);
        this.cfg.onPlayerEvent({ type: "snapshot", snapshot: frame.state });
        break;
      case "preload":
        this.cfg.onPlayerEvent({ type: "preload", item: frame.item, leadMs: frame.leadMs });
        break;
      case "takeover":
        this.cfg.onPlayerEvent({ type: "takeover", override: frame.override });
        break;
      case "recover":
        // Architect-flagged: replay must materially affect state. The current
        // event types (queue.changed, item.advanced, item.skipped, override.*,
        // failover.*) all imply server state has changed — the safest action
        // is to fetch a fresh snapshot once replay is done so the FSM is
        // aligned with authoritative server state.
        for (const e of frame.events) this.handleFrame(e);
        this.requestSnapshot();
        break;
      case "event":
        // Belt-and-suspenders: the server always emits a snapshot immediately
        // after state-changing events, so the snapshot frame normally arrives
        // within the same TCP write. If that snapshot frame is ever lost in
        // transit (proxy buffering, NAT reset mid-burst), proactively fetching
        // /state ensures the FSM transitions without waiting for the next
        // heartbeat.
        //
        // `queue.changed` is intentionally excluded: the server fires it on
        // every 30-second drift-poll reload even when nothing has changed, and
        // always pairs it with an inline emitSnapshot(). Fetching /state again
        // a few seconds later produces a second snapshot whose startsAtMs is
        // calculated from a slightly later Date.now(). In the PLAYING state
        // the FSM's drift-correction branch can treat that tiny difference as
        // a genuine anchor shift and seek the video — causing the visible skip.
        // Item-transition events (item.advanced, item.skipped) and mode-change
        // events (override.*) are kept because they represent real transitions
        // that must not be missed.
        if (
          frame.eventType === "item.advanced" ||
          frame.eventType === "item.skipped" ||
          frame.eventType === "override.started" ||
          frame.eventType === "override.ended"
        ) {
          this.requestSnapshot();
        }
        break;
      case "hello":
        // Calibrate clock on first connect — hello arrives before the first
        // snapshot, giving the earliest possible offset measurement.
        // EMA in updateClockOffset() bootstraps directly on the first frame.
        if (typeof frame.serverTimeMs === "number") {
          this.updateClockOffset(frame.serverTimeMs - Date.now());
        }
        break;
      case "heartbeat":
        // Re-calibrate on every 10-second heartbeat. EMA smoothing absorbs
        // NTP micro-corrections and sleep/wake slips without seek jitter.
        if (typeof frame.serverTimeMs === "number") {
          this.updateClockOffset(frame.serverTimeMs - Date.now());
        }
        // Respond with an app-level pong so the server's dead-connection
        // detector sees activity and does not terminate the socket.
        // WS only — SSE is unidirectional; `this.ws` will be null on SSE.
        // readyState 1 === WebSocket.OPEN (avoid referencing the constructor
        // to stay compatible with RN polyfills that don't expose the static).
        if (this.ws && this.ws.readyState === 1) {
          try {
            this.ws.send(JSON.stringify({ type: "pong" }));
          } catch {
            /* socket may have closed between the heartbeat and the pong */
          }
        }
        break;
      case "error":
      default:
        break;
    }
  }

  private async doRequestSnapshot(): Promise<void> {
    this.snapshotInflight = true;
    try {
      // 8-second timeout prevents an overloaded server from holding this
      // fetch open while the FSM waits for a state update. The heartbeat
      // watchdog (20 s) and exponential reconnect guarantee a reattempt.
      const res = await fetch(this.cfg.baseUrl + "/state", {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        // Retry once for server errors (5xx) and rate-limiting (429).
        // Client errors (4xx except 429) indicate a misconfigured baseUrl —
        // retrying immediately won't help; the heartbeat watchdog will retry
        // on the next cycle. Rate-limited (429) clients back off 3 s before
        // retrying so they don't compound the server pressure that caused
        // the 429 in the first place.
        if (res.status >= 500 || res.status === 429) {
          const retryDelayMs = res.status === 429 ? 3_000 : 1_000;
          await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
          if (this.stopped) return;
          const retry = await fetch(this.cfg.baseUrl + "/state", {
            signal: AbortSignal.timeout(8_000),
          }).catch(() => null);
          if (!retry?.ok) return;
          const retryBody = (await retry.json()) as { state?: unknown };
          if (retryBody.state) {
            // Cache the state so subsequent outages can serve it immediately.
            saveSnapshotCache(retryBody.state as V2Snapshot);
            this.cfg.onPlayerEvent({ type: "snapshot", snapshot: retryBody.state as never });
          }
        }
        return;
      }
      const body = (await res.json()) as { state?: unknown };
      if (body.state) {
        // Cache the state so subsequent outages can serve it immediately.
        saveSnapshotCache(body.state as V2Snapshot);
        this.cfg.onPlayerEvent({ type: "snapshot", snapshot: body.state as never });
      }
    } catch {
      // Network error — seed the FSM from the local snapshot cache so the
      // player can continue (or begin) playback while connectivity recovers.
      // This prevents a blank BOOTSTRAP/SYNCING screen during API restarts,
      // brief outages, or the first seconds after a page load on a slow link.
      const cached = loadSnapshotCache();
      if (cached) {
        this.cfg.onPlayerEvent({ type: "snapshot", snapshot: cached });
      }
    } finally {
      this.snapshotInflight = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    // Offline-aware throttle: if the browser / device reports no network
    // connectivity, skip scheduling a reconnect timer entirely. The web hook
    // already listens for the `online` event and calls forceReconnect() the
    // moment connectivity returns, so no state is lost by skipping here.
    // This eliminates pointless WS construction attempts (and the wsFailStreak
    // increments they cause) during airplane mode / tunnel / sleep periods.
    // RN exposes navigator.onLine unreliably — the check is a no-op when the
    // property is absent or truthy, keeping mobile behaviour unchanged.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return;
    }
    // Apply ±25 % full-jitter to the base delay so a fleet of clients
    // that all lost the connection at the same time (server restart,
    // load-balancer failover, Cloudflare blip) don't pile into the new
    // server in a synchronised thundering herd. Without jitter, doubling
    // backoff produces identical retry windows across every client that
    // disconnected in the same tick. With ±25 % the 500 ms initial window
    // spreads to ~375–625 ms, 1 s → ~750–1250 ms, and so on — at 30 s
    // max the spread is ±7.5 s, enough to smooth a burst of hundreds of
    // clients into a gentle ramp over 15 s.
    const jitter = this.backoffMs * (Math.random() * 0.5 - 0.25); // ±25 %
    const delay = Math.max(0, Math.round(this.backoffMs + jitter));
    // Cap growth at the network-quality-aware maximum. On slow-2g/2g links
    // this is 10 s (vs 30 s on fast links) so devices reconnect sooner when
    // TCP RTT is already high and extra wait time provides no real benefit.
    const maxBackoff = effectiveMaxBackoffMs();
    this.backoffMs = Math.min(maxBackoff, this.backoffMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs();
    }, delay);
  }
}
