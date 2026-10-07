// Expo's Android template includes blanket legacy keeps. The installed
// Reanimated and ReactAndroid libraries supply consumer JNI/reflection rules.
// Remove only those two known template rules; never strip dependency rules.
const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("node:fs/promises");
const path = require("node:path");

const TEMPLATE_KEEPS = new Set([
  "-keep class com.swmansion.reanimated.** { *; }",
  "-keep class com.facebook.react.turbomodule.** { *; }",
]);

function removeTemplateKeeps(rules) {
  return rules.split("\n")
    .filter((line) => !TEMPLATE_KEEPS.has(line.trim()))
    .join("\n");
}

module.exports = function withReleaseR8(config) {
  return withDangerousMod(config, ["android", async (mod) => {
    const file = path.join(mod.modRequest.platformProjectRoot, "app", "proguard-rules.pro");
    const rules = await fs.readFile(file, "utf8");
    await fs.writeFile(file, removeTemplateKeeps(rules));
    return mod;
  }]);
};
module.exports.removeTemplateKeeps = removeTemplateKeeps;
