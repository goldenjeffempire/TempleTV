import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { logger } from "../../infrastructure/logger.js";

/**
 * Media proxy — streams external video/audio assets through this server,
 * stripping upstream CORS/CORP restrictions so any surface (admin, TV, mobile)
 * can load the bytes regardless of which origin originally hosts the file.
 *
 * Security layers:
 *  1. HMAC signature — every proxied URL is signed at generation time in
 *     queue.repo.ts using JWT_ACCESS_SECRET. Unsigned or tampered URLs
 *     receive 403 without fetching anything.
 *  2. SSRF allowlist — even with a valid signature, the target host is
 *     checked against the same allowlist used by the source resolver. Unrecognised
 *     hosts receive 403.
 *  3. Rate limiting — overrides the global default to 400 req/min so
 *     concurrent segment fetches from multiple viewers don't hit the cap.
 *
 * Range request pass-through:
 *  MP4 progressive download relies on Range requests for seeking. The proxy
 *  forwards the client's Range header to the upstream, relays the 206
 *  status + Content-Range + Accept-Ranges headers, and streams the partial
 *  body unchanged.
 *
 * Route: GET /api/v1/media-proxy?url=ENCODED_URL&sig=HEX_HMAC_SHA256
 */

const ALLOWED_HOST_SUFFIXES: ReadonlyArray<string> = [
  ".cloudfront.net",
  ".amazonaws.com",
  ".replit.app",
  ".replit.dev",
  ".onrender.com",
  "youtube.com",
  "youtu.be",
  ".googlevideo.com",
  ".ytimg.com",
  "templetv.org.ng",
  ".templetv.org.ng",
  "localhost",
  "127.0.0.1",
];

function isAllowedHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((suf) => {
    if (suf.startsWith(".")) {
      // Suffix like ".cloudfront.net" — bare host or any subdomain
      return host === suf.slice(1) || host.endsWith(suf);
    }
    // Bare domain like "youtube.com" — exact host or subdomain with explicit dot
    // Using `host.endsWith(suf)` alone would also match "evilyoutube.com", so
    // we require the dot anchor for subdomain checks.
    return host === suf || host.endsWith("." + suf);
  });
}

/**
 * Verify an HMAC-SHA256 signature produced by makeMediaProxyUrl() in
 * queue.repo.ts using the same JWT_ACCESS_SECRET. Uses timing-safe
 * comparison to prevent timing-oracle attacks.
 */
function verifySig(url: string, sig: string): boolean {
  try {
    const secret = env.JWT_ACCESS_SECRET;
    const expected = createHmac("sha256", secret).update(url).digest("hex");
    if (sig.length !== expected.length) return false;
    const eBuf = Buffer.from(expected, "hex");
    const sBuf = Buffer.from(sig, "hex");
    return timingSafeEqual(eBuf, sBuf);
  } catch {
    return false;
  }
}

export async function mediaProxyRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { url?: string; sig?: string } }>(
    "/media-proxy",
    {
      config: {
        rateLimit: { max: 400, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const { url: rawUrl, sig } = req.query;

      if (!rawUrl || !sig) {
        return reply
          .code(400)
          .send({ error: "url and sig query params are required" });
      }

      let targetUrl: string;
      try {
        targetUrl = decodeURIComponent(rawUrl);
      } catch {
        return reply.code(400).send({ error: "url is not valid percent-encoding" });
      }

      if (!verifySig(targetUrl, sig)) {
        // Log only the host (never the full URL) — query params may carry
        // user-identifying tokens or signed path segments (PII in logs risk).
        let targetHost = "(unparseable)";
        try { targetHost = new URL(targetUrl).host; } catch { /* noop */ }
        logger.warn({ targetHost }, "[media-proxy] rejected — invalid signature");
        return reply.code(403).send({ error: "Invalid signature" });
      }

      if (!isAllowedHost(targetUrl)) {
        let targetHost = "(unparseable)";
        try { targetHost = new URL(targetUrl).host; } catch { /* noop */ }
        logger.warn({ targetHost }, "[media-proxy] rejected — host not in allowlist");
        return reply.code(403).send({ error: "Target host not in proxy allowlist" });
      }

      // Forward Range header so MP4 seeking works (206 partial content).
      const rangeHeader =
        typeof req.headers["range"] === "string" ? req.headers["range"] : undefined;

      const fetchHeaders: Record<string, string> = {
        "User-Agent": "TempleTV-MediaProxy/1.0",
        "Accept": "*/*",
      };
      if (rangeHeader) fetchHeaders["Range"] = rangeHeader;

      // Use a manual AbortController so we can time-limit ONLY the connection
      // phase (time-to-first-byte) without aborting the body mid-stream.
      // AbortSignal.timeout(30_000) would abort the entire request — including
      // the body — after 30 s, which kills a 291 MB video stream mid-transfer
      // and causes the browser's <video> element to fire MEDIA_ERR_NETWORK.
      const ctrl = new AbortController();
      const connectionTimeout = setTimeout(() => ctrl.abort(), 30_000);

      let upstream: Response;
      try {
        upstream = await fetch(targetUrl, {
          headers: fetchHeaders,
          signal: ctrl.signal,
        });
        // First-byte received — cancel the connection timeout so the body can
        // stream at whatever pace the network allows without being killed.
        clearTimeout(connectionTimeout);
      } catch (err) {
        clearTimeout(connectionTimeout);
        logger.warn(
          { url: targetUrl, err: String(err) },
          "[media-proxy] upstream fetch failed",
        );
        return reply.code(502).send({ error: "Upstream unavailable" });
      }

      const upStatus = upstream.status;

      // 206 = partial content (Range), 200 = full file, others = errors.
      if (upStatus !== 200 && upStatus !== 206) {
        logger.warn(
          { url: targetUrl, status: upStatus },
          "[media-proxy] upstream returned non-2xx",
        );
        const downStatus = upStatus === 404 ? 404 : upStatus < 500 ? 400 : 502;
        return reply.code(downStatus).send({ error: `Upstream returned ${upStatus}` });
      }

      reply.code(upStatus);

      // Forward content headers so the browser and hls.js handle the stream
      // correctly without extra HEAD round-trips.
      const ct = upstream.headers.get("content-type");
      if (ct) reply.header("Content-Type", ct);

      const cl = upstream.headers.get("content-length");
      if (cl) reply.header("Content-Length", cl);

      // Range response headers — required for video seeking.
      const cr = upstream.headers.get("content-range");
      if (cr) reply.header("Content-Range", cr);

      // Honest Accept-Ranges signalling:
      // If the client sent a Range request but the upstream returned 200 (not
      // 206), the upstream silently ignored the Range header. Advertising
      // "Accept-Ranges: bytes" to the browser in that case causes a feedback
      // loop where the browser keeps sending Range requests expecting 206 and
      // getting confused 200s, making it unable to locate the moov atom and
      // ultimately failing to play the video. Signal "none" instead so the
      // browser falls back to progressive full-file download without retrying.
      const clientRequestedRange = !!rangeHeader;
      const upstreamHonoredRange = upStatus === 206;
      const ar = upstream.headers.get("accept-ranges");
      if (clientRequestedRange && !upstreamHonoredRange) {
        reply.header("Accept-Ranges", "none");
      } else {
        reply.header("Accept-Ranges", ar ?? "bytes");
      }

      // Media access headers: allow any origin and explicitly lift the
      // same-origin CORP restriction that helmet sets globally. This is the
      // whole reason this proxy exists.
      reply
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD")
        .header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header("Timing-Allow-Origin", "*")
        .header("Cache-Control", "public, max-age=3600");

      if (!upstream.body) {
        return reply.send(Buffer.alloc(0));
      }

      return reply.send(upstream.body);
    },
  );

  // OPTIONS preflight handler so browsers can probe the proxy endpoint.
  app.options("/media-proxy", async (_req, reply) => {
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
      .header("Access-Control-Allow-Headers", "Range")
      .header("Access-Control-Max-Age", "86400")
      .header("Cross-Origin-Resource-Policy", "cross-origin")
      .code(204)
      .send();
  });
}
