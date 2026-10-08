import assert from "node:assert/strict";
import { test } from "node:test";
import { probeBinaryAvailability } from "../../src/lib/binary-availability.js";

test("successful binary probe reports available", async () => {
  assert.equal(await probeBinaryAvailability(process.execPath, ["-e", "process.exit(0)"]), true);
});

test("nonzero exit and missing binary report unavailable", async () => {
  assert.equal(await probeBinaryAvailability(process.execPath, ["-e", "process.exit(1)"]), false);
  assert.equal(await probeBinaryAvailability("/nonexistent/temple-tv-health-probe"), false);
});

test("a hung binary is bounded without blocking the event loop", async () => {
  let otherWorkRan = false;
  const probe = probeBinaryAvailability(process.execPath, ["-e", "setInterval(() => {}, 10000)"], 100);
  setTimeout(() => { otherWorkRan = true; }, 10);
  assert.equal(await probe, false);
  assert.equal(otherWorkRan, true);
});

test("invalid spawn input settles unavailable rather than throwing", async () => {
  assert.equal(await probeBinaryAvailability(""), false);
});
