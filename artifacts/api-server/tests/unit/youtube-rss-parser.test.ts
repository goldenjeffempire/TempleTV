/**
 * youtube-rss-parser.test.ts
 *
 * Unit tests for the YouTube RSS feed parser used by the live-detection poller.
 *
 * The production parser switched from brittle string-splitting + regex to a
 * proper XML DOM parse (@xmldom/xmldom) to handle:
 *   • CDATA-wrapped titles / descriptions
 *   • Whitespace variations around element text nodes
 *   • Malformed feeds → graceful "no live stream" instead of crash
 *   • Feed-level <title> not confused with entry-level <title>
 *   • Entries where yt:videoId is absent (skip, don't crash)
 */

import { describe, it, expect } from "vitest";
import { parseRssResponse } from "../../src/modules/youtube-live/youtube-live.poller.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function feed(entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns="http://www.w3.org/2005/Atom">
  <title>Test Channel</title>
  ${entries.join("\n  ")}
</feed>`;
}

function entry({
  videoId,
  title,
  lbc,
}: {
  videoId: string;
  title: string;
  lbc: string;
}): string {
  return `<entry>
    <yt:videoId>${videoId}</yt:videoId>
    <title>${title}</title>
    <yt:liveBroadcastContent>${lbc}</yt:liveBroadcastContent>
  </entry>`;
}

// ── Basic live detection ────────────────────────────────────────────────────

describe("parseRssResponse — basic live detection", () => {
  it("returns isLive=true when a single live entry is present", () => {
    const xml = feed([entry({ videoId: "abc123", title: "Sunday Service", lbc: "live" })]);
    const result = parseRssResponse(xml);
    expect(result.isLive).toBe(true);
    expect(result.videoId).toBe("abc123");
    expect(result.title).toBe("Sunday Service");
    expect(result.detectionMethod).toBe("youtube-rss");
  });

  it("returns isLive=false when all entries are none", () => {
    const xml = feed([
      entry({ videoId: "vid1", title: "Past Sermon 1", lbc: "none" }),
      entry({ videoId: "vid2", title: "Past Sermon 2", lbc: "none" }),
    ]);
    const result = parseRssResponse(xml);
    expect(result.isLive).toBe(false);
    expect(result.videoId).toBeNull();
    expect(result.detectionMethod).toBe("youtube-rss");
  });

  it("returns isLive=false for an empty feed (no entries)", () => {
    const xml = feed([]);
    const result = parseRssResponse(xml);
    expect(result.isLive).toBe(false);
    expect(result.viewerCount).toBeNull();
  });

  it("picks the live entry when mixed with non-live entries", () => {
    const xml = feed([
      entry({ videoId: "old1", title: "Past Sermon", lbc: "none" }),
      entry({ videoId: "live1", title: "Live Now", lbc: "live" }),
      entry({ videoId: "old2", title: "Another Past", lbc: "completed" }),
    ]);
    const result = parseRssResponse(xml);
    expect(result.isLive).toBe(true);
    expect(result.videoId).toBe("live1");
  });
});

// ── CDATA and HTML entities ─────────────────────────────────────────────────

describe("parseRssResponse — CDATA and HTML entities", () => {
  it("unwraps CDATA in title correctly", () => {
    const xml = feed([
      `<entry>
        <yt:videoId>cdata1</yt:videoId>
        <title><![CDATA[Worship & Praise — Live Stream]]></title>
        <yt:liveBroadcastContent>live</yt:liveBroadcastContent>
      </entry>`,
    ]);
    const result = parseRssResponse(xml);
    expect(result.isLive).toBe(true);
    expect(result.title).toBe("Worship & Praise — Live Stream");
  });

  it("decodes HTML entities in title", () => {
    const xml = feed([
      entry({ videoId: "ent1", title: "Q&amp;A Session &lt;Live&gt;", lbc: "live" }),
    ]);
    const result = parseRssResponse(xml);
    expect(result.title).toBe("Q&A Session <Live>");
  });

  it("handles CDATA in yt:liveBroadcastContent", () => {
    const xml = feed([
      `<entry>
        <yt:videoId>cdata2</yt:videoId>
        <title>Service</title>
        <yt:liveBroadcastContent><![CDATA[live]]></yt:liveBroadcastContent>
      </entry>`,
    ]);
    const result = parseRssResponse(xml);
    expect(result.isLive).toBe(true);
    expect(result.videoId).toBe("cdata2");
  });
});

// ── Whitespace tolerance ────────────────────────────────────────────────────

describe("parseRssResponse — whitespace tolerance", () => {
  it("ignores surrounding whitespace in yt:liveBroadcastContent", () => {
    const xml = feed([
      `<entry>
        <yt:videoId>ws1</yt:videoId>
        <title>Service</title>
        <yt:liveBroadcastContent>
          live
        </yt:liveBroadcastContent>
      </entry>`,
    ]);
    const result = parseRssResponse(xml);
    expect(result.isLive).toBe(true);
    expect(result.videoId).toBe("ws1");
  });

  it("is case-insensitive for liveBroadcastContent value", () => {
    const xml = feed([
      `<entry>
        <yt:videoId>ci1</yt:videoId>
        <title>Service</title>
        <yt:liveBroadcastContent>LIVE</yt:liveBroadcastContent>
      </entry>`,
    ]);
    const result = parseRssResponse(xml);
    expect(result.isLive).toBe(true);
  });

  it("trims whitespace from videoId", () => {
    const xml = feed([
      `<entry>
        <yt:videoId>  trimmed123  </yt:videoId>
        <title>Service</title>
        <yt:liveBroadcastContent>live</yt:liveBroadcastContent>
      </entry>`,
    ]);
    const result = parseRssResponse(xml);
    expect(result.videoId).toBe("trimmed123");
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe("parseRssResponse — edge cases", () => {
  it("skips live entry with missing yt:videoId", () => {
    const xml = feed([
      `<entry>
        <title>Service</title>
        <yt:liveBroadcastContent>live</yt:liveBroadcastContent>
      </entry>`,
    ]);
    const result = parseRssResponse(xml);
    expect(result.isLive).toBe(false);
    expect(result.detectionMethod).toBe("youtube-rss");
  });

  it("skips live entry with empty yt:videoId, returns next live entry", () => {
    const xml = feed([
      `<entry>
        <yt:videoId></yt:videoId>
        <title>Empty ID</title>
        <yt:liveBroadcastContent>live</yt:liveBroadcastContent>
      </entry>`,
      entry({ videoId: "goodid", title: "Real Stream", lbc: "live" }),
    ]);
    const result = parseRssResponse(xml);
    expect(result.isLive).toBe(true);
    expect(result.videoId).toBe("goodid");
  });

  it("does not confuse feed-level <title> with entry-level <title>", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns="http://www.w3.org/2005/Atom">
  <title>Channel Name (Feed Level)</title>
  <entry>
    <yt:videoId>feedtitle1</yt:videoId>
    <title>Entry Title</title>
    <yt:liveBroadcastContent>live</yt:liveBroadcastContent>
  </entry>
</feed>`;
    const result = parseRssResponse(xml);
    expect(result.isLive).toBe(true);
    expect(result.title).toBe("Entry Title");
  });

  it("handles missing <title> in live entry (title=null)", () => {
    const xml = feed([
      `<entry>
        <yt:videoId>notitle1</yt:videoId>
        <yt:liveBroadcastContent>live</yt:liveBroadcastContent>
      </entry>`,
    ]);
    const result = parseRssResponse(xml);
    expect(result.isLive).toBe(true);
    expect(result.videoId).toBe("notitle1");
    expect(result.title).toBeNull();
  });
});

// ── Malformed / hostile feed ────────────────────────────────────────────────

describe("parseRssResponse — graceful degradation on malformed feeds", () => {
  it("returns rss-error (not a crash) on completely invalid XML", () => {
    const result = parseRssResponse("this is not xml at all {{}}");
    expect(result.isLive).toBe(false);
    expect(result.detectionMethod).toBe("rss-error");
    expect(result.videoId).toBeNull();
  });

  it("returns rss-error on empty string", () => {
    const result = parseRssResponse("");
    expect(result.isLive).toBe(false);
    expect(result.detectionMethod).toBe("rss-error");
  });

  it("returns youtube-rss (no live) on valid XML with no entry elements", () => {
    const result = parseRssResponse("<feed><notanentry/></feed>");
    expect(result.isLive).toBe(false);
    expect(result.detectionMethod).toBe("youtube-rss");
  });

  it("returns youtube-rss (no live) on truncated but parseable feed", () => {
    // Truncated mid-stream but still valid XML up to the cut point
    const xml = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <entry>
    <yt:videoId>trunc1</yt:videoId>
    <yt:liveBroadcastContent>none</yt:liveBroadcastContent>
  </entry>
</feed>`;
    const result = parseRssResponse(xml);
    expect(result.isLive).toBe(false);
    expect(result.detectionMethod).toBe("youtube-rss");
  });

  it("handles a feed where yt:liveBroadcastContent is absent on every entry", () => {
    const xml = feed([
      `<entry><yt:videoId>nolbc</yt:videoId><title>No LBC</title></entry>`,
    ]);
    const result = parseRssResponse(xml);
    expect(result.isLive).toBe(false);
  });
});
