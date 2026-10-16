// Run after Expo's generators, including splash-screen and intent-filter mods.
// Keep API-specific theme attributes off devices below their supported API.
const { withFinalizedMod, XML } = require("@expo/config-plugins");
const fs = require("node:fs/promises");
const path = require("node:path");

const CUTOUT = "android:windowLayoutInDisplayCutoutMode";
const SPLASH = "android:windowSplashScreenBehavior";
const VERSIONED_ITEMS = new Map([[CUTOUT, 28], [SPLASH, 33]]);

async function readXml(file) {
  return XML.parseXMLAsync(await fs.readFile(file, "utf8"));
}

async function writeXml(file, xml) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, XML.format(xml));
}

function annotateExpoIntentFilters(xml) {
  let annotated = false;
  for (const application of xml.manifest.application ?? []) {
    for (const component of [
      ...(application.activity ?? []),
      ...(application["activity-alias"] ?? []),
    ]) {
      for (const filter of component["intent-filter"] ?? []) {
        const attributes = filter.$ ?? {};
        if (attributes["data-generated"] !== "true") continue;
        // Expo uses this marker to remove old generated filters on the next
        // prebuild. Removing it would accumulate duplicate deep-link filters.
        // Scope the false-positive annotation to this exact known attribute.
        const unqualified = Object.keys(attributes).filter((key) => !key.includes(":"));
        const ignores = (attributes["tools:ignore"] ?? "")
          .split(",").map((value) => value.trim())
          .filter((value) => value && value !== "MissingPrefix");
        if (unqualified.length === 1 && unqualified[0] === "data-generated") {
          ignores.push("MissingPrefix");
          annotated = true;
        }
        if (ignores.length) attributes["tools:ignore"] = ignores.join(",");
        else delete attributes["tools:ignore"];
      }
    }
  }
  if (annotated) {
    xml.manifest.$ ??= {};
    xml.manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";
  }
  return xml;
}

async function qualifyStyles(resRoot) {
  const baseFile = path.join(resRoot, "values", "styles.xml");
  const base = await readXml(baseFile);
  const managed = [];
  const baseStyles = base.resources.style ?? [];
  for (const style of [...baseStyles]) {
    const items = (style.item ?? []).filter((item) => VERSIONED_ITEMS.has(item.$?.name));
    if (!items.length) continue;
    style.item = style.item.filter((item) => !VERSIONED_ITEMS.has(item.$?.name));
    // Use an explicit shared parent instead of copying common items into
    // versioned themes, where they could become stale on a later prebuild.
    const parentName = `TempleCompat_${style.$.name.replace(/\W/g, "_")}`;
    const common = structuredClone(style);
    common.$.name = parentName;
    if (!common.$.parent && style.$.name.includes(".")) {
      common.$.parent = style.$.name.slice(0, style.$.name.lastIndexOf("."));
    }
    const commonIndex = baseStyles.findIndex((entry) => entry.$?.name === parentName);
    if (commonIndex < 0) baseStyles.push(common);
    else baseStyles[commonIndex] = common;
    managed.push({ style, items, parentName });
  }
  if (!managed.length) return;

  for (const api of [28, 30, 33]) {
    const file = path.join(resRoot, `values-v${api}`, "styles.xml");
    let versioned;
    try {
      versioned = await readXml(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      versioned = { resources: {} };
    }
    const styles = versioned.resources.style ??= [];
    for (const { style, items, parentName } of managed) {
      const index = styles.findIndex((entry) => entry.$?.name === style.$.name);
      const existing = index < 0 ? undefined : styles[index];
      // Retain version-specific overrides and inherit current base settings.
      const merged = new Map(
        [...(existing?.item ?? [])]
          .filter((item) => !VERSIONED_ITEMS.has(item.$?.name))
          .map((item) => [item.$.name, structuredClone(item)]),
      );
      for (const item of items) {
        const name = item.$.name;
        if (api < VERSIONED_ITEMS.get(name)) continue;
        const qualified = structuredClone(item);
        // "always" was added in API 30; Android 9/10 use shortEdges.
        if (name === CUTOUT) qualified._ = api >= 30 ? "always" : "shortEdges";
        merged.set(name, qualified);
      }
      const qualified = {
        ...structuredClone(style),
        $: { ...style.$, ...existing?.$, parent: `@style/${parentName}` },
        item: [...merged.values()],
      };
      if (index < 0) styles.push(qualified);
      else styles[index] = qualified;
    }
    await writeXml(file, versioned);
  }
  await writeXml(baseFile, base);
}

module.exports = function withAndroidResourceCompatibility(config) {
  return withFinalizedMod(config, ["android", async (mod) => {
    const main = path.join(mod.modRequest.platformProjectRoot, "app", "src", "main");
    const manifestFile = path.join(main, "AndroidManifest.xml");
    await writeXml(manifestFile, annotateExpoIntentFilters(await readXml(manifestFile)));
    await qualifyStyles(path.join(main, "res"));
    return mod;
  }]);
};
module.exports.annotateExpoIntentFilters = annotateExpoIntentFilters;
module.exports.qualifyStyles = qualifyStyles;
