/**
 * Signed-URL cache hit-rate metrics.
 *
 * The two media-redirect middlewares (`s3RedirectFirstForLargeMedia` and
 * `s3FallbackMiddleware` in redirect mode) both keep a per-key in-memory
 * presigned-URL cache to avoid re-signing on every HTML5 `<video>` Range
 * request. Without that cache a single sustained playback session was
 * triggering one S3 SigV4 sign every ~5s per viewer in production.
 *
 * This module gives operators a way to *see* the savings live. Each redirect
 * decision records one hit against either `fresh` (a new presign was minted)
 * or `cached` (the previously-minted URL was reused), bucketed by which
 * middleware served it. The counters are pure in-memory monotonic integers
 * — no allocation per call beyond a numeric increment — and are exposed via
 * `/admin/ops/status` so the admin Operations page can plot hit rate and
 * confirm the cache is doing what it's supposed to be doing.
 *
 * Counters are process-local. The values reset to zero on every deploy /
 * worker restart, which is the desired behaviour: we want hit-rate against
 * *current* traffic, not a lifetime accumulator that drifts with old data.
 */

export type SignedUrlSource = "s3-redirect-first" | "s3-redirect";
export type SignedUrlOutcome = "fresh" | "cached";

interface Counter {
  fresh: number;
  cached: number;
}

const counters: Record<SignedUrlSource, Counter> = {
  "s3-redirect-first": { fresh: 0, cached: 0 },
  "s3-redirect": { fresh: 0, cached: 0 },
};

const startedAt = Date.now();

export function recordSignedUrlHit(
  source: SignedUrlSource,
  outcome: SignedUrlOutcome,
): void {
  // Defence-in-depth: never let a bad source label crash the request path.
  const bucket = counters[source];
  if (!bucket) return;
  bucket[outcome] += 1;
}

export interface SignedUrlMetricsSnapshot {
  startedAt: string;
  uptimeSecs: number;
  total: { fresh: number; cached: number; hits: number; hitRate: number };
  bySource: Record<
    SignedUrlSource,
    { fresh: number; cached: number; hits: number; hitRate: number }
  >;
}

function ratio(cached: number, total: number): number {
  if (total <= 0) return 0;
  // Round to 4dp so the JSON stays compact and the admin UI can render
  // a percentage without further work.
  return Math.round((cached / total) * 10_000) / 10_000;
}

export function signedUrlMetricsSnapshot(): SignedUrlMetricsSnapshot {
  const sources: SignedUrlSource[] = ["s3-redirect-first", "s3-redirect"];
  const bySource = sources.reduce(
    (acc, src) => {
      const c = counters[src];
      const hits = c.fresh + c.cached;
      acc[src] = {
        fresh: c.fresh,
        cached: c.cached,
        hits,
        hitRate: ratio(c.cached, hits),
      };
      return acc;
    },
    {} as SignedUrlMetricsSnapshot["bySource"],
  );

  const totalFresh = bySource["s3-redirect-first"].fresh + bySource["s3-redirect"].fresh;
  const totalCached = bySource["s3-redirect-first"].cached + bySource["s3-redirect"].cached;
  const totalHits = totalFresh + totalCached;

  return {
    startedAt: new Date(startedAt).toISOString(),
    uptimeSecs: Math.round((Date.now() - startedAt) / 1000),
    total: {
      fresh: totalFresh,
      cached: totalCached,
      hits: totalHits,
      hitRate: ratio(totalCached, totalHits),
    },
    bySource,
  };
}
