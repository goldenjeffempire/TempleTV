/**
 * usePageSeo — per-route SEO injection for the web build of the Expo app.
 *
 * Why this hook exists:
 *   The root `+html.tsx` only renders ONCE for the SPA shell, so every page
 *   would otherwise share the same <title>, description, canonical URL, and
 *   structured-data block. That hurts ranking — Google needs distinct titles,
 *   descriptions, and canonical URLs per page to index sub-routes.
 *
 *   Googlebot fully renders client-side React, so updates we make here in a
 *   useEffect are picked up during indexing. Social/AI crawlers that DON'T
 *   render JS still see the root +html.tsx fallback meta tags, which is fine.
 *
 * What it does on web only:
 *   - Updates document.title
 *   - Updates / inserts <meta name="description">
 *   - Updates / inserts <link rel="canonical">
 *   - Updates / inserts og:title, og:description, og:url
 *   - Updates / inserts twitter:title, twitter:description
 *   - Optionally injects a structured-data <script type="application/ld+json">
 *     scoped to this page (auto-cleaned on unmount).
 *
 * Native (iOS/Android) is a no-op — there is no DOM to mutate.
 */

import { useEffect } from "react";
import { Platform } from "react-native";

const SITE_URL = "https://templetv.org.ng";

export interface PageSeoOptions {
  title: string;
  description: string;
  /** Path component, e.g. "/library". Combined with SITE_URL for canonical/og:url. */
  path: string;
  /** Absolute URL of the OG image; defaults to the global Temple TV card. */
  image?: string;
  /** noindex hint (e.g. for /login, /signup, /change-password). */
  noindex?: boolean;
  /** Optional JSON-LD object or array; will be injected as a scoped script tag. */
  structuredData?: Record<string, unknown> | Record<string, unknown>[];
}

const SCOPED_LDJSON_ID = "page-ldjson";

function setMeta(selector: string, attr: "name" | "property", attrValue: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, attrValue);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setLink(rel: string, href: string) {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

export function usePageSeo(opts: PageSeoOptions): void {
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;

    const url = `${SITE_URL}${opts.path.startsWith("/") ? opts.path : "/" + opts.path}`;
    const image = opts.image ?? `${SITE_URL}/og-image.png`;
    const robots = opts.noindex
      ? "noindex, nofollow, noarchive, nosnippet"
      : "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1";

    const prevTitle = document.title;
    document.title = opts.title;

    setMeta('meta[name="description"]', "name", "description", opts.description);
    setMeta('meta[name="robots"]', "name", "robots", robots);
    setMeta('meta[name="googlebot"]', "name", "googlebot", robots);
    setLink("canonical", url);

    setMeta('meta[property="og:title"]', "property", "og:title", opts.title);
    setMeta('meta[property="og:description"]', "property", "og:description", opts.description);
    setMeta('meta[property="og:url"]', "property", "og:url", url);
    setMeta('meta[property="og:image"]', "property", "og:image", image);

    setMeta('meta[name="twitter:title"]', "name", "twitter:title", opts.title);
    setMeta('meta[name="twitter:description"]', "name", "twitter:description", opts.description);
    setMeta('meta[name="twitter:image"]', "name", "twitter:image", image);

    let scriptEl: HTMLScriptElement | null = null;
    if (opts.structuredData) {
      scriptEl = document.createElement("script");
      scriptEl.type = "application/ld+json";
      scriptEl.id = SCOPED_LDJSON_ID;
      scriptEl.text = JSON.stringify(opts.structuredData);
      // Remove any prior scoped block first
      const prev = document.getElementById(SCOPED_LDJSON_ID);
      if (prev) prev.remove();
      document.head.appendChild(scriptEl);
    }

    return () => {
      // Best-effort restoration so back-navigation gets sensible defaults.
      // The next page's own usePageSeo() call will overwrite these immediately.
      document.title = prevTitle;
      if (scriptEl && scriptEl.parentNode) scriptEl.parentNode.removeChild(scriptEl);
    };
  }, [
    opts.title,
    opts.description,
    opts.path,
    opts.image,
    opts.noindex,
    // Stringify structured data so reference identity changes don't refire.
    opts.structuredData ? JSON.stringify(opts.structuredData) : null,
  ]);
}
