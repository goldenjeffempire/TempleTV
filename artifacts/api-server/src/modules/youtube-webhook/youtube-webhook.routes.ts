import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config/env.js";
import { logger } from "../../infrastructure/logger.js";
import { youtubeSyncDispatcher } from "../youtube-sync/youtube-sync.dispatcher.js";

/**
 * YouTube PubSubHubbub (WebSub) webhook for near-real-time new-upload detection.
 *
 * YouTube's hub (https://pubsubhubbub.appspot.com) sends an HTTP POST to our
 * callback URL whenever @TEMPLETVJCTM publishes a new video — typically within
 * 1-5 minutes of upload. This supplements the 5-minute polling interval so
 * new videos appear in the library as fast as YouTube's hub delivers them.
 *
 * Subscription lifecycle:
 *   1. On startup, `subscribeToYouTubePubSubHubbub(baseUrl)` POSTs a subscribe
 *      request to the hub. Hub responds 202 Accepted (async verification).
 *   2. Hub sends GET /youtube/webhook?hub.mode=subscribe&hub.challenge=XXX
 *      → we echo hub.challenge back as plain text (verification).
 *   3. Hub sends POST /youtube/webhook with an Atom XML body containing the
 *      new video's <yt:videoId> → we trigger an immediate channel sync.
 *   4. Lease expires after 7 days → re-subscribe on the next server restart
 *      (or implement a periodic re-subscription if uptime > 7 days).
 *
 * Routes (mounted under /youtube by app.ts):
 *   GET  /api/youtube/webhook  — hub verification challenge
 *   POST /api/youtube/webhook  — new video notification
 */

const CHANNEL_ID = "UCPFFvkE-KGpR37qJgvYriJg";
const TOPIC_URL = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";
const LEASE_SECS = 7 * 24 * 60 * 60; // 7 days

// Debounce: if multiple notifications arrive in quick succession (YouTube
// sometimes sends duplicates), only one sync runs.
let webhookSyncPending = false;

// Auto-renewal: the PubSubHubbub lease expires after 7 days. Re-subscribe
// every 5.5 days so there is always 1.5 days of overlap and the lease never
// lapses — even on servers with > 7 days of uptime between restarts.
const RENEWAL_INTERVAL_MS = 5.5 * 24 * 60 * 60 * 1000; // 5.5 days
let _renewalTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic webhook lease auto-renewal. Safe to call multiple times —
 * subsequent calls are no-ops if the timer is already running.
 *
 * @param baseUrl  The same baseUrl passed to `subscribeToYouTubePubSubHubbub`.
 */
export function startWebhookAutoRenewal(baseUrl: string): void {
  if (_renewalTimer) return;
  _renewalTimer = setInterval(() => {
    logger.info({ baseUrl, renewalIntervalDays: 5.5 }, "youtube-webhook: renewing PubSubHubbub lease");
    subscribeToYouTubePubSubHubbub(baseUrl).catch((err) => {
      logger.warn({ err }, "youtube-webhook: PubSubHubbub lease renewal failed — will retry at next interval");
    });
  }, RENEWAL_INTERVAL_MS);
  // Allow the process to exit cleanly even if the timer is still pending.
  _renewalTimer.unref();
}

/**
 * Subscribe to YouTube's PubSubHubbub hub.
 * Called once on server startup from app.ts after the server is ready.
 * Fire-and-forget — subscription failure does not block startup.
 *
 * @param baseUrl  The publicly-reachable base URL of this server,
 *                 e.g. "https://abc123.replit.dev" or "https://api.templetv.org.ng".
 *                 Must NOT have a trailing slash.
 */
export async function subscribeToYouTubePubSubHubbub(baseUrl: string): Promise<void> {
  const callbackUrl = `${baseUrl}/api/youtube/webhook`;
  try {
    const params: Record<string, string> = {
      "hub.callback": callbackUrl,
      "hub.mode": "subscribe",
      "hub.topic": TOPIC_URL,
      "hub.verify": "async",
      "hub.lease_seconds": String(LEASE_SECS),
    };
    if (env.YOUTUBE_WEBHOOK_SECRET) {
      params["hub.secret"] = env.YOUTUBE_WEBHOOK_SECRET;
    }
    const body = new URLSearchParams(params);
    const res = await fetch(HUB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 202) {
      logger.info({ callbackUrl }, "youtube-webhook: PubSubHubbub subscription requested (hub will verify shortly)");
    } else {
      const text = await res.text().catch(() => "");
      logger.warn({ status: res.status, text, callbackUrl }, "youtube-webhook: unexpected subscription response");
    }
  } catch (err) {
    logger.warn({ err, baseUrl }, "youtube-webhook: subscription request failed (5-min polling still active)");
  }
}

export async function youtubeWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Operator warning: when YOUTUBE_WEBHOOK_SECRET is unset, the POST /webhook
  // handler cannot verify the X-Hub-Signature, so any caller can trigger a
  // (debounced + rate-limited) channel sync by posting valid-looking Atom XML.
  // The blast radius is limited to spoofed sync triggers of the fixed channel
  // — no data injection — but a configured secret eliminates the noise entirely.
  if (!env.YOUTUBE_WEBHOOK_SECRET) {
    const logFn = env.NODE_ENV === "production" ? logger.error.bind(logger) : logger.warn.bind(logger);
    logFn(
      {},
      "youtube-webhook: YOUTUBE_WEBHOOK_SECRET is unset — POST /webhook signature " +
        "verification is disabled; spoofed callers can trigger channel syncs. " +
        "Set YOUTUBE_WEBHOOK_SECRET to a ≥32-char random hex string (and pass it as " +
        "hub.secret on subscribe) to enable HMAC-SHA1 verification. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }

  // YouTube sends `application/atom+xml` (and sometimes `text/xml`) for
  // both the PubSubHubbub notification POSTs and the verification GETs.
  // Register raw string parsers for all XML content types so Fastify
  // doesn't reject them with 415 Unsupported Media Type before the
  // route handler even runs.
  for (const ct of ["application/atom+xml", "application/xml", "text/xml"]) {
    app.addContentTypeParser(ct, { parseAs: "string" }, (_req, body, done) => {
      done(null, body);
    });
  }

  // ── GET /youtube/webhook — hub challenge verification ────────────────────
  // Rate-limited to 30/min — hub challenge verification only happens once at
  // subscription time; higher frequency is unexpected and may be abuse.
  app.get("/webhook", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },    schema: {
      response: {
        200: z.unknown(),
        400: z.object({ error: z.string() }),
        429: z.object({ error: z.string() }),
      },
    },
  }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const mode = q["hub.mode"];
    const challenge = q["hub.challenge"];
    const topic = q["hub.topic"];

    if ((mode === "subscribe" || mode === "unsubscribe") && challenge) {
      logger.info({ mode, topic }, "youtube-webhook: hub verification challenge received — confirming");
      return reply
        .status(200)
        .type("text/plain")
        .send(challenge);
    }

    logger.warn({ mode, challenge }, "youtube-webhook: invalid verification request");
    return reply.status(400).send({ error: "Invalid hub verification request" });
  });

  // ── POST /youtube/webhook — new video Atom notification ──────────────────
  app.post("/webhook", {
    // Increase body limit for XML payloads (usually < 4 KB but safety margin).
    // Rate-limit to 60/min — YouTube PubSubHubbub hubs send at most a few
    // notifications per minute, so this is generous while bounding replay
    // attacks that could spam the sync dispatcher.
    config: { bodyLimit: 64 * 1024, rateLimit: { max: 60, timeWindow: "1 minute" } },    schema: {
      response: {
        200: z.unknown(),
        403: z.object({ error: z.string() }),
        429: z.object({ error: z.string() }),
      },
    },
  }, async (req, reply) => {
    // Extract YouTube video ID from the Atom XML body.
    const body = typeof req.body === "string"
      ? req.body
      : req.body instanceof Buffer
        ? req.body.toString("utf-8")
        : JSON.stringify(req.body ?? "");

    // ── X-Hub-Signature verification ─────────────────────────────────────
    // When YOUTUBE_WEBHOOK_SECRET is configured (and was passed as hub.secret
    // during subscription), YouTube signs every POST with:
    //   X-Hub-Signature: sha1=<hex>
    // Reject requests with a wrong or missing signature to prevent spoofing.
    if (env.YOUTUBE_WEBHOOK_SECRET) {
      const sigHeader = (req.headers as Record<string, string | string[] | undefined>)["x-hub-signature"];
      const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
      if (!sig || !sig.startsWith("sha1=")) {
        logger.warn({ reqId: req.id }, "youtube-webhook: missing X-Hub-Signature — rejecting");
        return reply.status(403).send({ error: "Missing signature" });
      }
      const expected = `sha1=${createHmac("sha1", env.YOUTUBE_WEBHOOK_SECRET).update(body).digest("hex")}`;
      const sigBuf = Buffer.from(sig);
      const expBuf = Buffer.from(expected);
      const valid = sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
      if (!valid) {
        logger.warn({ reqId: req.id }, "youtube-webhook: invalid X-Hub-Signature — rejecting");
        return reply.status(403).send({ error: "Invalid signature" });
      }
    }

    const videoIdMatch = body.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const videoId = videoIdMatch?.[1]?.trim();

    if (videoId) {
      logger.info({ videoId }, "youtube-webhook: new video notification — triggering immediate sync");

      // Debounce: schedule one sync, ignore duplicates arriving within 10 s.
      if (!webhookSyncPending) {
        webhookSyncPending = true;
        setTimeout(async () => {
          try {
            await youtubeSyncDispatcher.triggerNow();
          } catch (err) {
            logger.warn({ err }, "youtube-webhook: triggered sync failed (5-min poll will catch it)");
          } finally {
            webhookSyncPending = false;
          }
        }, 5_000).unref(); // 5-second delay to batch rapid consecutive notifications; unref so SIGTERM isn't blocked
      }
    } else {
      logger.debug({ bodySnippet: body.slice(0, 200) }, "youtube-webhook: POST received but no videoId found");
    }

    // Hub expects a 2xx response to confirm receipt.
    return reply.status(200).send("OK");
  });
}
