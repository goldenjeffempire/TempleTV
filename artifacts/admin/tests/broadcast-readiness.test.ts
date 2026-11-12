import { test } from "node:test";
import assert from "node:assert/strict";
import { broadcastReadiness } from "../src/lib/broadcast-readiness.js";

test("dashboard connection without broadcast data is not readiness", () => {
  assert.equal(broadcastReadiness(undefined, false, null, null).ready, false);
});
test("lock contention explains why operator actions cannot start the daemon", () => {
  const result = broadcastReadiness(undefined, false, { startupPhase: "leadership-lock-attempt-3" }, null);
  assert.match(result.message, /database leadership/);
  assert.equal(result.ready, false);
});
test("generic startup failure is distinct from an off-air channel", () => {
  assert.match(broadcastReadiness(undefined, false, { code: "BROADCAST_DAEMON_NOT_READY" }, null).message, /not finished starting/);
});
test("request failures override stale successful health and snapshot data", () => {
  for (const [healthError, stateError] of [[new Error("502"), null], [null, new Error("503")]]) {
    const result = broadcastReadiness(true, true, healthError, stateError);
    assert.equal(result.ready, false);
    assert.match(result.message, /not confirmation.*off air/);
  }
});
test("both started engine and successful snapshot are required", () => {
  assert.equal(broadcastReadiness(false, true, null, null).ready, false);
  assert.equal(broadcastReadiness(true, false, null, null).ready, false);
  assert.equal(broadcastReadiness(undefined, true, null, null).ready, false);
});
test("successful recovery permits controls and preview without page reload", () => {
  assert.equal(broadcastReadiness(true, true, null, null).ready, true);
});
