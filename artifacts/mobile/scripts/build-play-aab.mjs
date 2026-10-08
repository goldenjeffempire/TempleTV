// Local Gradle build using the existing Play upload key, never EAS credentials.
import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import console from "node:console";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "PLAY_UPLOAD_KEYSTORE_BASE64", "PLAY_UPLOAD_KEYSTORE_PASSWORD",
  "PLAY_UPLOAD_KEY_ALIAS", "PLAY_UPLOAD_KEY_PASSWORD",
];
let temporaryDirectory;
const redactions = required.map((name) => process.env[name]).filter(Boolean);
const redact = (text) => redactions.reduce((s, value) => s.replaceAll(value, "[REDACTED]"), text);

function capture(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) {
    // Signing tools can include aliases in errors. Never expose raw output.
    throw new Error(`${command} verification failed; no credential details were printed.`);
  }
  return result.stdout;
}

function fingerprint(text) {
  const certificate = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  if (!certificate) throw new Error("Signing certificate could not be verified.");
  return new X509Certificate(certificate[0]).fingerprint256;
}

async function gradle(env) {
  const child = spawn("./gradlew", [
    "--no-daemon", "--no-configuration-cache", "--no-build-cache", "--no-parallel", "--max-workers=1",
    "-Dorg.gradle.jvmargs=-Xmx3072m -XX:MaxMetaspaceSize=512m -XX:-UsePerfData -Dfile.encoding=UTF-8",
    ":app:bundleRelease",
  ], { cwd: path.join(mobile, "android"), env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        console.log(redact(pending.slice(0, end)));
        pending = pending.slice(end + 1);
      }
    });
    stream.on("end", () => { if (pending) console.log(redact(pending)); });
  }
  await new Promise((resolve, reject) => {
    child.on("error", () => reject(new Error("Gradle could not start.")));
    child.on("close", (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`Gradle build failed (${signal ? `signal ${signal}` : `exit ${code}`}); no AAB delivered.`)));
  });
}

try {
  const localProfilePath = path.join(mobile, "credentials.json");
  const localProfileAvailable = fs.existsSync(localProfilePath);
  if (!localProfileAvailable && required.some((name) => !process.env[name])) {
    throw new Error("The existing Play upload-key secrets are required.");
  }
  if (!process.env.ANDROID_HOME || !fs.existsSync(process.env.ANDROID_HOME)) {
    throw new Error("A working Android SDK must be supplied through ANDROID_HOME.");
  }
  const app = JSON.parse(fs.readFileSync(path.join(mobile, "app.json"), "utf8")).expo;
  const pkg = JSON.parse(fs.readFileSync(path.join(mobile, "package.json"), "utf8"));
  const profile = JSON.parse(fs.readFileSync(path.join(mobile, "eas.json"), "utf8")).build["production-aab"];
  const native = fs.readFileSync(path.join(mobile, "android/app/build.gradle"), "utf8");
  const resources = fs.readFileSync(path.join(mobile, "android/app/src/main/res/values/strings.xml"), "utf8");
  if (app.version !== pkg.version
    || !native.includes(`versionName "${app.version}"`)
    || !native.includes(`versionCode ${app.android.versionCode}`)
    || !resources.includes(`<string name="expo_runtime_version">${app.version}</string>`)) {
    throw new Error("JavaScript and native release versions are not synchronized.");
  }
  if (!profile?.env?.EXPO_PUBLIC_API_URL) {
    throw new Error("The existing production API configuration is missing.");
  }
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "temple-play-signing-"));
  fs.chmodSync(temporaryDirectory, 0o700);
  const keystore = path.join(temporaryDirectory, "upload.keystore");
  let signingEnv;
  if (localProfileAvailable) {
    const local = JSON.parse(fs.readFileSync(localProfilePath, "utf8")).android?.keystore;
    if (![local?.keystorePath, local?.keystorePassword, local?.keyAlias, local?.keyPassword]
      .every((value) => typeof value === "string" && value.length > 0)) {
      throw new Error("Existing local signing profile is incomplete.");
    }
    signingEnv = {
      PLAY_UPLOAD_KEYSTORE_PASSWORD: local.keystorePassword,
      PLAY_UPLOAD_KEY_ALIAS: local.keyAlias,
      PLAY_UPLOAD_KEY_PASSWORD: local.keyPassword,
    };
    redactions.push(...Object.values(signingEnv));
    fs.copyFileSync(path.resolve(mobile, local.keystorePath), keystore);
    fs.chmodSync(keystore, 0o600);
  } else {
    const bytes = Buffer.from(process.env.PLAY_UPLOAD_KEYSTORE_BASE64, "base64");
    fs.writeFileSync(keystore, bytes, { mode: 0o600 });
    bytes.fill(0);
    signingEnv = Object.fromEntries(required.slice(1).map((name) => [name, process.env[name]]));
  }
  const reference = path.join(mobile, "builds/temple-tv-1.0.69-137.aab");
  if (!fs.existsSync(reference)) throw new Error("The known Play-compatible certificate reference is missing.");
  const knownCertificate = fingerprint(capture("keytool", ["-printcert", "-rfc", "-jarfile", reference]));
  const uploadCertificate = fingerprint(capture("keytool", [
    "-list", "-rfc", "-keystore", keystore,
    "-storepass:env", "PLAY_UPLOAD_KEYSTORE_PASSWORD",
  ], { ...process.env, ...signingEnv }));
  if (knownCertificate !== uploadCertificate) {
    throw new Error("Upload key differs from the known Play-compatible reference; refusing to sign.");
  }
  console.log(`Verified ${localProfileAvailable ? "existing local" : "workspace-secret"} Play signing profile. Building ${app.version} (${app.android.versionCode}).`);
  await gradle({
    ...process.env, ...profile.env, ...signingEnv,
    ANDROID_HOME: process.env.ANDROID_HOME,
    PLAY_UPLOAD_KEYSTORE_PATH: keystore,
    NODE_ENV: "production", CI: "1",
    NODE_OPTIONS: "--max-old-space-size=2048", METRO_MAX_WORKERS: "1",
    // Container perf-counter mappings can become invalid and SIGBUS the JVM.
    // Apply to the wrapper and compiler JVMs, not only the Gradle daemon.
    JAVA_TOOL_OPTIONS: "-XX:-UsePerfData",
    CMAKE_BUILD_PARALLEL_LEVEL: "1",
    SENTRY_DISABLE_AUTO_UPLOAD: "true",
  });
  const bundle = path.join(mobile, "android/app/build/outputs/bundle/release/app-release.aab");
  const verifier = capture("jarsigner", ["-verify", bundle]);
  if (!verifier.includes("jar verified.")) throw new Error("Generated AAB signature could not be verified.");
  if (fingerprint(capture("keytool", ["-printcert", "-rfc", "-jarfile", bundle])) !== knownCertificate) {
    throw new Error("Generated bundle has an unexpected signing certificate.");
  }
  const output = path.join(mobile, `builds/temple-tv-${app.version}-${app.android.versionCode}.aab`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(bundle, output);
  console.log(`Signed and verified AAB: ${path.relative(process.cwd(), output)}`);
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : "Android bundle build failed."));
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
