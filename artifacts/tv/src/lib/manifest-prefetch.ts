/**
 * Manifest prefetch helper — issues a `<link rel="prefetch" as="fetch">`
 * for an HLS .m3u8 URL the moment a card gains focus on the TV grid.
 * By the time the user clicks Play, the master playlist is already in
 * the HTTP cache, eliminating ~150–400 ms of the startup waterfall on
 * Smart-TV CPUs (slow TLS + slow network on consumer ISPs).
 *
 * Dedup is process-wide so re-focusing a card never re-injects, and
 * a soft cap of 24 cached prefetches keeps the DOM from growing
 * unbounded if the user scrolls a long catalog.
 */

const SOFT_CAP = 24;
const issued = new Map<string, HTMLLinkElement>();
const order: string[] = [];

export function prefetchManifest(url: string | null | undefined): void {
  if (!url || typeof url !== "string") return;
  if (!/\.m3u8(\?|$)/i.test(url)) return;
  if (issued.has(url)) return;
  if (typeof document === "undefined") return;

  try {
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.as = "fetch";
    link.crossOrigin = "anonymous";
    link.href = url;
    document.head.appendChild(link);
    issued.set(url, link);
    order.push(url);

    while (order.length > SOFT_CAP) {
      const oldest = order.shift();
      if (!oldest) break;
      const el = issued.get(oldest);
      if (el?.parentNode) el.parentNode.removeChild(el);
      issued.delete(oldest);
    }
  } catch {
    /* DOM not available (SSR, sandboxed iframe) — no-op */
  }
}

/**
 * Hint the browser to start TLS / DNS to the host of an arbitrary
 * media URL. Cheap (one DNS lookup) and complements `preconnect` in
 * index.html for hosts we don't know at build time (e.g. signed S3
 * URLs whose hostname rotates).
 */
export function preconnectMediaHost(url: string | null | undefined): void {
  if (!url || typeof url !== "string") return;
  if (typeof document === "undefined") return;
  try {
    const u = new URL(url, window.location.origin);
    const key = `__pc:${u.origin}`;
    if (issued.has(key)) return;
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = u.origin;
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
    issued.set(key, link);
  } catch {
    /* invalid URL — no-op */
  }
}
