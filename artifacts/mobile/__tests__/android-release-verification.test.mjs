import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const expectedSha1 = "52:2C:16:01:87:CF:98:86:F2:FB:AB:3B:0A:3A:FC:B1:E8:BF:91:69";

// Controlled tooling fixtures test the hook's decisions, not a native build,
// a real signature, or installed-device behavior.
function runHook(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "android-release-hook-"));
  try {
    const android = path.join(root, "android");
    const bin = path.join(root, "bin");
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    mkdirSync(path.join(android, "app/build/outputs/bundle/release"), { recursive: true });
    mkdirSync(path.join(android, "app/build/outputs/mapping/release"), { recursive: true });
    mkdirSync(bin);
    copyFileSync(new URL("../scripts/verify-android-release.mjs", import.meta.url),
      path.join(root, "scripts/verify-android-release.mjs"));
    writeFileSync(path.join(root, "app.json"), JSON.stringify({
      expo: { version: "1.0.75", android: { versionCode: 144 } },
    }));
    writeFileSync(path.join(root, "eas.json"), JSON.stringify({
      build: {
        "production-cloud": { android: { buildType: "app-bundle" } },
        preview: { android: { buildType: "apk" } },
        "android-validation": { extends: "preview" },
      },
    }));
    writeFileSync(path.join(android, "gradle.properties"), [
      "android.enableMinifyInReleaseBuilds=true",
      "android.enableShrinkResourcesInReleaseBuilds=true",
      "android.r8.optimizedResourceShrinking=true",
      "android.enableR8.fullMode=true",
    ].join("\n"));
    writeFileSync(path.join(android, "app/build/outputs/bundle/release/app-release.aab"),
      "test fixture — not an Android bundle");
    writeFileSync(path.join(android, "app/build/outputs/mapping/release/mapping.txt"),
      "# compiler: R8\n# compiler_version: test-fixture\n");
    const executable = (file, source) => writeFileSync(file,
      "#!/usr/bin/env node\n" + source, { mode: 0o755 });
    executable(path.join(android, "gradlew"), `
      const fs = require("node:fs");
      fs.writeFileSync("lint-args.json", JSON.stringify(process.argv.slice(2)));
      if (process.env.TEST_LINT_REPORT) {
        const dir = "app/build/intermediates/lint_intermediate_text_report/release/lintReportRelease";
        fs.mkdirSync(dir, {recursive:true});
        fs.writeFileSync(dir + "/lint-results-release.txt", process.env.TEST_LINT_REPORT);
      }
      process.exit(Number(process.env.TEST_LINT_EXIT || 0));
    `);
    executable(path.join(bin, "jarsigner"), `
      process.exit(Number(process.env.TEST_SIGNATURE_EXIT || 0));
    `);
    executable(path.join(bin, "keytool"), `
      console.log("SHA1: " + process.env.TEST_CERT_SHA1);
    `);
    executable(path.join(bin, "java"), `console.error("test Java version");`);
    const result = spawnSync(process.execPath, [path.join(root, "scripts/verify-android-release.mjs")], {
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        PATH: bin + path.delimiter + process.env.PATH,
        EAS_BUILD_PLATFORM: "android",
        EAS_BUILD_PROFILE: "production-cloud",
        TEST_LINT_EXIT: "0",
        TEST_SIGNATURE_EXIT: "0",
        TEST_CERT_SHA1: expectedSha1,
        ...overrides,
      },
    });
    const argsFile = path.join(android, "lint-args.json");
    const auditFile = path.join(android, "app/build/outputs/release-audit/verification.json");
    return {
      ...result,
      lintArgs: existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : null,
      audit: existsSync(auditFile) ? JSON.parse(readFileSync(auditFile, "utf8")) : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Android release verification hook", () => {
  it("keeps full release lint and uses the supported K1 frontend across modules", () => {
    const result = runHook();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lintArgs, [
      ":app:lintRelease", "-Pandroid.lint.useK2Uast=false", "--no-daemon", "--console=plain",
    ]);
    assert.equal(result.audit.releaseLint, "passed");
    assert.equal(result.audit.uploadCertificateSha1, expectedSha1);
    assert.equal(result.audit.optimizedResourceShrinking, true);
    assert.equal(result.audit.r8FullMode, true);
    assert.equal(result.audit.physicalDeviceTests, "not performed by this hook");
  });

  it("still fails closed when release lint fails", () => {
    const result = runHook({ TEST_LINT_EXIT: "1" });
    assert.notEqual(result.status, 0);
    assert.equal(result.audit, null);
  });

  it("prints the complete lint report and still fails closed", () => {
    const report = "First error [MissingTvBanner]\nSecond error [NewApi]\n";
    const result = runHook({ TEST_LINT_EXIT: "1", TEST_LINT_REPORT: report });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(report));
    assert.ok(result.stderr.includes("ANDROID_RELEASE_LINT_REPORT_END"));
    assert.equal(result.audit, null);
  });

  it("still rejects an invalid bundle signature", () => {
    const result = runHook({ TEST_SIGNATURE_EXIT: "1" });
    assert.notEqual(result.status, 0);
    assert.equal(result.audit, null);
  });

  it("still rejects the wrong Google Play upload certificate", () => {
    const result = runHook({ TEST_CERT_SHA1: "00:00:00:00" });
    assert.notEqual(result.status, 0);
    assert.equal(result.audit, null);
  });

  it("does not run AAB-specific tools for an inherited APK profile", () => {
    const result = runHook({ EAS_BUILD_PROFILE: "android-validation" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.lintArgs, null);
    assert.equal(result.audit, null);
  });

  it("does not run Android tools for iOS builds", () => {
    const result = runHook({ EAS_BUILD_PLATFORM: "ios" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.lintArgs, null);
  });
});
