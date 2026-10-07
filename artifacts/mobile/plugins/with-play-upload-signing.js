const { withAppBuildGradle } = require("@expo/config-plugins");

const CONFIG = `
    // Play signing values are supplied only to the build process.
    def playUploadKeystorePath = System.getenv("PLAY_UPLOAD_KEYSTORE_PATH")
    def playUploadStorePassword = System.getenv("PLAY_UPLOAD_KEYSTORE_PASSWORD")
    def playUploadAlias = System.getenv("PLAY_UPLOAD_KEY_ALIAS")
    def playUploadKeyPassword = System.getenv("PLAY_UPLOAD_KEY_PASSWORD")
    def playUploadSigningReady = [playUploadKeystorePath, playUploadStorePassword,
        playUploadAlias, playUploadKeyPassword].every { it != null && !it.isEmpty() }
    if (gradle.startParameter.taskNames.any { it.toLowerCase().contains("release") }
        && !playUploadSigningReady) {
        throw new GradleException("Play release signing credentials are missing; use the secure build-play-aab.mjs wrapper.")
    }
`;

const SIGNING = `
        release {
            if (playUploadSigningReady) {
                storeFile file(playUploadKeystorePath)
                storePassword playUploadStorePassword
                keyAlias playUploadAlias
                keyPassword playUploadKeyPassword
            }
        }
`;

function configureSigning(contents) {
  if (contents.includes("def playUploadKeystorePath")) return contents;
  const release = /(release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;
  if (!release.test(contents) || !contents.includes("    signingConfigs {")) {
    throw new Error("Unexpected Android signing template; refusing to generate a debug-signed Play release.");
  }
  return contents
    .replace(release, "$1signingConfig signingConfigs.release")
    .replace("    signingConfigs {", `${CONFIG}    signingConfigs {${SIGNING}`);
}

module.exports = function withPlayUploadSigning(config) {
  // EAS cloud injects its own release signing configuration after prebuild.
  // Keep the secure local wrapper mandatory everywhere else.
  if (process.env.EAS_BUILD === "true"
    && process.env.EAS_BUILD_RUNNER === "eas-build") return config;
  return withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = configureSigning(mod.modResults.contents);
    return mod;
  });
};
module.exports.configureSigning = configureSigning;
