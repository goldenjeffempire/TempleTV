#!/usr/bin/env node
/**
 * Temple TV — EAS Android Keystore Fingerprint Verifier
 *
 * Queries the Expo GraphQL API for the SHA-1 fingerprint of the Android
 * keystore currently stored in EAS remote credentials and compares it
 * against the expected value.
 *
 * Required env vars:
 *   EXPO_TOKEN          — Expo personal access token (templedev account)
 *   EXPECTED_SHA1       — Expected SHA-1 fingerprint (colon-delimited, uppercase)
 *
 * Optional env vars:
 *   EAS_PROJECT_ID      — Expo project UUID (falls back to app.json)
 *
 * Exit codes:
 *   0  — fingerprint matches
 *   1  — fingerprint mismatch or check failed
 *
 * GraphQL schema path (verified via introspection 2026-06-14):
 *   app.byId(appId) → androidAppCredentials[]
 *     → androidAppBuildCredentialsList[]
 *       → androidKeystore.sha1CertificateFingerprint
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const EXPO_TOKEN = process.env.EXPO_TOKEN;
const EXPECTED_SHA1 = (
  process.env.EXPECTED_SHA1 ||
  "52:2C:16:01:87:CF:98:86:F2:FB:AB:3B:0A:3A:FC:B1:E8:BF:91:69"
).toUpperCase();

const EAS_GRAPHQL = "https://api.expo.dev/graphql";

function loadProjectId() {
  if (process.env.EAS_PROJECT_ID) return process.env.EAS_PROJECT_ID;
  try {
    const appJson = JSON.parse(
      readFileSync(join(REPO_ROOT, "artifacts/mobile/app.json"), "utf8")
    );
    return (
      appJson?.expo?.extra?.eas?.projectId ??
      appJson?.expo?.extra?.projectId ??
      null
    );
  } catch {
    return null;
  }
}

async function fetchKeystoreFingerprints(projectId) {
  const query = `
    query GetAndroidCredentials($projectId: String!) {
      app {
        byId(appId: $projectId) {
          androidAppCredentials {
            androidAppBuildCredentialsList {
              isDefault
              androidKeystore {
                sha1CertificateFingerprint
                sha256CertificateFingerprint
                keyAlias
                updatedAt
              }
            }
          }
        }
      }
    }
  `;

  const resp = await fetch(EAS_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${EXPO_TOKEN}`,
    },
    body: JSON.stringify({ query, variables: { projectId } }),
  });

  if (!resp.ok) {
    throw new Error(`Expo API HTTP ${resp.status}: ${await resp.text()}`);
  }

  const json = await resp.json();
  if (json.errors?.length) {
    throw new Error(
      `Expo GraphQL errors:\n${json.errors.map((e) => e.message).join("\n")}`
    );
  }

  const appCredsList = json.data?.app?.byId?.androidAppCredentials ?? [];
  const buildCreds = appCredsList.flatMap(
    (ac) => ac.androidAppBuildCredentialsList ?? []
  );
  return buildCreds;
}

function normaliseFingerprint(fp) {
  return (fp ?? "").toUpperCase().replace(/[:\s]/g, "");
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   Temple TV — EAS Android Keystore Fingerprint Check ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  if (!EXPO_TOKEN) {
    console.error("✗ EXPO_TOKEN is not set.");
    process.exit(1);
  }

  const projectId = loadProjectId();
  if (!projectId) {
    console.error(
      "✗ Could not determine EAS project ID.\n" +
        "  Set EAS_PROJECT_ID env var or ensure artifacts/mobile/app.json has expo.extra.eas.projectId"
    );
    process.exit(1);
  }

  console.log(`  Project ID : ${projectId}`);
  console.log(`  Expected   : ${EXPECTED_SHA1}\n`);

  let credsList;
  try {
    credsList = await fetchKeystoreFingerprints(projectId);
  } catch (err) {
    console.error(
      `✗ Failed to fetch credentials from Expo API:\n  ${err.message}`
    );
    process.exit(1);
  }

  if (!credsList.length) {
    console.error(
      "✗ No Android build credentials found in EAS for this project."
    );
    process.exit(1);
  }

  let passed = false;
  let defaultChecked = false;

  for (const creds of credsList) {
    const ks = creds.androidKeystore;
    if (!ks) continue;

    const label = creds.isDefault ? "Default" : "Non-default";
    const actual = normaliseFingerprint(ks.sha1CertificateFingerprint);
    const expected = normaliseFingerprint(EXPECTED_SHA1);
    const match = actual === expected;

    console.log(`  [${label}] alias=${ks.keyAlias ?? "unknown"}`);
    console.log(`    SHA-1 (EAS)      : ${actual || "(none)"}`);
    console.log(`    SHA-1 (expected) : ${expected}`);
    console.log(`    SHA-256 (EAS)    : ${normaliseFingerprint(ks.sha256CertificateFingerprint) || "(none)"}`);
    console.log(`    Updated          : ${ks.updatedAt ?? "unknown"}`);
    console.log(`    Match            : ${match ? "✓ YES" : "✗ NO"}\n`);

    if (creds.isDefault) {
      defaultChecked = true;
      if (match) passed = true;
    }
  }

  if (!defaultChecked) {
    console.warn(
      "  ⚠ No default build credentials entry found — checking all entries."
    );
    passed = credsList.some((c) => {
      const actual = normaliseFingerprint(
        c.androidKeystore?.sha1CertificateFingerprint
      );
      return actual === normaliseFingerprint(EXPECTED_SHA1);
    });
  }

  if (passed) {
    console.log(
      "✓ Keystore fingerprint verified — safe to proceed with EAS build.\n"
    );
    process.exit(0);
  } else {
    console.error(
      "✗ KEYSTORE FINGERPRINT MISMATCH\n\n" +
        "  The keystore stored in EAS does not match the expected upload key\n" +
        "  registered with Google Play. Uploading this build will be rejected.\n\n" +
        "  To fix:\n" +
        "    1. Run: cd artifacts/mobile && npx eas-cli@latest credentials --platform android\n" +
        "    2. Upload the correct keystore file\n" +
        "    3. Update EXPECTED_ANDROID_UPLOAD_KEY_SHA1 in mobile-release.yml if the key changed\n" +
        "    4. Re-run this check before building\n"
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
