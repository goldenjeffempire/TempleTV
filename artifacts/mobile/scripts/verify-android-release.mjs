import assert from "node:assert/strict";
import { existsSync, readFileSync, openSync, readSync, closeSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run after the real release build, not against an assumed/generated fixture.
// iOS builds intentionally do not run Android tooling.
if (process.env.EAS_BUILD_PLATFORM && process.env.EAS_BUILD_PLATFORM !== "android") {
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profiles = JSON.parse(readFileSync(path.join(root, "eas.json"), "utf8")).build;
let profile = profiles[process.env.EAS_BUILD_PROFILE];
while (profile) {
  if (profile.android?.buildType === "apk") {
    console.log("AAB-specific verification skipped for APK build profile.");
    process.exit(0);
  }
  profile = profile.extends ? profiles[profile.extends] : undefined;
}
const android = path.join(root, "android");
const app = JSON.parse(readFileSync(path.join(root, "app.json"), "utf8")).expo;
const props = readFileSync(path.join(android, "gradle.properties"), "utf8");
for (const setting of [
  "android.enableMinifyInReleaseBuilds=true",
  "android.enableShrinkResourcesInReleaseBuilds=true",
  "android.r8.optimizedResourceShrinking=true",
  "android.enableR8.fullMode=true",
]) assert.ok(props.split(/\r?\n/).includes(setting), `Missing release setting: ${setting}`);

execFileSync("./gradlew", [":app:lintRelease", "--no-daemon", "--console=plain"], {
  cwd: android,
  stdio: "inherit",
});
const bundle = path.join(android, "app/build/outputs/bundle/release/app-release.aab");
assert.ok(existsSync(bundle), "Release AAB was not generated");
execFileSync("jarsigner", ["-verify", bundle], { stdio: "ignore" });
const cert = execFileSync("keytool", ["-printcert", "-jarfile", bundle], {
  encoding: "utf8",
  env: { ...process.env, JAVA_TOOL_OPTIONS: "-Duser.language=en -Duser.country=US" },
});
const sha1 = cert.match(/SHA1:\s*([A-F0-9:]+)/)?.[1];
assert.equal(sha1, "52:2C:16:01:87:CF:98:86:F2:FB:AB:3B:0A:3A:FC:B1:E8:BF:91:69",
  "AAB upload certificate does not match Google Play's expected key");
const mapping = path.join(android, "app/build/outputs/mapping/release/mapping.txt");
const fd = openSync(mapping, "r");
const header = Buffer.alloc(2048);
const bytes = readSync(fd, header, 0, header.length, 0);
closeSync(fd);
assert.match(header.subarray(0, bytes).toString(), /# compiler: R8/);
const java = spawnSync("java", ["-version"], { encoding: "utf8" });
const evidence = {
  version: app.version,
  versionCode: app.android.versionCode,
  bundle: "android/app/build/outputs/bundle/release/app-release.aab",
  releaseLint: "passed",
  signatureVerified: true,
  uploadCertificateSha1: sha1,
  compiler: header.toString().match(/# compiler_version:\s*([^\n]+)/)?.[1],
  java: java.stderr?.split("\n")[0],
  minification: true,
  optimizedResourceShrinking: true,
  r8FullMode: true,
  physicalDeviceTests: "not performed by this hook",
};
const output = path.join(android, "app/build/outputs/release-audit");
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, "verification.json"), JSON.stringify(evidence, null, 2));
console.log("ANDROID_RELEASE_VERIFIED", JSON.stringify(evidence));
