/// <reference types="node" />
/**
 * AdMob monetization — pure-logic regression tests.
 *
 * Run with: pnpm --filter @workspace/mobile test
 *
 * Covers the environment-independent building blocks of the ad stack:
 *  - Frequency capping (cooldown + per-session cap + eligibility math)
 *  - Full-jitter exponential backoff
 *  - Ad config resolution (publisher id, env-driven ad unit ids, content rating,
 *    test-device parsing, unit-id selection / kill-switch)
 *
 * Native-module-dependent code (BannerAd, useAppOpenAd, UMP consent) is
 * intentionally excluded — those require a real device / SDK.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("adFrequency.FrequencyCapper", () => {
  it("allows the first impression and enforces cooldown", async () => {
    const { FrequencyCapper } = await import("../lib/ads/adFrequency.js");
    const capper = new FrequencyCapper({ appOpen: { cooldownMs: 1000 } });
    assert.equal(capper.canShow("appOpen", 0), true);
    capper.markShown("appOpen", 0);
    assert.equal(capper.canShow("appOpen", 500), false, "within cooldown");
    assert.equal(capper.canShow("appOpen", 1000), true, "cooldown elapsed");
  });

  it("enforces a per-session cap", async () => {
    const { FrequencyCapper } = await import("../lib/ads/adFrequency.js");
    const capper = new FrequencyCapper({
      inter: { cooldownMs: 0, maxPerSession: 2 },
    });
    capper.markShown("inter", 0);
    capper.markShown("inter", 10);
    assert.equal(capper.shownCount("inter"), 2);
    assert.equal(capper.canShow("inter", 100), false, "session cap reached");
    assert.equal(capper.msUntilEligible("inter", 100), Number.POSITIVE_INFINITY);
  });

  it("returns 0 eligibility delay for keys with no rule", async () => {
    const { FrequencyCapper } = await import("../lib/ads/adFrequency.js");
    const capper = new FrequencyCapper();
    assert.equal(capper.canShow("anything", 0), true);
    assert.equal(capper.msUntilEligible("anything", 0), 0);
  });

  it("reset() clears all counters", async () => {
    const { FrequencyCapper } = await import("../lib/ads/adFrequency.js");
    const capper = new FrequencyCapper({ k: { cooldownMs: 100 } });
    capper.markShown("k", 0);
    capper.reset();
    assert.equal(capper.canShow("k", 0), true);
    assert.equal(capper.shownCount("k"), 0);
  });
});

describe("adFrequency.nextBackoffDelay", () => {
  it("is bounded by the cap and grows with attempts", async () => {
    const { nextBackoffDelay } = await import("../lib/ads/adFrequency.js");
    // rng = 1 → returns the full (capped) delay.
    const rngMax = () => 1;
    assert.equal(nextBackoffDelay(0, 2000, 60000, rngMax), 2000);
    assert.equal(nextBackoffDelay(1, 2000, 60000, rngMax), 4000);
    assert.equal(nextBackoffDelay(2, 2000, 60000, rngMax), 8000);
    // Capped.
    assert.equal(nextBackoffDelay(20, 2000, 60000, rngMax), 60000);
  });

  it("applies jitter within [0, cap]", async () => {
    const { nextBackoffDelay } = await import("../lib/ads/adFrequency.js");
    assert.equal(nextBackoffDelay(3, 2000, 60000, () => 0), 0);
    assert.equal(nextBackoffDelay(3, 2000, 60000, () => 0.5), 8000);
  });
});

describe("adConfig", () => {
  it("exposes the correct publisher / account identifiers", async () => {
    const cfg = await import("../lib/ads/adConfig.js");
    assert.equal(cfg.ADMOB_PUBLISHER_ID, "pub-6817509745706083");
    assert.equal(cfg.ADSENSE_CUSTOMER_ID, "973-378-3024");
    assert.equal(cfg.ADS_REPORTING_CURRENCY, "USD");
    assert.equal(cfg.SHARE_FULL_IP_ADDRESS, false);
  });

  it("resolves production ad unit ids from environment variables", async () => {
    process.env.EXPO_PUBLIC_ADMOB_BANNER_UNIT_ID = "ca-app-pub-6817509745706083/1111111111";
    const cfg = await import("../lib/ads/adConfig.js");
    assert.equal(
      cfg.getProdAdUnitId("banner"),
      "ca-app-pub-6817509745706083/1111111111",
    );
    // A format with no env var configured resolves to empty string.
    delete process.env.EXPO_PUBLIC_ADMOB_REWARDED_UNIT_ID;
    assert.equal(cfg.getProdAdUnitId("rewarded"), "");
  });

  it("pickAdUnitId selects the environment-appropriate unit and honors the kill switch", async () => {
    const cfg = await import("../lib/ads/adConfig.js");
    // Environment-robust: in dev builds the test id is used, in release the
    // production id is used. Assert against the module's own IS_DEV so this
    // test is correct under any NODE_ENV.
    const expected = cfg.IS_DEV ? "TEST_UNIT" : "PROD_UNIT";
    assert.equal(cfg.pickAdUnitId("PROD_UNIT", "TEST_UNIT"), expected);
    if (cfg.IS_DEV) {
      // An empty test id in dev disables the format.
      assert.equal(cfg.pickAdUnitId("PROD_UNIT", ""), null);
    } else {
      // An empty production id in release disables the format.
      assert.equal(cfg.pickAdUnitId("", "TEST_UNIT"), null);
    }
  });

  it("clamps the max ad content rating to an allowed value", async () => {
    const cfg = await import("../lib/ads/adConfig.js");
    delete process.env.EXPO_PUBLIC_ADMOB_MAX_AD_RATING;
    assert.equal(cfg.getMaxAdContentRating(), "PG");
    process.env.EXPO_PUBLIC_ADMOB_MAX_AD_RATING = "t";
    assert.equal(cfg.getMaxAdContentRating(), "T");
    process.env.EXPO_PUBLIC_ADMOB_MAX_AD_RATING = "bogus";
    assert.equal(cfg.getMaxAdContentRating(), "PG");
  });

  it("parses the test device identifier allowlist", async () => {
    const cfg = await import("../lib/ads/adConfig.js");
    process.env.EXPO_PUBLIC_ADMOB_TEST_DEVICE_IDS = " EMULATOR , ABC123 ,, ";
    assert.deepEqual(cfg.getTestDeviceIdentifiers(), ["EMULATOR", "ABC123"]);
  });
});
