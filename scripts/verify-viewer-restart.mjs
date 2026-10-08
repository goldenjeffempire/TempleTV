// Development-only protocol probe; never prints or saves its bearer credential.
import { readFile } from "node:fs/promises";
const base = process.argv[2] || "http://127.0.0.1:8080";
const witnessPath = process.argv[3];
if (!witnessPath) throw new Error("Provide a private restart-witness file path as the third argument.");
if (process.env.NODE_ENV === "production" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) {
  throw new Error("This controlled viewer probe is restricted to development loopback.");
}
const streamId = "temple-tv-live";
const started = Date.now();
let sessionId;
let sequence = Date.now() * 1000;
let heartbeatTimer;
let busy = false;
let lastSuccessfulHeartbeat = 0;
let offlineAt = null;
let recoveredAt = null;
let passed = false;
let witnessed = false;
const emit = (event, details = {}) =>
  console.log(JSON.stringify({ event, at: new Date().toISOString(), elapsedMs: Date.now() - started, ...details }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(path, body) {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  }
  return response.status === 204 ? undefined : response.json();
}
async function heartbeat() {
  if (busy) return;
  busy = true;
  try {
    await request("/api/viewer-tracking/heartbeat", {
      sessionId, streamId, platform: "mobile", sequence: ++sequence,
    });
    lastSuccessfulHeartbeat = Date.now();
  } catch {
    // Keep the same capability through the outage, as the installed app must.
  } finally { busy = false; }
}
async function waitForCount(expected, deadline) {
  while (Date.now() < deadline) {
    const state = await request("/api/playback/state");
    if (state.viewerCount === expected) return;
    await pause(1000);
  }
  throw new Error(`Count did not converge to ${expected}`);
}
try {
  const initial = await request("/api/playback/state");
  if (initial.viewerCount !== 0) throw new Error("Refusing to disturb an occupied or unavailable test station");
  const credential = await request("/api/viewer-tracking/issue", { streamId, platform: "mobile" });
  sessionId = credential.sessionId;
  sequence = Math.max(sequence, credential.nextSequence);
  heartbeatTimer = setInterval(() => void heartbeat(), 5000);
  await heartbeat();
  await waitForCount(1, Date.now() + 10000);
  emit("READY_TO_RESTART", { count: 1 });
  let lastReported = 1;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    if (!witnessed) {
      try {
        const witness = JSON.parse(await readFile(witnessPath, "utf8"));
        witnessed = Number.isInteger(witness.previousPid) &&
          Number.isInteger(witness.newPid) && witness.newPid !== witness.previousPid &&
          witness.completedAt > started;
      } catch { /* Controller has not verified the new process yet. */ }
    }
    try {
      const state = await request("/api/playback/state");
      if (witnessed && recoveredAt === null) {
        recoveredAt = Date.now();
        emit("NEW_PROCESS_CONFIRMED", {
          // Controller verification may arrive after HTTP service resumes.
          // This interval is not a public-availability SLA measurement.
          untilWitnessMs: offlineAt === null ? null : recoveredAt - offlineAt,
          count: state.viewerCount, differentProcessVerified: true,
        });
        await heartbeat();
      }
      if (state.viewerCount !== lastReported) {
        emit("COUNT_CHANGED", { count: state.viewerCount });
        lastReported = state.viewerCount;
      }
      if (recoveredAt !== null && state.viewerCount === 1 && lastSuccessfulHeartbeat >= recoveredAt) {
        emit("VIEWER_REJOINED", {
          count: 1, postWitnessHeartbeatMs: Date.now() - recoveredAt, sameCredential: true,
        });
        clearInterval(heartbeatTimer);
        await request("/api/viewer-tracking/leave", { sessionId, streamId, sequence: ++sequence });
        await waitForCount(0, Date.now() + 10000);
        emit("PASS", { count: 0 });
        passed = true;
        break;
      }
    } catch (error) {
      // Poll below the 60/min route limit. A 429 is not process downtime.
      if (error.status === 429) emit("PROBE_THROTTLED");
      else if (offlineAt === null) {
        offlineAt = Date.now();
        emit("API_UNAVAILABLE");
      }
    }
    await pause(2500);
  }
  if (!passed) {
    throw new Error("Restart recovery was not observed within five minutes");
  }
} catch (error) {
  emit("FAIL", { message: error.message });
  process.exitCode = 1;
} finally {
  clearInterval(heartbeatTimer);
  if (sessionId) {
    await request("/api/viewer-tracking/leave", { sessionId, streamId, sequence: ++sequence }).catch(() => {});
  }
}
