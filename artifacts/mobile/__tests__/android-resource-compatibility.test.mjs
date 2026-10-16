import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const plugin = require("../plugins/with-android-resource-compatibility.js");
const { XML, AndroidConfig } = require("@expo/config-plugins");
const cutout = "android:windowLayoutInDisplayCutoutMode";
const splash = "android:windowSplashScreenBehavior";
const item = (name, value) => ({ $: { name }, _: value });
const styles = {
  resources: {
    style: [
      { $: { name: "AppTheme", parent: "Theme.AppCompat.DayNight.NoActionBar" },
        item: [item("android:windowLightStatusBar", "false"), item(cutout, "always")] },
      { $: { name: "Theme.App.SplashScreen", parent: "Theme.SplashScreen" },
        item: [item("postSplashScreenTheme", "@style/AppTheme"), item(splash, "icon_preferred")] },
    ],
  },
};

test("the app registers the final compatibility mod without raising minSdk", async () => {
  const config = JSON.parse(await readFile(new URL("../app.json", import.meta.url), "utf8")).expo;
  assert.ok(config.plugins.includes("./plugins/with-android-resource-compatibility.js"));
  const properties = config.plugins.find((entry) => Array.isArray(entry) && entry[0] === "expo-build-properties");
  assert.equal(properties[1].android.minSdkVersion, 24);
});

test("Expo marker annotation preserves generated-filter cleanup and unrelated lint checks", () => {
  const config = {
    android: { intentFilters: [
      { action: "VIEW", autoVerify: true, data: { scheme: "https", host: "templetv.org.ng" } },
      { action: "VIEW", data: { scheme: "templetv" } },
    ] },
  };
  const manifest = { manifest: { $: {}, application: [{
    activity: [{ $: { "android:name": ".MainActivity" }, "intent-filter": [
      { action: [{ $: { "android:name": "android.intent.action.MAIN" } }],
        category: [{ $: { "android:name": "android.intent.category.LAUNCHER" } }] },
    ] }],
  }] } };
  for (let run = 0; run < 3; run++) {
    AndroidConfig.IntentFilters.setAndroidIntentFilters(config, manifest);
    plugin.annotateExpoIntentFilters(manifest);
    const filters = manifest.manifest.application[0].activity[0]["intent-filter"];
    assert.equal(filters.length, 3);
    assert.equal(filters[0].$?.["tools:ignore"], undefined);
    for (const filter of filters.slice(1)) {
      assert.equal(filter.$["data-generated"], "true");
      assert.equal(filter.$["tools:ignore"], "MissingPrefix");
    }
  }
  const filter = manifest.manifest.application[0].activity[0]["intent-filter"][1];
  filter.$.unexpectedAttribute = "true";
  filter.$["tools:ignore"] = "OtherCheck,MissingPrefix";
  plugin.annotateExpoIntentFilters(manifest);
  assert.equal(filter.$["tools:ignore"], "OtherCheck");
});

test("finalized mod runs on generated files, retains base styles and is idempotent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "android-resources-"));
  try {
    const main = path.join(root, "app/src/main");
    const res = path.join(main, "res");
    await mkdir(path.join(res, "values"), { recursive: true });
    await mkdir(path.join(res, "values-v33"), { recursive: true });
    await writeFile(path.join(main, "AndroidManifest.xml"), XML.format({
      manifest: { $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
        application: [{ activity: [{ "intent-filter": [{ $: { "data-generated": "true" } }] }] }] },
    }));
    await writeFile(path.join(res, "values/styles.xml"), XML.format(styles));
    await writeFile(path.join(res, "values-v33/styles.xml"), XML.format({
      resources: { style: [
        { $: { name: "UnrelatedTheme" }, item: [item("android:colorAccent", "#000000")] },
        { $: { name: "AppTheme" }, item: [item("android:windowLightStatusBar", "true")] },
      ] },
    }));
    const config = plugin({ name: "Test", slug: "test" });
    const apply = () => config.mods.android.finalized({
      ...config,
      modRequest: { platform: "android", modName: "finalized", platformProjectRoot: root },
    });
    await apply();
    const files = [path.join(main, "AndroidManifest.xml"), ...["values", "values-v28", "values-v30", "values-v33"]
      .map((folder) => path.join(res, folder, "styles.xml"))];
    const first = await Promise.all(files.map((file) => readFile(file, "utf8")));
    const base = await XML.parseXMLAsync(first[1]);
    for (const [index, api] of [24, 28, 30, 33].entries()) {
      const xml = await XML.parseXMLAsync(first[index + 1]);
      const theme = xml.resources.style.find((style) => style.$.name === "AppTheme");
      const splashTheme = xml.resources.style.find((style) => style.$.name === "Theme.App.SplashScreen");
      const value = (style, name) => {
        const own = style.item?.find((entry) => entry.$.name === name);
        if (own) return own._;
        const parent = base.resources.style.find((entry) =>
          `@style/${entry.$.name}` === style.$.parent);
        return parent?.item?.find((entry) => entry.$.name === name)?._;
      };
      assert.equal(value(theme, cutout), api >= 30 ? "always" : api >= 28 ? "shortEdges" : undefined);
      assert.equal(value(splashTheme, splash), api >= 33 ? "icon_preferred" : undefined);
      assert.equal(value(splashTheme, "postSplashScreenTheme"), "@style/AppTheme");
      assert.equal(value(theme, "android:windowLightStatusBar"), api === 33 ? "true" : "false");
      if (api === 33) assert.ok(xml.resources.style.find((style) => style.$.name === "UnrelatedTheme"));
    }
    assert.match(first[0], /tools:ignore="MissingPrefix"/);
    await apply();
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file, "utf8"))), first);
    // A later Expo prebuild must propagate new common settings into every
    // qualified theme, without replacing genuine API-specific overrides.
    const updated = structuredClone(styles);
    updated.resources.style[0].item[0]._ = "updated";
    await writeFile(path.join(res, "values/styles.xml"), XML.format(updated));
    await apply();
    const regenerated = await XML.parseXMLAsync(await readFile(files[1], "utf8"));
    const common = regenerated.resources.style.find((entry) => entry.$.name === "TempleCompat_AppTheme");
    assert.equal(common.item.find((entry) => entry.$.name === "android:windowLightStatusBar")._, "updated");
    const api30 = await XML.parseXMLAsync(await readFile(files[3], "utf8"));
    const api30Theme = api30.resources.style.find((entry) => entry.$.name === "AppTheme");
    assert.equal(api30Theme.$.parent, "@style/TempleCompat_AppTheme");
    assert.ok(!api30Theme.item.some((entry) => entry.$.name === "android:windowLightStatusBar"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed versioned resource XML fails instead of being overwritten", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "android-resources-invalid-"));
  try {
    await mkdir(path.join(root, "values"), { recursive: true });
    await mkdir(path.join(root, "values-v28"), { recursive: true });
    await writeFile(path.join(root, "values/styles.xml"), XML.format(styles));
    await writeFile(path.join(root, "values-v28/styles.xml"), "<resources><style>");
    await assert.rejects(plugin.qualifyStyles(root));
    assert.equal(await readFile(path.join(root, "values-v28/styles.xml"), "utf8"), "<resources><style>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
