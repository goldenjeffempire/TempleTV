/**
 * YouTube Live Status Poller
 *
 * Detection strategy (in priority order):
 *   1. YouTube Data API v3 — when YOUTUBE_API_KEY + YOUTUBE_CHANNEL_ID are set.
 *      Calls /search?part=snippet&channelId=…&eventType=live&type=video.
 *      Cost: 100 quota units per call; default poll interval 90 s.
 *   2. RSS + yt:liveBroadcastContent — when no API key but YOUTUBE_CHANNEL_ID set.
 *      Parses https://www.youtube.com/feeds/videos.xml?channel_id=…
 *      Quota-free but only detects YouTube-native live events (not HLS overrides).
 *   3. Disabled — neither env var set. Returns { isLive: false, detectionMethod: "no-channel-configured" }.
 *
 * The singleton `ytPoller` is started by youtube-live.routes.ts on first SSE
 * connection and stopped on server shutdown (future). Routes call `ytPoller.getState()`
 * for REST responses and subscribe via `ytPoller.subscribe()` for SSE push.
 */

import EventEmitter from "node:events";
import https from "node:https";
import { DOMParser } from "@xmldom/xmldom";
import { trackQuota, isQuotaExhausted } from "../youtube-sync/youtube-sync.service.js";
import { logger } from "../../infrastructure/logger.js";

// Shared parser instance — DOMParser is stateless and safe to reuse.
// onError: () => {} suppresses non-fatal XML warnings (e.g. unknown namespace
// prefixes like yt:).  Fatal parse errors still throw ParseError so the outer
// try/catch in parseRssResponse() can degrade gracefully.
const _xmlParser = new DOMParser({ onError: () => {} });

export interface YtLiveState {
  isLive: boolean;
  videoId: string | null;
  title: string | null;
  viewerCount: number | null;
  checkedAt: number;
  detectionMethod:
    | "youtube-api-v3"
    | "youtube-rss"
    | "no-channel-configured"
    | "youtube-live-poller-disabled-in-build"
    | "api-error"
    | "rss-error";
  /** True when the channel has an upcoming (scheduled but not yet started) broadcast. */
  isUpcoming: boolean;
  /** YouTube video ID of the first upcoming broadcast, or null. */
  upcomingVideoId: string | null;
  /** Title of the upcoming broadcast, or null. */
  upcomingTitle: string | null;
}

type Listener = (state: YtLiveState) => void;

// Read env lazily on each call. The auto-override bridge mutates
// `process.env.YOUTUBE_CHANNEL_ID` at install-time to inject a default
// channel ID when the operator did not set one — that mutation must be
// visible here, so we cannot snapshot the value at module-load.
function ytApiKey(): string { return process.env["YOUTUBE_API_KEY"] ?? ""; }
function ytChannelId(): string { return process.env["YOUTUBE_CHANNEL_ID"] ?? ""; }

// RSS is now the primary live-detection mechanism (quota-free).
// search.list (100 units/call) is relegated to an infrequent safety net.
const RSS_POLL_INTERVAL_MS   = 60_000;               // 60 s — RSS primary, always on
const SAFETY_NET_INTERVAL_MS = 2 * 60 * 60_000;      // 2 h  — search.list safety net

function httpsGet(url: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve(body));
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("request timed out")); });
    req.on("error", reject);
  });
}

const _UPCOMING_DEFAULTS = { isUpcoming: false, upcomingVideoId: null, upcomingTitle: null } as const;

/** Parse the YouTube Data API v3 search response. */
function parseApiResponse(json: string): Omit<YtLiveState, "checkedAt"> {
  try {
    const data = JSON.parse(json) as {
      items?: Array<{
        id?: { videoId?: string };
        snippet?: { title?: string; liveBroadcastContent?: string };
      }>;
    };
    const items = data.items ?? [];
    const liveItems = items.filter(
      (i) => i.snippet?.liveBroadcastContent === "live",
    );
    if (liveItems.length === 0) {
      return { isLive: false, videoId: null, title: null, viewerCount: null, detectionMethod: "youtube-api-v3", ..._UPCOMING_DEFAULTS };
    }
    const first = liveItems[0];
    return {
      isLive: true,
      videoId: first?.id?.videoId ?? null,
      title: first?.snippet?.title ?? null,
      viewerCount: null,
      detectionMethod: "youtube-api-v3",
      ..._UPCOMING_DEFAULTS,
    };
  } catch {
    return { isLive: false, videoId: null, title: null, viewerCount: null, detectionMethod: "api-error", ..._UPCOMING_DEFAULTS };
  }
}

/**
 * Parse the YouTube RSS feed XML for live broadcasts.
 *
 * Uses @xmldom/xmldom's DOMParser instead of string splitting + regex so that:
 *   • CDATA-wrapped titles/content are handled natively via textContent
 *   • Whitespace variations around element values are normalised via .trim()
 *   • Completely malformed XML throws ParseError which is caught below and
 *     returned as detectionMethod:"rss-error" (graceful degradation)
 *   • Namespace-prefixed tags (yt:videoId, yt:liveBroadcastContent) are
 *     matched by local name regardless of the xmlns declaration order
 *
 * Exported for unit testing.
 */
export function parseRssResponse(xml: string): Omit<YtLiveState, "checkedAt"> {
  try {
    const doc = _xmlParser.parseFromString(xml, "text/xml");

    const entries = doc.getElementsByTagName("entry");

    let liveVideoId: string | null = null;
    let liveTitle: string | null = null;
    let upcomingVideoId: string | null = null;
    let upcomingTitle: string | null = null;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;

      // yt:liveBroadcastContent — "live" or "upcoming" (case-insensitive, trim)
      const lbcEls = entry.getElementsByTagName("yt:liveBroadcastContent");
      const lbc = lbcEls.length > 0 ? (lbcEls[0]?.textContent ?? "").trim().toLowerCase() : "";
      if (lbc !== "live" && lbc !== "upcoming") continue;

      // yt:videoId — required; skip entry if absent or empty
      const vidEls = entry.getElementsByTagName("yt:videoId");
      const videoId = vidEls.length > 0 ? (vidEls[0]?.textContent ?? "").trim() : "";
      if (!videoId) continue;

      // <title> — scoped to this entry (not the feed-level title)
      const titleEls = entry.getElementsByTagName("title");
      const rawTitle = titleEls.length > 0 ? (titleEls[0]?.textContent ?? "").trim() : "";
      // textContent already unwraps CDATA; decodeHtmlEntities handles &amp; etc
      const title = rawTitle ? decodeHtmlEntities(rawTitle) : null;

      if (lbc === "live" && !liveVideoId) {
        liveVideoId = videoId;
        liveTitle = title;
      } else if (lbc === "upcoming" && !upcomingVideoId) {
        upcomingVideoId = videoId;
        upcomingTitle = title;
      }

      // Short-circuit once we have both
      if (liveVideoId && upcomingVideoId) break;
    }

    const isLive = liveVideoId !== null;
    // isUpcoming is only surfaced when there is no active live stream —
    // the live banner should dominate when the channel IS live.
    const isUpcoming = !isLive && upcomingVideoId !== null;

    return {
      isLive,
      videoId: liveVideoId,
      title: liveTitle,
      viewerCount: null,
      detectionMethod: "youtube-rss",
      isUpcoming,
      upcomingVideoId,
      upcomingTitle,
    };
  } catch {
    // ParseError (fatal malformed XML) or any unexpected runtime error.
    // Always degrade gracefully: treat as "no live stream found" so the
    // orchestrator keeps the last-known state rather than crashing.
    return {
      isLive: false, videoId: null, title: null, viewerCount: null,
      detectionMethod: "rss-error",
      ..._UPCOMING_DEFAULTS,
    };
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

class YtLivePoller extends EventEmitter {
  private state: YtLiveState = {
    isLive: false,
    videoId: null,
    title: null,
    viewerCount: null,
    checkedAt: Date.now(),
    detectionMethod: "youtube-live-poller-disabled-in-build",
    isUpcoming: false,
    upcomingVideoId: null,
    upcomingTitle: null,
  };
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private _subs = new Set<Listener>();

  // ── Safety-net search.list timing ────────────────────────────────────────
  // The safety net fires search.list (100 units) at most once per
  // SAFETY_NET_INTERVAL_MS (2 h) to catch live streams that the RSS feed
  // has not yet indexed (typical RSS latency: 1–3 min for new streams).
  private _lastSafetyNetMs = 0;
  // Error backoff: 1-hour cooldown after a search.list API error.
  private _searchCooldownUntilMs = 0;

  // ── Viewer-count enrichment timing ───────────────────────────────────────
  // When live, videos.list?liveStreamingDetails (1 unit/call) is used to
  // fetch the real concurrent viewer count.  This field tracks a 30-minute
  // backoff applied only when the enrichment call itself returns an error.
  private _enrichCooldownUntilMs = 0;

  getState(): YtLiveState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this._subs.add(fn);
    fn(this.state);
    return () => { this._subs.delete(fn); };
  }

  start(): void {
    if (this.running) return;
    if (!ytChannelId()) {
      this.setState({
        isLive: false,
        videoId: null,
        title: null,
        viewerCount: null,
        checkedAt: Date.now(),
        detectionMethod: "no-channel-configured",
        ..._UPCOMING_DEFAULTS,
      });
      return;
    }
    this.running = true;
    void this.poll();
    // RSS is now the primary detector — the interval is always RSS_POLL_INTERVAL_MS
    // (60 s) regardless of whether an API key is configured.  The search.list
    // safety net fires conditionally inside poll() on its own 2-hour cadence.
    this.timer = setInterval(() => { void this.poll(); }, RSS_POLL_INTERVAL_MS);
    // unref so this timer never keeps the Node event loop alive past shutdown.
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const channelId = ytChannelId();
      if (!channelId) {
        this.setState({
          isLive: false, videoId: null, title: null, viewerCount: null,
          checkedAt: Date.now(), detectionMethod: "no-channel-configured",
          ..._UPCOMING_DEFAULTS,
        });
        return;
      }

      // ── Step 1: RSS — primary live detector (quota-free, always on) ──────────
      // The YouTube RSS feed reflects live/offline state within ~1–3 minutes of a
      // broadcast starting.  This eliminates the 100-unit search.list cost on every
      // poll cycle and cuts quota consumption by >99% during non-live periods.
      let result: Omit<YtLiveState, "checkedAt"> = await this.pollRss();

      if (result.isLive && result.videoId) {
        // ── Step 2: Viewer-count enrichment — videos.list (1 unit/call) ─────────
        // RSS does not carry a concurrent viewer count.  When live, call
        // videos.list?part=liveStreamingDetails for the real viewer count.
        // Suppressed when quota is locally exhausted or an error cooldown is active.
        const apiKey = ytApiKey();
        if (apiKey && !isQuotaExhausted() && Date.now() >= this._enrichCooldownUntilMs) {
          const vc = await this.fetchViewerCount(result.videoId, apiKey);
          if (vc !== null) result = { ...result, viewerCount: vc };
        }
      } else {
        // ── Step 3: Safety-net search.list (100 units, at most once per 2 h) ────
        // Catches live streams that RSS has not yet indexed.  The safety net is
        // skipped when quota is locally exhausted, an API error cooldown is active,
        // or the interval has not yet elapsed since the last call.
        const now = Date.now();
        const apiKey = ytApiKey();
        if (
          apiKey &&
          !isQuotaExhausted() &&
          now - this._lastSafetyNetMs >= SAFETY_NET_INTERVAL_MS &&
          now >= this._searchCooldownUntilMs
        ) {
          this._lastSafetyNetMs = now;
          const searchResult = await this.pollApi();
          if (searchResult.isLive) {
            // RSS has not yet indexed this stream — trust the API for live
            // state, but preserve the upcoming state the RSS already returned
            // (the API safety-net only searches for "live" events, not "upcoming").
            result = {
              ...searchResult,
              isUpcoming: result.isUpcoming,
              upcomingVideoId: result.upcomingVideoId,
              upcomingTitle: result.upcomingTitle,
            };
          }
          if (searchResult.detectionMethod === "api-error") {
            // Transient API error: suppress safety-net for 1 hour.
            this._searchCooldownUntilMs = now + 60 * 60_000;
            logger.warn("youtube-live: search.list error — safety-net suppressed for 1 h");
          }
        }
      }

      this.setState({ ...result, checkedAt: Date.now() });
    } catch (err) {
      // Outer guard: any unexpected error (DB blip, network timeout that wasn't
      // caught in pollRss/pollApi) must NOT propagate as an unhandled rejection.
      // Node ≥15 terminates the process on unhandled rejections; a stale live-
      // status is far preferable to taking down the broadcast server.
      logger.warn({ err }, "[youtube-live] poll error (non-fatal) — live status unchanged until next tick");
    }
  }

  /**
   * Fetch concurrent viewer count for a live video via videos.list
   * (liveStreamingDetails part).  Cost: 1 quota unit per call.
   *
   * On error, sets a 30-minute backoff so a transient API problem does not
   * silently consume quota units every 60 seconds for the rest of the broadcast.
   * Returns null on any error; callers fall back to the RSS-derived state.
   */
  private async fetchViewerCount(videoId: string, apiKey: string): Promise<number | null> {
    try {
      const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      trackQuota("videos.list.liveDetails", 1);
      if (!res.ok) {
        // Set a 30-minute backoff: enrichment errors should not consume quota
        // on every poll tick for the duration of a live broadcast.
        this._enrichCooldownUntilMs = Date.now() + 30 * 60_000;
        return null;
      }
      this._enrichCooldownUntilMs = 0; // clear backoff on success
      const data = await res.json() as {
        items?: Array<{ liveStreamingDetails?: { concurrentViewers?: string } }>;
      };
      const vc = data.items?.[0]?.liveStreamingDetails?.concurrentViewers;
      return vc !== undefined ? parseInt(vc, 10) : null;
    } catch {
      return null;
    }
  }

  /**
   * Safety-net search.list call (100 quota units).
   * Only invoked by poll() at most once per SAFETY_NET_INTERVAL_MS (2 h)
   * to catch streams RSS has not yet indexed.
   */
  private async pollApi(): Promise<Omit<YtLiveState, "checkedAt">> {
    try {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(ytChannelId())}&eventType=live&type=video&key=${encodeURIComponent(ytApiKey())}`;
      const body = await httpsGet(url, 12_000);
      // Each YouTube Data API v3 search call costs 100 quota units.
      // Track it so the admin quota dashboard reflects live-poller usage.
      trackQuota("search", 100);
      return parseApiResponse(body);
    } catch {
      return { isLive: false, videoId: null, title: null, viewerCount: null, detectionMethod: "api-error", ..._UPCOMING_DEFAULTS };
    }
  }

  private async pollRss(): Promise<Omit<YtLiveState, "checkedAt">> {
    try {
      const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(ytChannelId())}`;
      const body = await httpsGet(url, 12_000);
      return parseRssResponse(body);
    } catch {
      return { isLive: false, videoId: null, title: null, viewerCount: null, detectionMethod: "rss-error", ..._UPCOMING_DEFAULTS };
    }
  }

  private setState(next: YtLiveState): void {
    const prev = this.state;
    this.state = next;
    // Only notify if something meaningful changed
    if (
      prev.isLive !== next.isLive ||
      prev.videoId !== next.videoId ||
      prev.viewerCount !== next.viewerCount ||
      prev.isUpcoming !== next.isUpcoming ||
      prev.upcomingVideoId !== next.upcomingVideoId
    ) {
      this.emit("change", next);
      for (const fn of this._subs) {
        try { fn(next); } catch { /* swallow listener errors */ }
      }
    }
  }
}

export const ytPoller = new YtLivePoller();
