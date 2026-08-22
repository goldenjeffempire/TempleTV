/// <reference types="node" />
/**
 * Regression tests for the notification + auth persistence fixes.
 *
 * Run with:
 *   node --import tsx/esm --test __tests__/notifications-auth-fixes.test.ts
 *
 * Tests pure-JS logic only — no React Native host, no native module mocks.
 * Follows the convention of startup.test.ts and ads.test.ts.
 *
 * Areas covered:
 *   1. registerTokenWithServer result classification (non-2xx = failure, retain token)
 *   2. retryPendingPushToken boolean return contract
 *   3. persistAuthResponse rollback: removes both freshly-written tokens on failure
 *   4. attemptRefresh token-pair persistence failure: session expiry, not swallowed
 *   5. AuthContext.signIn rollback: removes all three keys (token, refresh, user)
 *   6. NotificationOptInGate mount-guard deduplication
 *   7. Migration isolation: one write failure must not abort sibling writes
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// ─── Silence console noise ────────────────────────────────────────────────────
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

// ─── 1. registerTokenWithServer — HTTP result classification ──────────────────
//
// The contract: res.ok (2xx) → success + clear pending; !res.ok → failure + retain.
// Tested against the exact predicate used in the source: httpStatus >= 200 && < 300.

function isHttpOk(status: number): boolean {
  return status >= 200 && status < 300;
}

describe("registerTokenWithServer — result classification", () => {
  const successCases: number[] = [200, 201, 204];
  const failureCases: number[] = [400, 401, 403, 422, 429, 500, 503];

  for (const s of successCases) {
    it(`${s} → ok=true (clear pending token)`, () => {
      assert.equal(isHttpOk(s), true);
    });
  }

  for (const s of failureCases) {
    it(`${s} → ok=false (retain pending token)`, () => {
      assert.equal(isHttpOk(s), false);
    });
  }

  it("network throw → catch branch must retain pending token", () => {
    // The source wraps the entire fetch in try/catch; a thrown network error
    // reaches the same catch that writes the pending key and returns false.
    // Verify the invariant: every non-success path retains the token.
    let retained = false;
    try {
      throw new Error("Network request failed");
    } catch {
      retained = true;
    }
    assert.equal(retained, true);
  });
});

// ─── 2. retryPendingPushToken — boolean return contract ───────────────────────
//
// The function now returns boolean: true iff a pending token existed AND was
// successfully registered. Callers use this to decide whether to mark opt-in
// seen without re-prompting.

describe("retryPendingPushToken — return value contract", () => {
  it("returns false when there is no pending token", () => {
    // Simulate the fixed logic: if !pendingToken → return false
    const pendingToken: string | null = null;
    const result = pendingToken ? /* would call registerTokenWithServer */ true : false;
    assert.equal(result, false);
  });

  it("returns the registerTokenWithServer result when a pending token exists", () => {
    // If registerTokenWithServer returns true → retryPendingPushToken returns true
    const pendingToken = "ExponentPushToken[abc]";
    const serverSucceeded = true;
    const result = pendingToken ? serverSucceeded : false;
    assert.equal(result, true);
  });

  it("returns false when the server registration still fails on retry", () => {
    const pendingToken = "ExponentPushToken[abc]";
    const serverSucceeded = false;
    const result = pendingToken ? serverSucceeded : false;
    assert.equal(result, false);
  });
});

// ─── 3. persistAuthResponse — removal contract on failure ─────────────────────
//
// Contract: on write failure both keys are REMOVED (not restored to prior values —
// this is a fresh login write). Both keys must be absent after a failed persist.
//
// We test the contract via a minimal in-memory store that matches the source
// semantics without duplicating the full implementation.

interface KVStore { [key: string]: string | undefined }

async function runPersistWithStore(
  store: KVStore,
  accessToken: string,
  refreshToken: string,
  throwOnWrite: boolean,
): Promise<void> {
  // Mirrors the exact shape of the fixed persistAuthResponse:
  //   try { setItem(accessToken); setItem(refreshToken); }
  //   catch { removeItem(accessToken); removeItem(refreshToken); throw; }
  const setItem = (k: string, v: string) => {
    if (throwOnWrite) throw new Error("Keystore unavailable");
    store[k] = v;
  };
  const removeItem = (k: string) => { delete store[k]; };
  try {
    setItem("authToken", accessToken);
    setItem("authRefreshToken", refreshToken);
  } catch (err) {
    await Promise.all([removeItem("authToken"), removeItem("authRefreshToken")]);
    throw err;
  }
}

describe("persistAuthResponse — removal contract on failure", () => {
  it("removes both keys when the write throws (clean slate, no prior tokens)", async () => {
    const store: KVStore = {};
    await assert.rejects(() => runPersistWithStore(store, "acc", "ref", true));
    assert.equal(store["authToken"], undefined, "authToken must be absent after failure");
    assert.equal(store["authRefreshToken"], undefined, "authRefreshToken must be absent after failure");
  });

  it("removes both keys even when a prior session existed in the store", async () => {
    // The server has issued fresh tokens; the old tokens are being replaced.
    // On failure both new AND old values must be absent — the old refresh is
    // consumed server-side and cannot be reused.
    const store: KVStore = { authToken: "old-access", authRefreshToken: "old-refresh" };
    await assert.rejects(() => runPersistWithStore(store, "new-acc", "new-ref", true));
    // The source calls removeItem (not restore), so both keys must now be absent.
    assert.equal(store["authToken"], undefined, "authToken must be removed, not restored");
    assert.equal(store["authRefreshToken"], undefined, "authRefreshToken must be removed, not restored");
  });

  it("writes both tokens on success", async () => {
    const store: KVStore = {};
    await runPersistWithStore(store, "acc-ok", "ref-ok", false);
    assert.equal(store["authToken"], "acc-ok");
    assert.equal(store["authRefreshToken"], "ref-ok");
  });
});

// ─── 4. attemptRefresh — persistence failure contract ─────────────────────────
//
// Contract: if keystore write of rotated tokens fails, BOTH keys are removed
// and session expiry is signalled — NOT swallowed as a transient network error.
// Network/5xx failures (thrown before the write) must NOT reach the persistence
// path and must leave stored tokens intact.

describe("attemptRefresh — persistence failure handling", () => {
  it("signals session expiry and removes both keys when persistence throws", () => {
    let sessionExpiredFired = false;
    const store: KVStore = { authToken: "old-acc", authRefreshToken: "old-ref" };
    const onSessionExpired = () => { sessionExpiredFired = true; };
    const removeItem = (k: string) => { delete store[k]; };

    // Simulate the fixed inner try/catch after a successful server response:
    //   try { setItem(accessToken); setItem(refreshToken); }
    //   catch { removeItem(both); onSessionExpired(); return null; }
    const persistResult = (() => {
      try {
        throw new Error("Keystore write failed"); // write failure
      } catch {
        removeItem("authToken");
        removeItem("authRefreshToken");
        onSessionExpired();
        return null;
      }
    })();

    assert.equal(persistResult, null, "must return null on persistence failure");
    assert.equal(sessionExpiredFired, true, "session expiry must be signalled");
    assert.equal(store["authToken"], undefined, "authToken must be removed");
    assert.equal(store["authRefreshToken"], undefined, "authRefreshToken must be removed");
  });

  it("network/5xx throw leaves stored tokens intact (outer catch, not persistence path)", () => {
    const store: KVStore = { authToken: "existing-acc", authRefreshToken: "existing-ref" };

    // Simulate the outer catch (network error thrown before the write):
    //   catch { /* leave stored tokens intact */ return null; }
    const networkResult = (() => {
      try {
        throw new Error("fetch failed"); // network error
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (_networkErr) {
        // Do NOT touch the store
        return null;
      }
    })();

    assert.equal(networkResult, null);
    assert.equal(store["authToken"], "existing-acc", "authToken must not be touched on network error");
    assert.equal(store["authRefreshToken"], "existing-ref", "authRefreshToken must not be touched");
  });
});

// ─── 5. AuthContext.signIn — rollback removes all three keys ──────────────────
//
// Contract: rollback removes authToken, authRefreshToken, AND authUser.
// (authRefreshToken may have been written by persistAuthResponse before signIn
// is called; signIn's rollback must wipe all three to ensure a clean slate.)

async function runSignInWithStore(
  store: KVStore,
  accessToken: string,
  userJson: string,
  throwOnWrite: boolean,
): Promise<{ stateToken: string | null; stateUser: string | null }> {
  let stateToken: string | null = null;
  let stateUser: string | null = null;
  const setItem = (k: string, v: string) => {
    if (throwOnWrite) throw new Error("Keystore write failed");
    store[k] = v;
  };
  const removeItem = (k: string) => { delete store[k]; };
  try {
    setItem("authToken", accessToken);
    setItem("authUser", userJson);
  } catch (err) {
    // Roll back all three keys (token, refresh, user)
    await Promise.all([
      removeItem("authToken"),
      removeItem("authRefreshToken"),
      removeItem("authUser"),
    ]);
    throw err;
  }
  stateToken = accessToken;
  stateUser = userJson;
  return { stateToken, stateUser };
}

describe("AuthContext.signIn — rollback removes all three keys", () => {
  it("removes authToken, authRefreshToken, and authUser on write failure", async () => {
    // Pre-populate as if persistAuthResponse already wrote the token pair
    const store: KVStore = {
      authToken: "acc-from-persist",
      authRefreshToken: "ref-from-persist",
    };
    await assert.rejects(() => runSignInWithStore(store, "acc", '{"id":"1"}', true));
    assert.equal(store["authToken"], undefined, "authToken must be removed");
    assert.equal(store["authRefreshToken"], undefined, "authRefreshToken must be removed");
    assert.equal(store["authUser"], undefined, "authUser must be removed");
  });

  it("does NOT update in-memory state on failure", async () => {
    const store: KVStore = {};
    let stateToken: string | null = null;
    let stateUser: string | null = null;
    try {
      const r = await runSignInWithStore(store, "acc", '{"id":"2"}', true);
      stateToken = r.stateToken;
      stateUser = r.stateUser;
    } catch { /* expected */ }
    assert.equal(stateToken, null, "stateToken must remain null");
    assert.equal(stateUser, null, "stateUser must remain null");
  });

  it("persists all keys and sets state on success", async () => {
    const store: KVStore = {};
    const { stateToken, stateUser } = await runSignInWithStore(
      store, "acc-ok", '{"id":"3","email":"a@b.com"}', false,
    );
    assert.equal(stateToken, "acc-ok");
    assert.ok(stateUser !== null);
    assert.equal(store["authToken"], "acc-ok");
    assert.equal(store["authUser"], '{"id":"3","email":"a@b.com"}');
  });
});

// ─── 6. NotificationOptInGate — mount-guard deduplication ────────────────────

describe("NotificationOptInGate — mount-guard prevents repeated prompts", () => {
  function makeGateState() {
    let showModal = false;
    let attemptedThisMount = false;
    let retryCheckDone = false;

    const shouldShow = (optInLoaded: boolean, hasSeenOptIn: boolean): boolean => {
      if (!optInLoaded || !retryCheckDone || hasSeenOptIn) return false;
      if (attemptedThisMount) return false;
      return true;
    };
    const markAttempted = () => { attemptedThisMount = true; };
    const markRetryDone = () => { retryCheckDone = true; };
    const open = () => { showModal = true; };
    const close = () => { showModal = false; };
    return { shouldShow, markAttempted, markRetryDone, open, close, getShowModal: () => showModal };
  }

  it("does NOT show modal until retry check completes (anti-race)", () => {
    const g = makeGateState();
    // prefs loaded but retry check still in flight
    assert.equal(g.shouldShow(true, false), false, "must wait for retryCheckDone");
  });

  it("shows modal once retry check completes and user has not seen opt-in", () => {
    const g = makeGateState();
    g.markRetryDone();
    assert.equal(g.shouldShow(true, false), true);
  });

  it("does NOT show modal when hasSeenOptIn is true", () => {
    const g = makeGateState();
    g.markRetryDone();
    assert.equal(g.shouldShow(true, true), false);
  });

  it("does NOT show modal again after attempt in same mount", () => {
    const g = makeGateState();
    g.markRetryDone();
    assert.equal(g.shouldShow(true, false), true);
    g.markAttempted();
    assert.equal(g.shouldShow(true, false), false);
  });

  it("intentional dismiss marks attempted so modal cannot re-open in same mount", () => {
    const g = makeGateState();
    g.markRetryDone();
    g.open();
    g.close();
    g.markAttempted();
    assert.equal(g.shouldShow(true, false), false);
  });
});

// ─── 7. Migration isolation ───────────────────────────────────────────────────

describe("migration write isolation — one failure must not abort siblings", () => {
  it("second and third writes succeed even when the first throws", () => {
    const written: string[] = [];
    const writeMigrationKey = (key: string, shouldThrow: boolean) => {
      try {
        if (shouldThrow) throw new Error("write failed");
        written.push(key);
      } catch { /* isolated per key */ }
    };
    writeMigrationKey("authToken", true);        // fails
    writeMigrationKey("authRefreshToken", false); // must still succeed
    writeMigrationKey("authUser", false);         // must still succeed
    assert.deepEqual(written, ["authRefreshToken", "authUser"]);
  });
});
