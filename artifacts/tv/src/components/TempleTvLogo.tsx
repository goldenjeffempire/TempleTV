import type { CSSProperties } from "react";

/**
 * Single source of truth for the Temple TV brand mark inside the Smart-TV
 * shell. Every TV surface that renders the logo (Home hero, splash
 * fallback, top header on guide/search/details/player, 404 / error
 * boundary) goes through this component so the asset is fetched and
 * cached exactly once per session.
 *
 * TV-specific differences from the admin variant:
 *
 *   - **Larger default size.** TV is a 10-foot UI; the smallest readable
 *     logo on a living-room screen viewed from a couch is ~64 px at
 *     1080p, so the default is 64 (admin defaults to 36).
 *
 *   - **Wordmark variant.** The Home hero shows the full transparent-
 *     background asset at a generous size (`variant="wordmark"`); other
 *     surfaces use the icon footprint (`variant="icon"`) so the brand
 *     mark slots into a header chip without dominating layout.
 *
 *   - **`fetchPriority` defaults to high.** TV cold-boots are slow
 *     (cheap WebKit, low-end CPU); the brand mark is the first thing the
 *     viewer expects to see, so prioritising the logo over secondary
 *     thumbnails is a measurable perceived-performance win.
 *
 *   - **Pointer / drag disabled.** TV remotes don't drag, but the
 *     attributes also stop a misclick on a connected mouse from kicking
 *     off a native browser drag-and-drop ghost frame.
 */

// BASE_URL-aware src so this resolves correctly in both dev (Vite serves
// at `/`) and prod (Vite mounts the TV app under `/tv/` via the
// `BASE_PATH` env var). Hardcoding `/tv/icon.png` would 404
// in dev; hardcoding `/icon.png` would 404 in prod.
const LOGO_SRC = `${import.meta.env.BASE_URL}icon.png`;
const ASPECT = 1; // icon.png is 1024×1024 — square

interface TempleTvLogoProps {
  /**
   * Rendered height in CSS pixels. For `variant="wordmark"` this drives
   * the wordmark height directly; for `variant="icon"` it bounds the
   * square icon footprint.
   */
  size?: number;
  /**
   * `"icon"` (default) renders a square-fit footprint suitable for header
   * chips and 404 cards. `"wordmark"` renders the full PNG at its natural
   * 1.5:1 aspect for the Home hero and splash screen.
   */
  variant?: "icon" | "wordmark";
  /**
   * Defaults to `true` because TV surfaces are almost always above-the-
   * fold; pass `false` for off-screen placements like a deferred dialog.
   */
  priority?: boolean;
  /**
   * Decorative placements (where adjacent text already names the brand)
   * pass `decorative` to render `alt=""`.
   */
  decorative?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function TempleTvLogo({
  size = 64,
  variant = "icon",
  priority = true,
  decorative = false,
  className,
  style,
}: TempleTvLogoProps) {
  const isWordmark = variant === "wordmark";
  const height = isWordmark ? Math.round(size * 2.2) : size;
  const width = isWordmark ? Math.round(size * 2.2 * ASPECT) : size;

  return (
    <img
      src={LOGO_SRC}
      alt={decorative ? "" : "Temple TV"}
      role={decorative ? "presentation" : undefined}
      width={width}
      height={height}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"}
      decoding="async"
      draggable={false}
      className={className}
      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
      style={{
        width,
        height,
        objectFit: "contain",
        display: "block",
        // No filter on TV — the dark TV background already gives the
        // white dove maximum contrast, and any extra `filter` cost on
        // low-end Smart-TV WebKit is real (filters force a separate
        // compositing layer).
        ...style,
      }}
    />
  );
}
