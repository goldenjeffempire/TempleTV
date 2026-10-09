import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const source = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Android release reliability regression contracts", () => {
  const pip = source("modules/expo-pip-android/android/src/main/kotlin/expo/modules/pipandroid/ExpoPipAndroidModule.kt");

  it("releases Android hero preview ownership while home is hidden or full player is open", async () => {
    const { shouldMountHeroPreview } = await import("../lib/heroPreviewPolicy.js");
    assert.equal(shouldMountHeroPreview("android", true, false), true);
    assert.equal(shouldMountHeroPreview("android", false, false), false);
    assert.equal(shouldMountHeroPreview("android", true, true), false);
    assert.equal(shouldMountHeroPreview("android", false, true), false);
    for (const platform of ["ios", "web"]) {
      assert.equal(shouldMountHeroPreview(platform, false, true), true);
    }
  });

  it("uses focus-aware preview mounting without removing the hero metadata subscription", () => {
    const home = source("app/(tabs)/index.tsx");
    assert.match(home, /useFocusEffect\(useCallback\(/);
    assert.match(home, /setIsFocused\(true\)/);
    assert.match(home, /return \(\) => setIsFocused\(false\)/);
    assert.match(home, /shouldMountHeroPreview\(Platform\.OS, isFocused, isBroadcastMode\)/);
    assert.match(home, /\{mountPreview && \(/);
    assert.match(home, /snapshot: v2Snapshot, forceRebind/);
  });

  it("tracks the native release-timeout patch without moving ExoPlayer off its looper", () => {
    const root = JSON.parse(source("../../package.json"));
    const patchPath = root.pnpm.patchedDependencies["expo-video@57.0.5"];
    assert.equal(patchPath, "patches/expo-video@57.0.4.patch");
    const patch = source(`../../${patchPath}`);
    assert.match(patch, /setLooper\(context\.mainLooper\)/);
    assert.match(patch, /\+ {6}setReleaseTimeoutMs\(100L\)/);
    assert.doesNotMatch(patch, /Dispatchers\.IO|Dispatchers\.Default/);
  });

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
    assert.ok(config.plugins.includes("./plugins/with-gradle-config.js"));
  });

  it("generates optimized resource shrinking and R8 full mode with the Gradle plugin", async () => {
    const require = createRequire(import.meta.url);
    const plugin = require("../plugins/with-gradle-config.js");
    const config = plugin({ name: "R8 regression", slug: "r8-regression" });
    const result = await config.mods.android.gradleProperties({
      ...config,
      modRequest: { platform: "android", modName: "gradleProperties", projectRoot: process.cwd() },
      modResults: [],
    });
    for (const key of ["android.r8.optimizedResourceShrinking", "android.enableR8.fullMode"]) {
      const matching = result.modResults.filter((p: { type: string; key?: string }) =>
        p.type === "property" && p.key === key);
      assert.equal(matching.length, 1);
      assert.equal(matching[0].value, "true");
    }
  });

  it("overrides a disabled shrinking flag idempotently and preserves unrelated properties", async () => {
    const require = createRequire(import.meta.url);
    const plugin = require("../plugins/with-gradle-config.js");
    const config = plugin({ name: "R8 regression", slug: "r8-regression" });
    const input = {
      ...config,
      modRequest: { platform: "android", modName: "gradleProperties", projectRoot: process.cwd() },
      modResults: [
        { type: "comment", value: "Preserve this comment" },
        { type: "property", key: "custom.setting", value: "unchanged" },
        { type: "property", key: "android.r8.optimizedResourceShrinking", value: "false" },
      ],
    };
    const first = await config.mods.android.gradleProperties(input);
    const expected = JSON.parse(JSON.stringify(first.modResults));
    const second = await config.mods.android.gradleProperties(first);
    assert.deepEqual(second.modResults, expected);
    const matching = second.modResults.filter((p: { type: string; key?: string }) =>
      p.type === "property" && p.key === "android.r8.optimizedResourceShrinking");
    assert.equal(matching.length, 1);
    assert.equal(matching[0].value, "true");
    assert.ok(second.modResults.some((p: { type: string; key?: string; value?: string }) =>
      p.key === "custom.setting" && p.value === "unchanged"));
    assert.ok(second.modResults.some((p: { type: string; value?: string }) =>
      p.type === "comment" && p.value === "Preserve this comment"));
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

  it("sets RN edge-to-edge state before Activity startup on Android 15+ only", async () => {
    const require = createRequire(import.meta.url);
    const plugin = require("../plugins/with-enable-edge-to-edge.js");
    const config = plugin({ name: "Window regression", slug: "window-regression" });
    for (const argument of ["null", "savedInstanceState"]) {
      const original = `package com.templetv.jctm
import expo.modules.ReactActivityDelegateWrapper
class MainActivity {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(${argument})
  }
}`;
      const first = await config.mods.android.mainActivity({
        ...config,
        modRequest: { platform: "android", modName: "mainActivity", projectRoot: process.cwd() },
        modResults: { language: "kt", contents: original },
      });
      const output = first.modResults.contents;
      assert.match(output, /if \(android\.os\.Build\.VERSION\.SDK_INT >= 35\) \{\s+setEdgeToEdgeFeatureFlagOn\(\)/);
      assert.match(output, /import com\.facebook\.react\.views\.view\.setEdgeToEdgeFeatureFlagOn/);
      assert.ok(output.indexOf("setEdgeToEdgeFeatureFlagOn()") < output.indexOf("enableEdgeToEdge()"));
      assert.ok(output.indexOf("enableEdgeToEdge()") < output.indexOf("super.onCreate("));
      const second = await config.mods.android.mainActivity(first);
      assert.equal(second.modResults.contents, output);
    }
    assert.match(source("node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/views/view/WindowUtil.kt"),
      /public fun setEdgeToEdgeFeatureFlagOn\(\)/);
  });

  it("fails closed when the generated Kotlin Activity no longer matches the template", async () => {
    const require = createRequire(import.meta.url);
    const plugin = require("../plugins/with-enable-edge-to-edge.js");
    const config = plugin({ name: "Window regression", slug: "window-regression" });
    await assert.rejects(config.mods.android.mainActivity({
      ...config,
      modRequest: { platform: "android", modName: "mainActivity", projectRoot: process.cwd() },
      modResults: { language: "kt", contents: "package changed\nclass MainActivity {}" },
    }), /MainActivity onCreate pattern changed/);
  });

  it("does not ship the unused Cropper activity or request unused photo permissions", () => {
    const pkg = JSON.parse(source("package.json"));
    const config = JSON.parse(source("app.json")).expo;
    assert.equal(pkg.dependencies["expo-image-picker"], undefined);
    assert.ok(!config.plugins.some((p: string | string[]) =>
      (Array.isArray(p) ? p[0] : p) === "expo-image-picker"));
  });

  it("uses cached, downsampled Expo images in YouTube and full-player posters", () => {
    for (const file of ["components/YoutubePlayer.native.tsx", "components/YoutubePlayer.web.tsx", "app/player.tsx"]) {
      const text = source(file);
      assert.match(text, /import \{ Image \} from "expo-image"/);
      assert.match(text, /cachePolicy="memory-disk"/);
      assert.match(text, /allowDownscaling/);
      assert.doesNotMatch(text, /resizeMode=/);
    }
  });

  it("uses a lifecycle-cleared image library instead of raw reload-screen downloads and decoding", () => {
    const native = source("node_modules/expo-updates/android/src/main/java/expo/modules/updates/reloadscreen/ReloadScreenView.kt");
    const gradle = source("node_modules/expo-updates/android/build.gradle");
    assert.match(gradle, /implementation "com\.github\.bumptech\.glide:glide:5\.0\.5"/);
    assert.match(source("node_modules/expo-image/android/build.gradle"), /GLIDE_VERSION = "5\.0\.5"/);
    assert.match(native, /Glide\.with\(context\.applicationContext\)/);
    assert.match(native, /diskCacheStrategy\(DiskCacheStrategy\.AUTOMATIC\)/);
    assert.match(native, /timeout\(15_000\)/);
    assert.match(native, /this\.imageView !== imageView/);
    assert.match(native, /imageView = null[\s\S]*currentConfiguration = configuration/);
    assert.match(native, /onLoadFailed[\s\S]*handleImageLoadFailure/);
    assert.equal((native.match(/\.clear\(it\)/g) ?? []).length, 2);
    assert.doesNotMatch(native, /BitmapFactory|HttpURLConnection|scope\.launch|java\.net\.URL/);
  });
});
