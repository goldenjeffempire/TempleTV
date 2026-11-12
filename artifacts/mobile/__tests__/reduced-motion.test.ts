import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("shared reduced-motion subscription", async () => {
  const { createReducedMotionStore } = await import("../lib/reducedMotionStore.js");
  it("uses one native read/listener for many cards and cleans up the last subscriber", async () => {
    let reads = 0, watches = 0, stops = 0;
    const store = createReducedMotionStore({
      read: async () => { reads++; return false; },
      watch: () => { watches++; return () => { stops++; }; },
    });
    const remove = Array.from({ length: 80 }, () => store.subscribe(() => {}));
    await Promise.resolve();
    assert.equal(reads, 1); assert.equal(watches, 1);
    assert.equal(store.getSnapshot(), false);
    remove.slice(0, -1).forEach(fn => fn()); assert.equal(stops, 0);
    remove.at(-1)!(); assert.equal(stops, 1);
  });
  it("does not let a late initial read overwrite a newer accessibility event", async () => {
    let resolve!: (value: boolean) => void;
    let update!: (value: boolean) => void;
    const store = createReducedMotionStore({
      read: () => new Promise<boolean>(done => { resolve = done; }),
      watch: callback => { update = callback; return () => {}; },
    });
    const stop = store.subscribe(() => {});
    update(true); resolve(false);
    await Promise.resolve();
    assert.equal(store.getSnapshot(), true); stop();
  });
  it("ignores stale native answers after unmount", async () => {
    let resolve!: (value: boolean) => void;
    const store = createReducedMotionStore({
      read: () => new Promise<boolean>(done => { resolve = done; }), watch: () => () => {},
    });
    const stop = store.subscribe(() => {}); stop(); resolve(false);
    await Promise.resolve();
    assert.equal(store.getSnapshot(), true);
  });
  it("handles an unavailable OS preference without crashing", async () => {
    const store = createReducedMotionStore({
      read: async () => { throw new Error("Native preference unavailable"); }, watch: () => () => {},
    });
    const stop = store.subscribe(() => {}); await Promise.resolve(); await Promise.resolve();
    assert.equal(store.getSnapshot(), true); stop();
  });
});
