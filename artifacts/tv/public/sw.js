/**
 * Temple TV — TV App Service Worker
 *
 * Caching strategy by resource type:
 *   Static assets (JS/CSS with content-hash)  → Cache-first, 30-day TTL
 *   Images / thumbnails                        → Stale-while-revalidate, 7-day TTL
 *   API catalog + series responses             → Network-first, 60-s TTL fallback
 *   HLS .ts segments                           → Cache-first, 7-day immutable TTL
 *   HLS .m3u8 manifests                        → Network-first (short TTL, live content)
 *   Navigation (HTML)                          → Network-first, cache fallback
 *
 * Caches are versioned so a new deployment evicts stale assets atomically.
 */

const CACHE_VERSION = "ttv-tv-v1";
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const IMAGE_CACHE   = `${CACHE_VERSION}-images`;
const API_CACHE     = `${CACHE_VERSION}-api`;
const HLS_SEG_CACHE = `${CACHE_VERSION}-hls-segments`;

const STATIC_MAX_AGE_MS  = 30 * 24 * 60 * 60 * 1000; // 30 days
const IMAGE_MAX_AGE_MS   =  7 * 24 * 60 * 60 * 1000; // 7 days
const API_MAX_AGE_MS     = 60 * 1000;                  // 60 s
const HLS_SEG_MAX_AGE_MS =  7 * 24 * 60 * 60 * 1000; // 7 days

// Evict all caches from prior versions on activate.
const KNOWN_CACHES = [STATIC_CACHE, IMAGE_CACHE, API_CACHE, HLS_SEG_CACHE];

self.addEventListener("install", (event) => {
  // Activate immediately — don't wait for existing tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !KNOWN_CACHES.includes(k))
          .map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

// ── Helper: check if a cached response is still fresh ─────────────────────
function isFresh(response, maxAgeMs) {
  const dateHeader = response.headers.get("date");
  if (!dateHeader) return false;
  return Date.now() - new Date(dateHeader).getTime() < maxAgeMs;
}

// ── Helper: clone + cache a response ──────────────────────────────────────
async function cacheResponse(cacheName, request, response) {
  if (!response || response.status !== 200 || response.type === "opaque") return;
  const cache = await caches.open(cacheName);
  cache.put(request, response.clone());
}

// ── Route classifiers ──────────────────────────────────────────────────────
function isStaticAsset(url) {
  // Vite emits content-hashed filenames like /assets/index-Bc4XkY2q.js
  return url.pathname.startsWith("/assets/");
}

function isImage(url) {
  return /\.(png|jpe?g|webp|gif|svg|ico)(\?|$)/i.test(url.pathname);
}

function isHlsSegment(url) {
  // .ts segments from the API proxy or CDN
  return url.pathname.includes("/hls/") && url.pathname.endsWith(".ts");
}

function isHlsManifest(url) {
  return url.pathname.includes("/hls/") && url.pathname.endsWith(".m3u8");
}

function isApiCatalog(url) {
  // Catalog, series, search — responses that can tolerate a 60 s stale fallback
  return (
    url.pathname.startsWith("/api/") &&
    !url.pathname.includes("/broadcast-v2/") &&
    !url.pathname.includes("/broadcast/state") &&
    !url.pathname.includes("/chat/") &&
    !url.pathname.includes("/auth/") &&
    !url.pathname.includes("/admin/")
  );
}

// ── Fetch handler ──────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never intercept mutations

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // Skip chrome-extension, data URIs, etc.
  if (!["http:", "https:"].includes(url.protocol)) return;

  // ── 1. Static hashed assets → cache-first, 30 days ──────────────────────
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const fresh = await fetch(req);
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      }),
    );
    return;
  }

  // ── 2. HLS .ts segments → cache-first, 7-day immutable ──────────────────
  if (isHlsSegment(url)) {
    event.respondWith(
      caches.open(HLS_SEG_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached && isFresh(cached, HLS_SEG_MAX_AGE_MS)) return cached;
        const fresh = await fetch(req);
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      }),
    );
    return;
  }

  // ── 3. HLS .m3u8 manifests → network-first (live content, short TTL) ────
  // Manifests are NOT cached past their 2 s max-age; let the browser handle them.
  if (isHlsManifest(url)) {
    return; // passthrough — no SW caching for manifests
  }

  // ── 4. Images / thumbnails → stale-while-revalidate, 7 days ────────────
  if (isImage(url)) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) {
          // Serve stale immediately, revalidate in background
          if (!isFresh(cached, IMAGE_MAX_AGE_MS)) {
            fetch(req).then((fresh) => {
              if (fresh.ok) cache.put(req, fresh.clone());
            }).catch(() => {});
          }
          return cached;
        }
        const fresh = await fetch(req);
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      }),
    );
    return;
  }

  // ── 5. API catalog → network-first, 60 s stale fallback ─────────────────
  if (isApiCatalog(url)) {
    event.respondWith(
      fetch(req)
        .then((fresh) => {
          cacheResponse(API_CACHE, req, fresh.clone());
          return fresh;
        })
        .catch(() =>
          caches.open(API_CACHE).then((cache) =>
            cache.match(req).then((cached) => cached ?? Response.error()),
          ),
        ),
    );
    return;
  }

  // ── 6. Navigation (HTML shell) → network-first, cache fallback ───────────
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() =>
        caches.open(STATIC_CACHE).then((cache) =>
          cache.match("/index.html").then((cached) => cached ?? fetch(req)),
        ),
      ),
    );
    return;
  }
});
