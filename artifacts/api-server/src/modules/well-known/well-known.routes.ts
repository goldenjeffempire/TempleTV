/**
 * /.well-known routes
 *
 * Serves Digital Asset Links (Android App Links) and Apple App Site
 * Association (iOS Universal Links) verification files at the canonical
 * well-known paths required by the respective OS verification daemons.
 *
 * Android verification flow:
 *  1. Google Play Console submits GET https://templetv.org.ng/.well-known/assetlinks.json
 *  2. Must respond HTTP 200, Content-Type: application/json, no redirects
 *  3. JSON must list package_name + SHA-256 fingerprints of the signing cert
 *
 * SHA-256 fingerprints:
 *  Set the env var ANDROID_APP_SIGNING_FINGERPRINTS to a comma-separated list
 *  of uppercase colon-delimited SHA-256 fingerprints.  Obtain the canonical
 *  value from:
 *    Google Play Console → App integrity → Setup → App signing
 *    → "App signing key certificate" section → SHA-256 certificate fingerprint
 *
 *  Example env var value (two certs — app signing + upload key for staging):
 *    AB:CD:EF:...:12:34,12:34:...:AB:CD
 *
 *  If the env var is absent the route still responds 200 with an empty
 *  fingerprints array so the file structure is always valid JSON; Google will
 *  simply not verify until a real fingerprint is supplied.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

/** Rate-limit for well-known assets: generous ceiling — Google, Apple, and
 *  Android device verifiers hit this endpoint on install/reinstall events. */
const wellKnownRateLimit = {
  rateLimit: {
    max: 120,
    timeWindow: "1 minute",
  },
} as const;

/** Parse the ANDROID_APP_SIGNING_FINGERPRINTS env var into an array.
 *  Accepts a comma-separated list of SHA-256 fingerprints (any casing,
 *  colons required between bytes).  Empty/missing → empty array. */
function parseFingerprints(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

export async function wellKnownRoutes(app: FastifyInstance): Promise<void> {
  const fingerprints = parseFingerprints(
    process.env.ANDROID_APP_SIGNING_FINGERPRINTS,
  );

  /**
   * GET /.well-known/assetlinks.json
   *
   * Android App Links — Digital Asset Links verification file.
   * Google Play verification daemon and Android OS verify this endpoint
   * when the app is installed or when autoVerify triggers on device.
   *
   * Requirements per https://developer.android.com/training/app-links/verify-android-applinks:
   *  • HTTP 200 (no 3xx redirect — Android does NOT follow redirects for this file)
   *  • Content-Type: application/json
   *  • Valid JSON array matching the Digital Asset Links v1 schema
   *  • Must be served over HTTPS in production
   */
  app.get(
    "/.well-known/assetlinks.json",
    { config: wellKnownRateLimit, schema: { response: { 429: z.object({ error: z.string() }) } } },
    async (_req, reply) => {
      const payload = [
        {
          relation: ["delegate_permission/common.handle_all_urls"],
          target: {
            namespace: "android_app",
            package_name: "com.templetv.jctm",
            sha256_cert_fingerprints: fingerprints,
          },
        },
      ];

      reply
        .header("Content-Type", "application/json")
        // Instruct CDNs/proxies not to cache — the OS verification daemon
        // performs fresh GETs; stale cached 200s with wrong fingerprints can
        // permanently block verification on devices until the CDN TTL expires.
        .header("Cache-Control", "no-cache, no-store, must-revalidate")
        // Allow the Android verification service (different origin) to read.
        .header("Access-Control-Allow-Origin", "*");

      return reply.send(JSON.stringify(payload, null, 2));
    },
  );

  /**
   * GET /.well-known/apple-app-site-association
   *
   * iOS/macOS Universal Links — App Site Association verification file.
   * Served alongside assetlinks.json so both platforms are handled from
   * the same well-known module.
   *
   * iOS bundle identifier: com.templetv.app (see ios.bundleIdentifier in app.json)
   * Team ID: obtained from Apple Developer Portal → Membership → Team ID
   *
   * Set env var APPLE_TEAM_ID to your Apple Developer Team ID (10-char string).
   */
  app.get(
    "/.well-known/apple-app-site-association",
    { config: wellKnownRateLimit, schema: { response: { 429: z.object({ error: z.string() }) } } },
    async (_req, reply) => {
      const teamId = process.env.APPLE_TEAM_ID ?? "";
      const bundleId = "com.templetv.app";

      const appId = teamId ? `${teamId}.${bundleId}` : bundleId;

      const payload = {
        applinks: {
          apps: [],
          details: [
            {
              appID: appId,
              paths: ["*"],
            },
          ],
        },
        webcredentials: {
          apps: [appId],
        },
      };

      reply
        .header("Content-Type", "application/json")
        .header("Cache-Control", "no-cache, no-store, must-revalidate")
        .header("Access-Control-Allow-Origin", "*");

      return reply.send(JSON.stringify(payload, null, 2));
    },
  );
}
