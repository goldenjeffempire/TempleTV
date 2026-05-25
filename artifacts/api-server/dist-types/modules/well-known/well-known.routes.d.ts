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
export declare function wellKnownRoutes(app: FastifyInstance): Promise<void>;
