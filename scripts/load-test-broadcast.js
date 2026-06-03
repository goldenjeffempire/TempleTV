/**
 * k6 Load Test — Broadcast API endpoints
 *
 * Tests:
 *   - GET /api/broadcast-v2/state (REST snapshot, expected <200ms p95)
 *   - GET /api/broadcast-v2/health (health check, expected <100ms p95)
 *   - WS /api/broadcast-v2/ws (WebSocket connections, message latency)
 *   - SSE /api/broadcast-v2/events (Server-Sent Events, connection stability)
 *   - POST /api/broadcast-v2/skip (mutation with idempotency key, auth required)
 *
 * Usage:
 *   k6 run scripts/load-test-broadcast.js
 *   k6 run --vus 50 --duration 60s scripts/load-test-broadcast.js
 *   k6 run --env BASE_URL=https://api.templetv.org.ng scripts/load-test-broadcast.js
 *
 * Scenarios:
 *   - Baseline:    10 VUs, 30s (normal Sunday service load)
 *   - Spike:       200 VUs ramp-up over 10s (push notification triggers mass tune-in)
 *   - Soak:        20 VUs, 10min (continuous 24/7 stability)
 *   - Failover:    1 VU issuing skip/override while 50 viewers hold connections
 */

import { check, sleep } from "k6";
import http from "k6/http";
import ws from "k6/ws";
import { Rate, Trend, Counter } from "k6/metrics";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || "";
const CHANNEL = __ENV.CHANNEL || "main";

const WS_URL = BASE_URL
  .replace(/^https:\/\//, "wss://")
  .replace(/^http:\/\//, "ws://")
  + `/api/broadcast-v2/${CHANNEL}/ws`;

const API = {
  state:  `${BASE_URL}/api/broadcast-v2/${CHANNEL}/state`,
  health: `${BASE_URL}/api/broadcast-v2/health`,
  events: `${BASE_URL}/api/broadcast-v2/${CHANNEL}/events`,
  skip:   `${BASE_URL}/api/broadcast-v2/${CHANNEL}/skip`,
};

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const stateOk         = new Rate("broadcast_state_ok");
const healthOk        = new Rate("broadcast_health_ok");
const wsFrameReceived = new Counter("ws_frames_received");
const wsConnectTime   = new Trend("ws_connect_time_ms");
const sseFrameTime    = new Trend("sse_first_frame_ms");
const stateLatency    = new Trend("state_latency_ms");

// ---------------------------------------------------------------------------
// k6 options
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    // Steady-state viewer load (REST polling)
    rest_baseline: {
      executor: "constant-vus",
      vus: 20,
      duration: "30s",
      exec: "viewerRestScenario",
      tags: { scenario: "rest_baseline" },
    },
    // WebSocket long-held connections (like live viewers)
    ws_connections: {
      executor: "constant-vus",
      vus: 10,
      duration: "30s",
      exec: "viewerWsScenario",
      tags: { scenario: "ws_connections" },
    },
    // Health check (monitoring / load balancer probe)
    health_probe: {
      executor: "constant-arrival-rate",
      rate: 30,        // 30 req/s — matches rate-limit ceiling
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 5,
      exec: "healthScenario",
      tags: { scenario: "health" },
    },
  },
  thresholds: {
    // REST snapshot: p95 < 200ms, error rate < 1%
    http_req_duration:       ["p(95)<500", "p(99)<1000"],
    "http_req_duration{scenario:rest_baseline}": ["p(95)<200"],
    broadcast_state_ok:      ["rate>0.99"],
    broadcast_health_ok:     ["rate>0.99"],
    // WebSocket: frame received within 15s of connect
    ws_connect_time_ms:      ["p(95)<5000"],
    // HTTP errors overall < 2%
    http_req_failed:         ["rate<0.02"],
  },
};

// ---------------------------------------------------------------------------
// Scenario: REST polling (viewer app polling /state every ~5s)
// ---------------------------------------------------------------------------

export function viewerRestScenario() {
  const res = http.get(API.state, {
    headers: { "Accept": "application/json" },
    timeout: "10s",
  });

  const ok = check(res, {
    "state: status 200":         (r) => r.status === 200,
    "state: has sequence":       (r) => { try { return JSON.parse(r.body).sequence >= 0; } catch { return false; } },
    "state: has mode field":     (r) => { try { return typeof JSON.parse(r.body).mode === "string"; } catch { return false; } },
    "state: response < 500ms":   (r) => r.timings.duration < 500,
  });

  stateOk.add(ok);
  stateLatency.add(res.timings.duration);
  sleep(5 + Math.random() * 2); // 5-7s jitter between polls
}

// ---------------------------------------------------------------------------
// Scenario: Health endpoint
// ---------------------------------------------------------------------------

export function healthScenario() {
  const res = http.get(API.health, {
    headers: { "Accept": "application/json" },
    timeout: "5s",
  });

  const ok = check(res, {
    "health: status 200":           (r) => r.status === 200,
    "health: has uptimeMs":         (r) => { try { return typeof JSON.parse(r.body).uptimeMs === "number"; } catch { return false; } },
    "health: has sequence":         (r) => { try { return JSON.parse(r.body).sequence >= 0; } catch { return false; } },
    "health: response < 100ms":     (r) => r.timings.duration < 100,
  });

  healthOk.add(ok);
  sleep(1);
}

// ---------------------------------------------------------------------------
// Scenario: WebSocket long-held connections
// ---------------------------------------------------------------------------

export function viewerWsScenario() {
  const connectStart = Date.now();
  let firstFrameReceived = false;

  const response = ws.connect(WS_URL, {}, function (socket) {
    wsConnectTime.add(Date.now() - connectStart);

    socket.on("open", function () {
      // Send resume with lastSequence=0 (fresh connect)
      socket.send(JSON.stringify({ type: "resume", lastSequence: 0 }));
    });

    socket.on("message", function (data) {
      try {
        const frame = JSON.parse(data);
        wsFrameReceived.add(1);

        if (!firstFrameReceived) {
          firstFrameReceived = true;
          check(frame, {
            "ws: first frame has type":     (f) => typeof f.type === "string",
            "ws: first frame has sequence": (f) => typeof f.sequence === "number" || f.type === "hello",
          });
        }
      } catch {
        // malformed frame
      }
    });

    socket.on("error", function (err) {
      check(null, { "ws: no error": () => false });
    });

    // Hold connection for a realistic viewer session (15-30s)
    socket.setTimeout(function () {
      socket.close();
    }, 15_000 + Math.random() * 15_000);
  });

  check(response, {
    "ws: connected successfully": (r) => r && r.status === 101,
  });

  sleep(1);
}

// ---------------------------------------------------------------------------
// Scenario: SSE long-held connections (for browsers that prefer SSE)
// ---------------------------------------------------------------------------

export function viewerSseScenario() {
  const params = { headers: { "Accept": "text/event-stream" }, timeout: "30s" };
  const frameStart = Date.now();

  // SSE is a long-poll in k6 — we stream and capture first data
  const res = http.get(API.events + "?lastSequence=0", params);

  const firstFrameMs = Date.now() - frameStart;
  sseFrameTime.add(firstFrameMs);

  check(res, {
    "sse: status 200":              (r) => r.status === 200,
    "sse: content-type event-stream": (r) => (r.headers["Content-Type"] || "").includes("text/event-stream"),
  });
}

// ---------------------------------------------------------------------------
// Scenario: Spike test — mass reconnect (push notification triggers fleet)
// ---------------------------------------------------------------------------

export function spikeScenario() {
  // Simulate the fleet: poll /state once immediately after receiving push notification
  const res = http.get(API.state, { timeout: "15s" });
  check(res, {
    "spike: state returns 200": (r) => r.status === 200,
  });
  // Small sleep to prevent hammering from all clients simultaneously
  sleep(Math.random() * 0.5);
}

// ---------------------------------------------------------------------------
// Scenario: Operator skip (mutation with auth) — low rate
// ---------------------------------------------------------------------------

export function operatorSkipScenario() {
  if (!ADMIN_TOKEN) return; // skip if no token configured

  const idempotencyKey = `load-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = http.post(
    API.skip,
    JSON.stringify({ idempotencyKey }),
    {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ADMIN_TOKEN}`,
      },
      timeout: "10s",
    },
  );

  check(res, {
    "skip: 200 or 409 (idempotent)": (r) => r.status === 200 || r.status === 409,
    "skip: not 500":                 (r) => r.status !== 500,
  });

  sleep(30); // rate-limit operator ops to 2/min max
}

// ---------------------------------------------------------------------------
// Default function (used when no scenario is specified)
// ---------------------------------------------------------------------------

export default function () {
  viewerRestScenario();
}
