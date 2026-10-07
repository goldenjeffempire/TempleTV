import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const source = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Android release reliability regression contracts", () => {
  const pip = source("modules/expo-pip-android/android/src/main/kotlin/expo/modules/pipandroid/ExpoPipAndroidModule.kt");

  it("sets an explicit media byte target without prioritizing time over size", async () => {
    const { ANDROID_VIDEO_BUFFER_OPTIONS: buffer } = await import("../lib/androidVideoBuffer.js");
    assert.equal(buffer.maxBufferBytes, 24 * 1024 * 1024);
    assert.equal(buffer.prioritizeTimeOverSizeThreshold, false);
    assert.equal(buffer.preferredForwardBufferDuration, 20);
    assert.equal(buffer.minBufferForPlayback, 2);
    assert.ok(buffer.minBufferForPlayback <= buffer.preferredForwardBufferDuration);
  });

  it("applies the shared buffer policy to local and broadcast players on Android only", () => {
    for (const file of ["components/LocalVideoPlayer.tsx", "components/V2PlayerContainer.tsx"]) {
      assert.match(source(file), /if \(Platform\.OS === "android"\) \{\s*p\.bufferOptions = \{ \.\.\.ANDROID_VIDEO_BUFFER_OPTIONS \};\s*\}/);
    }
  });

  it("guards both PiP title calls with API 33, not Android 12 API 31", () => {
    const calls = [...pip.matchAll(/if \(Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU\) \{[\s\S]*?\n\s*\}/g)]
      .filter((match) => match[0].includes("builder.setTitle(effectiveTitle)"));
    assert.equal(calls.length, 2);
    assert.equal([...pip.matchAll(/builder\.setTitle\(/g)].length, 2);
  });

  it("unregisters PiP from its original application context", () => {
    assert.match(pip, /reactContext\?\.applicationContext/);
    assert.match(pip, /receiverContext = ctx/);
    assert.match(pip, /val ctx = receiverContext/);
    assert.match(pip, /receiverContext = null/);
    assert.match(pip, /ctx\.unregisterReceiver\(receiver\)/);
  });

  it("guards queued native work against obsolete activities", () => {
    assert.equal([...pip.matchAll(/act\.isFinishing \|\| act\.isDestroyed \|\| currentActivity !== act/g)].length, 3);
  });

  it("lets useVideoPlayer own release instead of replacing on unmount", () => {
    assert.doesNotMatch(source("components/V2PlayerContainer.tsx"), /player\.replace\(null\)/);
    assert.doesNotMatch(source("components/LocalVideoPlayer.tsx"), /replaceAsync\(null\)\.catch/);
  });

  it("cancels delayed local retries and checks disposed state after loading", () => {
    const local = source("components/LocalVideoPlayer.tsx");
    assert.match(local, /if \(retryTimer !== null\) clearTimeout\(retryTimer\)/);
    assert.match(local, /await nativePlayer\.replaceAsync\(\{ uri: effectiveUrl \}\);\s*if \(!isMountedRef\.current \|\| disposed\) return/);
    assert.match(local, /return \(\) => \{ cancelled = true; \}/);
  });

  it("aborts schedule fetches on final unsubscribe before clearing timers", () => {
    const broadcast = source("components/V2PlayerContainer.tsx");
    assert.match(broadcast, /singleton\.controller\.abort\(\)/);
    assert.match(broadcast, /!data \|\| singleton\.controller\.signal\.aborted/);
    assert.match(broadcast, /removeEventListener\("abort", abortRequest\)/);
    assert.match(broadcast, /clearTimeout\(timeout\)/);
  });

  it("uses cached/downsampled images with an error fallback on broadcast surfaces", () => {
    const image = source("components/RemoteImage.tsx");
    assert.match(image, /cachePolicy="memory-disk"/);
    assert.match(image, /allowDownscaling/);
    assert.match(image, /failedUri === uri \? PLACEHOLDER/);
    assert.match(image, /onError=\{\(\) => setFailedUri\(uri\)\}/);
    for (const file of ["components/V2PlayerContainer.tsx", "components/player/BroadcastCompanion.tsx", "components/player/CountdownOverlay.tsx"]) {
      assert.match(source(file), /<RemoteImage/);
      assert.doesNotMatch(source(file), /import \{[^}]*\bImage\b[^}]*\} from "react-native"/);
    }
  });

  it("optimizes release without blanket app keep or warning suppression rules", () => {
    const config = JSON.parse(source("app.json")).expo;
    const props = config.plugins.find((p: unknown) => Array.isArray(p) && p[0] === "expo-build-properties")[1].android;
    assert.equal(props.enableMinifyInReleaseBuilds, true);
    assert.equal(props.enableShrinkResourcesInReleaseBuilds, true);
    assert.doesNotMatch(props.extraProguardRules, /-keep (?:class|interface) [\w.]+\.\*\*/);
    assert.doesNotMatch(props.extraProguardRules, /-dontwarn|expo\.modules\.av|com\.brentvatne/);
    assert.match(props.extraProguardRules, /allowoptimization,allowobfuscation/);
  });

  it("removes only known blanket template rules without touching consumer rules", () => {
    const require = createRequire(import.meta.url);
    const { removeTemplateKeeps } = require("../plugins/with-release-r8.js");
    const libraryRule = "-keepclassmembers class * { @com.facebook.jni.annotations.DoNotStrip *; }";
    const input = [
      "-keep class com.swmansion.reanimated.** { *; }",
      "-keep class com.facebook.react.turbomodule.** { *; }",
      libraryRule,
    ].join("\n");
    assert.equal(removeTemplateKeeps(input), libraryRule);
    assert.equal(removeTemplateKeeps(libraryRule), libraryRule);
  });
});
