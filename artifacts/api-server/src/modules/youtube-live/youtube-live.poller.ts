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
import { trackQuota, isQuotaExhausted } from "../youtube-sync/youtube-sync.service.js";

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
}

type Listener = (state: YtLiveState) => void;

// Read env lazily on each call. The auto-override bridge mutates
// `process.env.YOUTUBE_CHANNEL_ID` at install-time to inject a default
// channel ID when the operator did not set one — that mutation must be
// visible here, so we cannot snapshot the value at module-load.
function ytApiKey(): string { return process.env["YOUTUBE_API_KEY"] ?? ""; }
function ytChannelId(): string { return process.env["YOUTUBE_CHANNEL_ID"] ?? ""; }

const API_POLL_INTERVAL_MS = 90_000;  // 90s — 100 quota units per call
const RSS_POLL_INTERVAL_MS = 60_000;  // 60s — quota-free

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
      return { isLive: false, videoId: null, title: null, viewerCount: null, detectionMethod: "youtube-api-v3" };
    }
    const first = liveItems[0];
    return {
      isLive: true,
      videoId: first?.id?.videoId ?? null,
      title: first?.snippet?.title ?? null,
      viewerCount: null,
      detectionMethod: "youtube-api-v3",
    };
  } catch {
    return { isLive: false, videoId: null, title: null, viewerCount: null, detectionMethod: "api-error" };
  }
}

/** Parse the YouTube RSS feed XML for live broadcasts. */
function parseRssResponse(xml: string): Omit<YtLiveState, "checkedAt"> {
  try {
    // Match entries with <yt:videoId>…</yt:videoId> and <yt:liveBroadcastContent>live</yt:liveBroadcastContent>
    const entries = xml.split("<entry>").slice(1);
    for (const entry of entries) {
      const liveMatch = /<yt:liveBroadcastContent>\s*live\s*<\/yt:liveBroadcastContent>/i.test(entry);
      if (!liveMatch) continue;
      const vidMatch = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(entry);
      const titleMatch = /<title>([^<]+)<\/title>/.exec(entry);
      if (vidMatch) {
        return {
          isLive: true,
          videoId: vidMatch[1]?.trim() ?? null,
          title: titleMatch ? decodeHtmlEntities(titleMatch[1]?.trim() ?? "") : null,
          viewerCount: null,
          detectionMethod: "youtube-rss",
        };
      }
    }
    return { isLive: false, videoId: null, title: null, viewerCount: null, detectionMethod: "youtube-rss" };
  } catch {
    return { isLive: false, videoId: null, title: null, viewerCount: null, detectionMethod: "rss-error" };
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
  };
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private _subs = new Set<Listener>();
  // Timestamp until which pollApi() calls are suppressed after a quota/API error.
  // Prevents hammering an exhausted quota (resets daily) for the remaining day.
  private apiCooldownUntilMs = 0;

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
      });
      return;
    }
    this.running = true;
    this.poll();
    const interval = ytApiKey() ? API_POLL_INTERVAL_MS : RSS_POLL_INTERVAL_MS;
    this.timer = setInterval(() => { this.poll(); }, interval);
    // unref so this background poll interval never keeps the Node event loop
    // alive past app.close() during graceful shutdown (stop() is not wired into
    // the shutdown sequence, so without this the process waits for the force-
    // exit grace timer to fire).
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
    let result: Omit<YtLiveState, "checkedAt">;
    const apiKey = ytApiKey();
    const channelId = ytChannelId();
    if (apiKey && channelId) {
      if (Date.now() < this.apiCooldownUntilMs) {
        // API quota exhausted or key invalid — skip Data API v3 call and use
        // quota-free RSS exclusively until the cooldown window expires.
        result = await this.pollRss();
      } else if (isQuotaExhausted()) {
        // Local quota counter says the daily limit is used up.  Each search.list
        // call costs 100 units — continuing to poll would burn 100 units every
        // 90 s for the rest of the day even though the sync service has already
        // switched to RSS.  Set the cooldown to midnight UTC so we stay on
        // quota-free RSS until the daily quota resets.
        const midnight = new Date();
        midnight.setUTCHours(24, 0, 0, 0);
        this.apiCooldownUntilMs = midnight.getTime();
        result = await this.pollRss();
      } else {
        result = await this.pollApi();
        // If the API returned an error (403 quota exhausted, invalid key, rate
        // limit, or any network failure), back off API calls for 1 hour and fall
        // back to RSS so live detection remains accurate. Without the cooldown the
        // poller would hammer an exhausted quota at full speed (every 90 s) for
        // the rest of the day, wasting quota units that become available again at
        // midnight Pacific.
        if (result.detectionMethod === "api-error") {
          this.apiCooldownUntilMs = Date.now() + 60 * 60 * 1000;
          result = await this.pollRss();
        }
      }
    } else if (channelId) {
      result = await this.pollRss();
    } else {
      result = { isLive: false, videoId: null, title: null, viewerCount: null, detectionMethod: "no-channel-configured" };
    }
    this.setState({ ...result, checkedAt: Date.now() });
  }

  private async pollApi(): Promise<Omit<YtLiveState, "checkedAt">> {
    try {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(ytChannelId())}&eventType=live&type=video&key=${encodeURIComponent(ytApiKey())}`;
      const body = await httpsGet(url, 12_000);
      // Each YouTube Data API v3 search call costs 100 quota units.
      // Track it so the admin quota dashboard reflects live-poller usage.
      trackQuota("search", 100);
      return parseApiResponse(body);
    } catch {
      return { isLive: false, videoId: null, title: null, viewerCount: null, detectionMethod: "api-error" };
    }
  }

  private async pollRss(): Promise<Omit<YtLiveState, "checkedAt">> {
    try {
      const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(ytChannelId())}`;
      const body = await httpsGet(url, 12_000);
      return parseRssResponse(body);
    } catch {
      return { isLive: false, videoId: null, title: null, viewerCount: null, detectionMethod: "rss-error" };
    }
  }

  private setState(next: YtLiveState): void {
    const prev = this.state;
    this.state = next;
    // Only notify if something meaningful changed
    if (
      prev.isLive !== next.isLive ||
      prev.videoId !== next.videoId ||
      prev.viewerCount !== next.viewerCount
    ) {
      this.emit("change", next);
      for (const fn of this._subs) {
        try { fn(next); } catch { /* swallow listener errors */ }
      }
    }
  }
}

export const ytPoller = new YtLivePoller();
