import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const app = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")).expo;
const androidTVPlugin = require("../plugins/android-tv.js");
const optionalFeatures = [
  "android.software.leanback",
  "android.hardware.touchscreen",
  "android.hardware.touchscreen.multitouch",
  "android.hardware.wifi",
  "android.hardware.microphone",
];

async function applyTVManifest(manifest: any) {
  const config = androidTVPlugin({ name: "Compatibility test", slug: "compatibility-test" });
  return config.mods.android.manifest({
    ...config,
    modRequest: {
      platform: "android",
      modName: "manifest",
      projectRoot: process.cwd(),
    },
    modResults: manifest,
  });
}

describe("Android Play device compatibility", () => {
  it("disables unused microphone recording while preserving background playback", () => {
    const plugin = app.plugins.find((p: any) => Array.isArray(p) && p[0] === "expo-audio");
    assert.ok(plugin);
    assert.equal(plugin[1].microphonePermission, false);
    assert.equal(plugin[1].recordAudioAndroid, false);
    assert.equal(plugin[1].enableBackgroundRecording, false);
    assert.equal(plugin[1].enableBackgroundPlayback, true);
    assert.ok(app.android.blockedPermissions.includes("android.permission.RECORD_AUDIO"));
    assert.ok(!app.android.permissions.includes("android.permission.RECORD_AUDIO"));
    assert.ok(app.android.permissions.includes("android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"));
  });

  it("keeps TV hardware optional and retains its launcher", async () => {
    const result = await applyTVManifest({
      manifest: {
        application: [{ activity: [{ $: { "android:name": ".MainActivity" } }] }],
      },
    });
    const manifest = result.modResults.manifest;
    for (const name of optionalFeatures) {
      const feature = manifest["uses-feature"].find((f: any) => f.$["android:name"] === name);
      assert.equal(feature.$["android:required"], "false", name);
    }
    const activity = manifest.application[0].activity[0];
    assert.equal(manifest.application[0].$["android:banner"], "@drawable/tv_banner");
    assert.ok(activity["intent-filter"].some((f: any) =>
      f.category.some((c: any) => c.$["android:name"] === "android.intent.category.LEANBACK_LAUNCHER"),
    ));
  });

  it("corrects existing restrictive declarations without duplicates or losing other features", async () => {
    const input = {
      manifest: {
        "uses-feature": [
          ...optionalFeatures.map((name) => ({
            $: { "android:name": name, "android:required": "true" },
          })),
          { $: { "android:name": "unrelated.feature", "android:required": "true" } },
        ],
        application: [{ activity: [{ $: { "android:name": ".MainActivity" } }] }],
      },
    };
    const first = await applyTVManifest(input);
    const second = await applyTVManifest(first.modResults);
    const features = second.modResults.manifest["uses-feature"];
    for (const name of optionalFeatures) {
      const matches = features.filter((f: any) => f.$["android:name"] === name);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].$["android:required"], "false");
    }
    assert.equal(features.find((f: any) => f.$["android:name"] === "unrelated.feature")
      .$["android:required"], "true");
    assert.equal(second.modResults.manifest.application[0].activity[0]["intent-filter"].length, 1);
  });

  it("does not raise the existing minimum Android version", () => {
    const properties = app.plugins.find((p: any) =>
      Array.isArray(p) && p[0] === "expo-build-properties",
    );
    assert.equal(properties[1].android.minSdkVersion, 24);
  });

  it("copies the real 320×180 TV banner into clean Android builds", async () => {
    const android = mkdtempSync(path.join(tmpdir(), "tv-banner-"));
    try {
      const config = androidTVPlugin({ name: "TV test", slug: "tv-test" });
      const request = {
        ...config,
        modRequest: {
          platform: "android", modName: "dangerous", platformProjectRoot: android,
        },
        modResults: {},
      };
      await config.mods.android.dangerous(request);
      await config.mods.android.dangerous(request);
      const copied = readFileSync(path.join(android, "app/src/main/res/drawable-xhdpi/tv_banner.png"));
      assert.deepEqual(copied, readFileSync(new URL("../assets/images/tv-banner.png", import.meta.url)));
      assert.equal(copied.readUInt32BE(16), 320);
      assert.equal(copied.readUInt32BE(20), 180);
    } finally {
      rmSync(android, { recursive: true, force: true });
    }
  });
});
