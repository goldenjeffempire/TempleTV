import type { CSSProperties } from "react";

/**
 * Single source of truth for the Temple TV brand mark inside the admin app.
 *
 * Every admin surface that renders the logo (sidebar header, auth-gate
 * panel, login/empty/error screens, future modals) goes through this
 * component — no inline `<img src="/admin/temple-tv-logo.png" />` calls
 * are allowed. That guarantees:
 *
 *   - **Single asset, single cache entry.** The browser fetches and caches
 *     the PNG exactly once per session, regardless of how many surfaces
 *     reference it. With the file-server emitting strong ETag + far-future
 *     Cache-Control on `/admin/temple-tv-logo.png`, repeat visits are a
 *     304 round-trip (or instant from disk cache).
 *
 *   - **Zero CLS.** Explicit `width`/`height` HTML attributes (computed
 *     from the source asset's natural 900×600 = 1.5 aspect ratio) reserve
 *     the layout box before the bitmap arrives. Without these, the sidebar
 *     header would jump on every cold load.
 *
 *   - **Above-the-fold prioritisation.** `priority` callers (sidebar
 *     header, auth-gate hero) get `loading="eager"` + `fetchPriority="high"`
 *     so the brand mark paints with the first frame — admins judge the
 *     "feels-fast-or-slow" verdict from the first 200 ms. Non-priority
 *     callers (modals, footers, error states) get `loading="lazy"` so they
 *     don't compete for bandwidth with whatever data the page is fetching.
 *
 *   - **Async decode.** `decoding="async"` lets the browser decode the
 *     bitmap off the main thread; on slower admin laptops this prevents
 *     the logo's decode from blocking the sidebar's initial paint.
 *
 *   - **Accessible alt text.** A meaningful "Temple TV admin" alt (not
 *     just "logo") gives screen-reader users surface context. Decorative
 *     placements can pass `decorative` to render `alt=""` instead.
 *
 *   - **Theme-friendly rendering.** The asset is a transparent PNG whose
 *     red wordmark and blue `.tv` badge read on both light and dark
 *     backgrounds; the `drop-shadow` filter (subtle, ≈1 px) gives the
 *     white dove a faint edge against the light admin theme so it
 *     doesn't visually disappear into the sidebar background.
 */

// BASE_URL-aware src so this resolves correctly in both dev (Vite serves
// at `/`) and prod (Vite mounts the admin app under `/admin/` via the
// `BASE_PATH` env var). Hardcoding `/admin/temple-tv-logo.png` would 404
// in dev; hardcoding `/temple-tv-logo.png` would 404 in prod.
const LOGO_SRC = `${import.meta.env.BASE_URL}temple-tv-logo.png`;
const NATURAL_WIDTH = 900;
const NATURAL_HEIGHT = 600;
const ASPECT = NATURAL_WIDTH / NATURAL_HEIGHT; // 1.5

interface TempleTvLogoProps {
  /**
   * Rendered height in CSS pixels. Width is derived from the natural
   * aspect ratio so the layout box is reserved before the bitmap arrives.
   */
  size?: number;
  /**
   * Eager-fetch + high priority. Use on above-the-fold surfaces (sidebar
   * header, auth-gate hero). Defaults to `false`, which yields lazy
   * loading suitable for modals, footers, and error states.
   */
  priority?: boolean;
  /**
   * Decorative placements (where adjacent text already names the brand)
   * pass `decorative` to render `alt=""`. Screen readers will skip the
   * image instead of double-announcing the brand name.
   */
  decorative?: boolean;
  /**
   * Optional className/style passthrough for one-off positioning needs.
   * Avoid using these to override `width`/`height` — that re-introduces
   * CLS and defeats the natural-aspect-ratio guarantee.
   */
  className?: string;
  style?: CSSProperties;
}

export function TempleTvLogo({
  size = 36,
  priority = false,
  decorative = false,
  className,
  style,
}: TempleTvLogoProps) {
  const height = size;
  const width = Math.round(size * ASPECT);

  return (
    <img
      src={LOGO_SRC}
      alt={decorative ? "" : "Temple TV admin"}
      role={decorative ? "presentation" : undefined}
      width={width}
      height={height}
      loading={priority ? "eager" : "lazy"}
      // `fetchPriority` is the React 19 / DOM standard attribute name; the
      // lowercase `fetchpriority` HTML attribute is what gets emitted.
      fetchPriority={priority ? "high" : "auto"}
      decoding="async"
      draggable={false}
      className={className}
      style={{
        width,
        height,
        objectFit: "contain",
        display: "block",
        // Subtle drop-shadow gives the white dove a visible edge against
        // the admin's light sidebar background. Vanishes visually on dark
        // backgrounds where the dove is already high-contrast.
        filter: "drop-shadow(0 1px 1px rgba(0, 0, 0, 0.12))",
        ...style,
      }}
    />
  );
}
