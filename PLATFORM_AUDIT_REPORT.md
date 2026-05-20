# Temple TV — Full Platform Audit Report
**Date:** May 2026 | **Auditor:** Replit Agent  
**Scope:** All 15 categories from the Enterprise Transformation Document

---

## How to Read This Report

Each item is marked:
- ✅ **Done** — Implemented and working
- ⚠️ **Partial** — Exists but incomplete or has gaps
- ❌ **Missing** — Not implemented at all
- 🔒 **Infra-only** — Requires external infrastructure (CDN contracts, GPU servers, Kubernetes cluster) — cannot be added by code alone

---

## 1. Enterprise Architecture

| Feature | Status | Notes |
|---|---|---|
| Modular domain-driven structure | ✅ | Clean separation: `modules/`, `lib/`, `artifacts/` |
| TypeScript ESM throughout | ✅ | All packages, strict mode |
| Monorepo with pnpm workspaces + Turbo | ✅ | 14 workspace packages |
| Shared library packages | ✅ | `player-core`, `broadcast-sync`, `api-spec`, `api-zod`, `api-client-react` |
| OpenAPI-first, Zod as SSOT | ✅ | Single spec drives runtime + docs |
| Event-driven internal architecture | ✅ | `adminEventBus`, SSE fan-out, WS gateways |
| Background job workers | ✅ | Transcoder, YouTube sync, scheduler, cleanup |
| Clean code / SOLID principles | ⚠️ | Generally clean; some large route files (analytics.routes.ts ~700 lines) |
| Microservices-ready split | ⚠️ | `RUN_MODE=api|worker|all` exists; full service mesh is infra-level |
| GraphQL support | ❌ | REST only |
| API gateway | ❌ | Routes are direct Fastify; no gateway layer |
| Multi-channel support | ❌ | Hardcoded `"main"` channel in V2; `channel_queue` table exists but unused |

---

## 2. Admin Dashboard UI

| Feature | Status | Notes |
|---|---|---|
| Master Control (Broadcast V2) | ✅ | A/B player, engine health, operator controls |
| Broadcast queue editor (drag-drop) | ✅ | Sortable queue with drag-and-drop |
| Live Control override system | ✅ | Instant HLS/YouTube interrupt |
| Live Monitor dashboard | ✅ | Active viewers by platform, peak, buffering |
| Stream Health dashboard | ✅ | Uptime, network status, readiness probe |
| Video library (CRUD) | ✅ | Bulk upload, metadata lock, multi-filter search |
| Transcoding queue monitor | ✅ | FFmpeg job status, progress |
| Playlists & Series management | ✅ | CRUD with video assignment |
| Chat moderation interface | ✅ | Real-time moderate, mute, ban |
| Notifications management | ✅ | Push, email, scheduled broadcasts |
| Prayer request management | ✅ | Admin review queue |
| Analytics dashboard | ✅ | Charts: views, sessions, completion rate, watch time, platform breakdown |
| User management (RBAC) | ✅ | Roles: system, admin, editor, moderator, user |
| Audit log | ✅ | Activity history across videos, users, config |
| Settings & Operations | ✅ | Global config, system maintenance |
| YouTube quota monitor | ✅ | API quota tracking |
| SSE real-time updates across tabs | ✅ | All metrics update live without refresh |
| Emergency alert system | ✅ | Global override banner |
| Channel graphics & lower thirds | ⚠️ | `/graphics` page exists; real-time control during live is limited |
| EPG grid view (schedule) | ❌ | List/card view only; no visual broadcast grid |
| Multi-bitrate quality in preview | ❌ | Master Control preview uses single source |
| SCTE-35 ad insertion controls | ❌ | No ad break management |
| DVR / clip-to-VOD tools | ❌ | Cannot clip live segments into library items |
| Revenue / donation dashboard | ❌ | Donate screen exists on mobile; no admin revenue analytics |
| Multi-admin collaboration (presence) | ❌ | No "who else is online" awareness |
| AI moderation dashboard | ❌ | Moderation is fully manual |

---

## 3. TV App (Smart TV Surface)

| Feature | Status | Notes |
|---|---|---|
| Netflix-style home (hero, rows) | ✅ | LiveHero, Continue Watching, category rows |
| On-screen search keyboard | ✅ | Real-time library filtering |
| Full-featured player (HLS/YouTube/VOD/Live) | ✅ | A/B gapless buffers, quality auto-switch |
| D-pad navigation (Tizen, webOS, Fire TV) | ✅ | Hardware key mapping, focus zones |
| Watch history + resume | ✅ | 5-second progress saves, cross-device sync |
| Video details + Up Next | ✅ | Metadata, suggestions |
| Series season/episode browser | ✅ | Full series navigation |
| Favorites (cloud-synced) | ✅ | Works logged-in and as guest |
| Auth Gate + device linking | ✅ | TV-friendly pairing code flow |
| Live chat overlay | ✅ | WebSocket, optimized for TV rendering |
| OnAir Ticker + Lower Third overlays | ✅ | SSE-synced broadcast graphics |
| Emergency Alert banner | ✅ | High-priority override |
| Live reactions (Amen/Fire/Hallelujah) | ✅ | D-pad accessible |
| Prayer request submission | ✅ | Via Info/Menu key |
| Settings / profile | ✅ | Auth status, data clearing |
| Platform init (hardware keys) | ✅ | `usePlatformInit.ts` |
| EPG grid view | ❌ | No full channel guide UI |
| Volume / audio controls on-screen | ❌ | No on-screen volume indicator or audio track selector |
| Voice search | ❌ | On-screen keyboard only |
| Picture-in-Picture (mini-player) | ❌ | Not implemented on TV |
| Offline download | ❌ | Not applicable for most TV hardware |
| Multiple user profiles | ❌ | Single account per device |

---

## 4. Mobile App

| Feature | Status | Notes |
|---|---|---|
| Tab navigation (Channels, Watch, Library, Radio, Settings) | ✅ | Expo Router tab layout |
| Unified player (HLS, YouTube, VOD, Live) | ✅ | `V2PlayerContainer`, expo-av |
| Background playback + lock screen controls | ✅ | react-native-track-player |
| Mini-player during tab navigation | ✅ | Persistent across tabs |
| Auth (login, signup, change password) | ✅ | JWT, expo-secure-store |
| Push notifications (Expo + Web Push) | ✅ | Granular preferences |
| Live chat (WebSocket) | ✅ | ChatPanel with viewer count |
| Favorites (local + cloud synced) | ✅ | AsyncStorage + API |
| Watch history + Continue Watching | ✅ | Throttled saves, 2%-97% window |
| Prayer requests | ✅ | PrayerRequestModal |
| Donate screen | ✅ | Bank transfer + payment links |
| Series detail view | ✅ | Season/episode browsing |
| Dark/light/system theme | ✅ | ThemeContext |
| Offline metadata caching | ✅ | 30-min TTL catalog cache |
| Network status monitoring | ✅ | useNetworkStatus |
| Radio (live audio stream) | ✅ | 24/7 with visualizer |
| Offline video downloads | ❌ | Not implemented |
| Search suggestions / autocomplete | ❌ | Debounced search only |
| Manual quality selector | ❌ | No ABR quality UI |
| Multi-language (i18n) | ❌ | Hardcoded English |
| Social sharing with timestamps | ❌ | Basic Share.share only |
| Multiple user profiles | ❌ | Single account |

---

## 5. Streaming Infrastructure

| Feature | Status | Notes |
|---|---|---|
| HLS adaptive multi-bitrate (360p–1080p) | ✅ | FFmpeg renditions based on source probe |
| FFprobe source resolution probe | ✅ | Prevents upscaling |
| FFmpeg thumbnail extraction | ✅ | 640px at t=1s |
| HLS concurrency limiting | ✅ | `HLS_MAX_CONCURRENT` (default 200) |
| Range request support | ✅ | Required for Safari + seeking |
| Stream failover (primary → failover → skip) | ✅ | 3-retry primary, 2-retry failover |
| Auto-skip stuck items | ✅ | After 5 unresolvable attempts |
| Stream health monitoring | ✅ | Client telemetry + server-side manifest probing |
| P95 startup time / stall rate tracking | ✅ | 5-min sliding window aggregator |
| Signed HLS URLs (HMAC) | ✅ | Opt-in via `REQUIRE_HLS_TOKEN` |
| SSRF protection on media proxy | ✅ | Host allowlist |
| Multi-CDN support | ✅ | CloudFront, BunnyCDN, Cloudflare allowlisted |
| HLS manifest CDN URL rewriting | ✅ | `CDN_BASE_URL` env var |
| RTMP/SRT/HLS/WHIP ingest metadata | ✅ | Metadata management (not native ingest) |
| DASH playback | ⚠️ | Source kind classified; no DASH player (shaka/dash.js) wired up |
| Low-latency HLS (LL-HLS) | ❌ | Standard HLS only; no LL-HLS segments |
| DVR / timeshift for live streams | ❌ | Live mode is strictly "now-only" |
| Native RTMP-to-HLS ingest | ❌ | Relies on external CDN (Mux, Cloudflare Stream, etc.) |
| WebRTC playback | ❌ | WHIP in ingest metadata only |
| Chromecast support | ❌ | Not implemented |
| AirPlay support | ❌ | Not implemented |
| SCTE-35 markers / SSAI | ❌ | No ad insertion infrastructure |
| DRM (Widevine / FairPlay / PlayReady) | ❌ | Security via signed proxy only |

---

## 6. Security

| Feature | Status | Notes |
|---|---|---|
| CSRF protection (dual-layer) | ✅ | SameSite=Strict + X-Admin-CSRF header |
| Rate limiting (global + per-route) | ✅ | 120/min global, 20/min auth, 400/min media |
| JWT with jose (access + refresh) | ✅ | HS256, RS256 schema ready |
| Refresh tokens hashed (SHA-256) | ✅ | Never stored raw |
| Refresh token revocation | ✅ | On logout and password change (all tokens) |
| IP mismatch detection | ✅ | Soft-warn; hard-reject via `REFRESH_TOKEN_STRICT_IP_CHECK` |
| ADMIN_API_TOKEN IP allowlist | ✅ | Per-IP restriction |
| Signed media proxy URLs (HMAC) | ✅ | Short-lived HMAC tokens |
| Bcrypt password hashing (12 rounds) | ✅ | NIST-compliant |
| Helmet (CSP, HSTS, X-Frame-Options) | ✅ | All security headers |
| SSRF protection | ✅ | Strict host allowlist on media proxy |
| Anti-enumeration (forgot password) | ✅ | Always returns success |
| SQL injection prevention | ✅ | Drizzle ORM parameterized queries |
| XSS protection | ✅ | CSP via Helmet |
| Security audit log | ✅ | Admin action history |
| MFA / 2FA (TOTP or WebAuthn) | ❌ | Not implemented |
| DRM | ❌ | Not implemented |
| WAF integration | 🔒 | Infra-level (Cloudflare, AWS WAF) |
| Bot protection (beyond rate limiting) | ❌ | No CAPTCHA, Turnstile, or fingerprinting |
| Intrusion detection | ❌ | No automated alerting on suspicious patterns |
| Device session management UI | ❌ | No "active sessions" view for users |

---

## 7. Performance

| Feature | Status | Notes |
|---|---|---|
| Redis caching with LRU fallback | ✅ | Hybrid cache in `infrastructure/cache.ts` |
| Brotli + Gzip compression | ✅ | `@fastify/compress`, excludes HLS segments |
| Code splitting (Vite manualChunks) | ✅ | `player-vendor`, `ui-vendor` chunks in TV; auto in admin |
| React.lazy() route splitting | ✅ | All non-critical routes |
| Image lazy loading | ✅ | `loading="lazy"` throughout |
| TV manifest prefetch on card focus | ✅ | `manifest-prefetch.ts` |
| Preconnect / DNS-prefetch | ✅ | API origin in all index.html files |
| Cache-Control on API responses | ✅ | 5s guide, 3s viewers, 15s channels |
| localStorage catalog cache | ✅ | 30-min TTL, build-ID-aware |
| Admin staleTime / gcTime tuning | ✅ | 60s stale, 10min gc, placeholderData |
| Adaptive HLS (FFprobe-probed) | ✅ | Renditions matched to source resolution |
| Background chunk prefetch (admin) | ✅ | 2s/5s/10s via requestIdleCallback |
| PWA manifest (TV + Mobile) | ✅ | Standalone/fullscreen modes |
| Service worker (push notifications) | ✅ | `sw-temple-push.js` |
| Full offline service worker (assets) | ❌ | Push SW only; no cache-first asset SW |
| WebP / AVIF image format optimization | ❌ | JPG/PNG only; no modern format pipeline |
| HTTP/3 | 🔒 | Delegated to infra/CDN |

---

## 8. SEO & Discoverability

| Feature | Status | Notes |
|---|---|---|
| Baseline OG tags + Twitter Cards | ✅ | Comprehensive in `+html.tsx` |
| JSON-LD @graph (Organization, WebSite, BroadcastService) | ✅ | Injected in shell HTML |
| MobileApplication schema | ✅ | iOS, Android, Web |
| WebSite SearchAction schema | ✅ | Points to `/library?q=` |
| usePageSeo hook (per-route dynamic SEO) | ✅ | Title, description, canonical, OG, structured data |
| Canonical URL management | ✅ | Per-route via usePageSeo |
| robots.txt (all surfaces) | ✅ | Admin, mobile, TV |
| Sitemap index + static pages sitemap | ✅ | `sitemap.xml` → `sitemap-pages.xml` |
| Dynamic sitemap for sermons | ❌ | `/sitemap-sermons.xml` API endpoint missing |
| VideoObject schema on video pages | ❌ | Falls back to generic OG tags |
| PodcastSeries / PodcastEpisode schema | ❌ | No schema on radio/audio pages |
| BroadcastEvent dynamic schema | ❌ | Static BroadcastService only |
| usePageSeo wired on series/[slug].tsx | ❌ | Uses global fallback SEO |
| usePageSeo wired on player.tsx | ❌ | Uses global fallback SEO |
| Podcast SEO optimization | ❌ | No podcast feed (RSS) |
| AI-powered SEO engine | ❌ | No AI SEO tooling |

---

## 9. Analytics & Observability

| Feature | Status | Notes |
|---|---|---|
| Viewer sessions (device, platform, geography) | ✅ | `viewer_sessions` table with country/city |
| Watch time tracking | ✅ | `watched_secs`, heartbeat every 5s |
| Completion rate tracking | ✅ | ≥90% = completed |
| View count increment on session start | ✅ | Auto-increments `view_count` |
| Admin analytics dashboard | ✅ | Views, sessions, completion, avg watch time, charts |
| Date range filtering + CSV export | ✅ | 7d/30d/90d |
| Top videos by view count | ✅ | With thumbnails |
| Platform breakdown chart | ✅ | TV / Mobile / Web pie chart |
| Daily view trend chart | ✅ | Area chart |
| Live monitor (active viewers) | ✅ | Real-time per-platform viewer counts |
| Operations monitoring (CPU, memory, disk, RPM) | ✅ | `/operations` page |
| Stream health dashboard | ✅ | Stall rate, P95 startup, bitrate |
| Sentry error tracking (server) | ✅ | `instrument.ts`, 5% trace sample rate |
| Client error bridge (mobile/TV → API → Sentry) | ✅ | `telemetry.routes.ts`, ErrorBoundary |
| Memory watchdog + SSE ops-alerts | ✅ | RSS threshold alerts to admin |
| Pino structured logging with PII redaction | ✅ | Auth headers, cookies, passwords redacted |
| Geographic analytics visualization | ❌ | Fields exist in DB; no map or geo chart in UI |
| Revenue / donation analytics | ❌ | Not tracked |
| AI predictive analytics | ❌ | Raw aggregates only |
| Distributed tracing (Jaeger / Zipkin) | ❌ | Sentry only |
| QoS aggregation tables (CDN audit) | ❌ | In-memory only; not persisted |

---

## 10. Database Schema

| Feature | Status | Notes |
|---|---|---|
| managed_videos (15+ indexes) | ✅ | GIN FTS, composite, partial indexes |
| Broadcast runtime state (event-sourced) | ✅ | `broadcast_event_log`, `broadcast_runtime_state`, `player_position_checkpoint` |
| Storage blobs (PostgreSQL BYTEA) | ✅ | Replaces S3 for small/dev environments |
| Viewer sessions with geography | ✅ | `country`, `city` fields |
| Chat + moderation (IP-hashed) | ✅ | Privacy-preserving |
| Multi-channel push (Expo + Web Push) | ✅ | `push_tokens`, `web_push_subscriptions` |
| RBAC users + tokens + password reset | ✅ | Secure, full lifecycle |
| Series + playlists + schedule | ✅ | Content organization |
| App config (key-value store) | ✅ | Runtime feature flags |
| Live ingest endpoints with health metrics | ✅ | Bitrate, dropped frames, failures |
| Emergency alerts | ✅ | Global override table |
| EPG segments table | ❌ | Guide calculated on-the-fly |
| SCTE-35 metadata fields | ❌ | No ad insertion schema |
| Multi-language audio track schema | ❌ | Single HLS master assumed |
| Subtitle / VTT sidecar schema | ❌ | No subtitle storage |
| Rights / licensing / geoblocking schema | ❌ | No air-window or region rules |
| QoS aggregation (rebuffering by region) | ❌ | Not persisted |

---

## 11. DevOps & Infrastructure

| Feature | Status | Notes |
|---|---|---|
| Multi-stage Dockerfile (Alpine, non-root) | ✅ | `pnpm deploy` prune; lean image |
| docker-compose.prod.yml (resource limits, health checks) | ✅ | 2GB API, rolling zero-downtime |
| render.yaml deployment config | ✅ | API + Admin services |
| GitHub Actions CI (typecheck, build, verify) | ✅ | `ci.yml` |
| GitHub Actions release pipeline | ✅ | `release.yml`, `mobile-release.yml`, `tv-release.yml` |
| OTA updates (EAS) | ✅ | `ota-update.yml` on main push |
| Store submission automation | ✅ | `store-deploy.yml` |
| Docker image publish to GHCR | ✅ | `docker-publish.yml` |
| Fastlane (iOS + Android) | ✅ | Full lanes |
| TurboRepo parallel builds + caching | ✅ | `turbo.json` |
| Health endpoints (/healthz, /readyz, /health/live) | ✅ | Liveness, readiness, stream telemetry |
| Graceful shutdown (SIGTERM drain) | ✅ | Two-phase drain |
| Memory watchdog + self-restart | ✅ | RSS caps, V8 heap limits |
| Secret management scripts | ✅ | `github-secrets-setup.sh` |
| Cold-start mitigation (keep-alive) | ✅ | `startKeepAlive()` for free-tier |
| Samsung/LG/FireTV packaging scripts | ✅ | `.wgt`, `.ipk`, `.apk` |
| Kubernetes orchestration | ❌ | Docker Compose only |
| Blue-green / canary deployments | ❌ | Rolling only |
| Automated DB backup scripts (in-repo) | ❌ | Delegated to managed provider |
| Distributed tracing | ❌ | Sentry breadcrumbs only |
| Multi-region deployment | 🔒 | Infra-level |
| Auto-scaling (horizontal) | ⚠️ | Redis-enabled for SSE fan-out; `numInstances: 1` in render.yaml |

---

## 12. AI / ML Features

| Feature | Status | Notes |
|---|---|---|
| Content recommendations | ⚠️ | Top-by-viewCount queries; no ML model |
| Auto-categorization | ⚠️ | Keyword matching against title/description |
| Search | ⚠️ | PostgreSQL tsvector FTS; no semantic/vector search |
| Auto-thumbnail generation | ⚠️ | FFmpeg frame at t=1s; not AI-generated |
| Chat moderation | ⚠️ | Manual only; rate-limit anti-spam |
| Transcript / subtitle generation | ❌ | Not implemented (no Whisper or equivalent) |
| Semantic / vector search | ❌ | Not implemented |
| AI sermon recommendations | ❌ | Not implemented |
| AI content tagging | ❌ | Keyword rules only |
| AI voice enhancement | ❌ | Not implemented |
| AI duplicate content detection | ❌ | Not implemented |
| AI chatbot assistant | ❌ | Not implemented |
| AI audience retention prediction | ❌ | Not implemented |
| AI-based SEO optimization | ❌ | Not implemented |
| AI adaptive streaming optimization | ❌ | Rule-based only |
| GPU acceleration support | 🔒 | Requires GPU infrastructure |

> **Note on AI features:** All "local AI" features in the document (self-hosted LLMs, Whisper, vector search, recommendation models) require either a dedicated GPU server or a managed ML service (e.g., OpenAI Whisper API, Replicate, Hugging Face Inference). None can be self-hosted on Replit's current environment. The most practical path is using Whisper API for transcripts, pgvector for semantic search, and a simple ML recommender.

---

## 13. User Engagement Features

| Feature | Status | Notes |
|---|---|---|
| Favorites / Watch Later | ✅ | Mobile + TV, local + cloud |
| Watch history + Resume Watching | ✅ | Full implementation, cross-device |
| Continue Watching row | ✅ | Home screen on TV + mobile |
| Live chat | ✅ | WebSocket, admin moderation |
| Prayer requests | ✅ | Mobile submit, admin review |
| Push notifications (multi-channel) | ✅ | Expo, Web Push, Email |
| Granular notification preferences | ✅ | Live alerts, sermons, emergency |
| Donate screen | ✅ | Mobile app |
| Radio (live audio) | ✅ | Mobile, 24/7 stream |
| User-created playlists | ❌ | Admin-defined only |
| VOD comments / community discussion | ❌ | Only live chat |
| Social sharing with deep links + timestamps | ❌ | Basic Share.share |
| Multi-language / i18n framework | ❌ | Hardcoded English |
| Offline video downloads | ❌ | Metadata caching only |
| Multiple user profiles | ❌ | Single account per device |
| Watch Party / synchronized viewing | ❌ | Not implemented |
| Interactive polls during live | ❌ | Not implemented |

---

## Summary by Priority

### 🔴 High-Impact Gaps (Real user / operational pain)
1. **Dynamic sitemap for sermons** — Missing API endpoint; sermons aren't being indexed by Google
2. **VideoObject + BroadcastEvent schema** — Missing structured data on video/live pages hurts rich snippets
3. **usePageSeo on series/[slug] and player pages** — All video detail pages show generic title/description in Google
4. **MFA / 2FA** — Admin accounts protected only by password; no second factor
5. **TOTP for admin users** — Standard for any broadcasting operations platform
6. **EPG grid view in admin** — Hard to manage a 24/7 schedule without a visual grid
7. **Geographic analytics visualization** — Data is tracked but never surfaced in a map or geo breakdown chart
8. **User-created playlists** — High engagement feature; infrastructure exists, just no user-facing UI
9. **DASH player support** — DASH sources can be queued but nothing plays them on TV/mobile
10. **Multi-channel V2 support** — DB schema exists; hardcoded to `"main"` everywhere in orchestrator

### 🟡 Medium-Impact Gaps (Would meaningfully improve the platform)
11. **Transcript / subtitle generation** — Most impactful AI feature; improves SEO + accessibility
12. **Podcast RSS feed** — Sermons are sermon content; a podcast feed is zero extra work for massive reach
13. **DVR / timeshift** — Common expectation in 2026 for broadcast platforms
14. **Device session management UI** — Users should see and revoke their active sessions
15. **VOD comments / community** — The only engagement missing from live-to-VOD lifecycle
16. **Offline video downloads (mobile)** — High demand in areas with poor connectivity
17. **Chromecast / AirPlay** — Major user expectation on mobile
18. **Full offline service worker** — PWA manifests exist but no cache-first asset SW
19. **WebP/AVIF image pipeline** — Easy win for performance
20. **Manual quality selector (mobile)** — Important for users on metered data

### 🟢 Lower Priority / Infra-Only
21. **Kubernetes / auto-scaling** — Render scaling handles this
22. **DRM** — Only needed when content is licensed/premium
23. **SCTE-35 / SSAI** — Only needed if running ads
24. **Self-hosted AI models** — Requires GPU infra; use API-based alternatives
25. **Multi-region deployment** — Platform-level infrastructure concern

---

## What to Build First (Recommended Sequence)

| # | Item | Effort | Impact |
|---|---|---|---|
| 1 | Dynamic sermon sitemap API endpoint | 1–2 hrs | 🔴 High (SEO) |
| 2 | VideoObject + BroadcastEvent JSON-LD | 1–2 hrs | 🔴 High (SEO) |
| 3 | Wire usePageSeo on video/series detail pages | 2–3 hrs | 🔴 High (SEO) |
| 4 | TOTP-based MFA for admin accounts | 4–6 hrs | 🔴 High (Security) |
| 5 | EPG grid view in admin scheduler | 6–8 hrs | 🟡 Medium (Operations) |
| 6 | Geographic analytics map dashboard | 4–6 hrs | 🟡 Medium (Analytics) |
| 7 | Transcript/subtitle via Whisper API | 6–8 hrs | 🟡 Medium (AI + SEO + Accessibility) |
| 8 | Podcast RSS feed endpoint | 3–4 hrs | 🟡 Medium (Reach) |
| 9 | Chromecast + AirPlay (mobile) | 6–10 hrs | 🟡 Medium (UX) |
| 10 | User-created playlists (mobile + API) | 4–6 hrs | 🟡 Medium (Engagement) |
| 11 | Device session management UI | 3–4 hrs | 🟡 Medium (Security UX) |
| 12 | Full offline service worker (PWA) | 4–6 hrs | 🟡 Medium (Performance) |
| 13 | WebP/AVIF image pipeline | 2–3 hrs | 🟢 Low (Performance) |
| 14 | VOD comments system | 8–12 hrs | 🟢 Low (Engagement) |
| 15 | Multi-channel V2 unlock | 8–12 hrs | 🟢 Low (Architecture) |

---

*Report generated from parallel audit of 12 codebase dimensions — admin UI, TV app, mobile app, streaming infrastructure, security, AI/ML, database schema, performance, SEO, analytics, DevOps, and user engagement.*
