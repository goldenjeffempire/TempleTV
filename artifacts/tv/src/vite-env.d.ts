/// <reference types="vite/client" />

/**
 * Type augmentation for Vite's import.meta.env.
 * All variables declared here must start with VITE_ to be included in the
 * client bundle by Vite's static replacement. Do NOT add server-only secrets
 * here — they would be baked into the JS bundle and exposed to all clients.
 */
interface ImportMetaEnv {
  /**
   * Google Ad Manager VMAP ad tag URL for the Smart TV broadcast surface.
   * Set in .env or as the Replit secret VITE_IMA_AD_TAG_URL.
   * Leave unset to disable all ads (AdManager becomes a complete no-op).
   *
   * VMAP URL format (replace NETWORK_CODE and AD_UNIT_PATH with your values):
   *   https://pubads.g.doubleclick.net/gampad/ads
   *     ?iu=/NETWORK_CODE/AD_UNIT_PATH
   *     &sz=640x480&ciu_szs=300x250&ad_type=both&output=vmap
   *     &unviewed_position_start=1&env=vp&impl=s&correlator=
   *
   * Google sample tags for testing are available at:
   *   https://developers.google.com/interactive-media-ads/docs/sdks/html5/tags
   */
  readonly VITE_IMA_AD_TAG_URL?: string;

  /**
   * Build ID baked in at build time (see vite.config.ts → define.__BUILD_ID__).
   * Used as a localStorage cache-bust key so stale TV catalog data is evicted
   * on every deployment.
   */
  readonly VITE_BUILD_ID?: string;

  /** Base API URL (set automatically by the Replit environment). */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
