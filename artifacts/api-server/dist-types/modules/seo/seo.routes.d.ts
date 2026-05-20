/**
 * SEO surfaces:
 *
 *   GET /sitemap-sermons.xml
 *     XML sitemap (Video extension) for all public sermons.
 *     Referenced by https://templetv.org.ng/sitemap.xml → crawled by Google.
 *     Cached 1 hour server-side. HTTP Cache-Control: 1 hour.
 *
 *   GET /podcast.xml
 *     RSS 2.0 feed with iTunes/Spotify extensions for all uploadedsermons.
 *     Submit this URL to Apple Podcasts, Spotify for Podcasters, Google Podcasts.
 *     Cached 15 min.
 *
 * Both endpoints are public (no auth) and rate-limited at 30 req/min.
 */
import type { FastifyInstance } from "fastify";
export declare function seoRoutes(app: FastifyInstance): Promise<void>;
