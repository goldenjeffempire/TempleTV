# Temple TV — Changelog

All notable changes to Temple TV are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## v1.0.0 — 2026-05-07

### Added
- Multi-surface streaming platform: Web, Smart TV (Samsung Tizen + LG webOS), Admin Dashboard, Mobile (iOS + Android + Apple TV + Android TV + Fire TV)
- Live broadcasting with real-time SSE chat, emoji reactions, and viewer count
- HLS video streaming with adaptive bitrate and optional CloudFront CDN delivery
- Admin dashboard (React + Vite + shadcn/ui) with full content, broadcast, and user management
- Scheduled and emergency push notifications via Web Push (VAPID), Expo, and SMTP email
- Multi-file bulk upload engine: drag-and-drop, per-file pause/resume/cancel/retry, floating queue panel
- Multi-channel broadcasting infrastructure with real-time sync
- RBAC with roles: system, admin, editor, moderator, user
- YouTube sync with metadata lock support (`metadataLocked` flag)
- Fastify v5 API with OpenAPI 3.1 spec, Zod validators, SSE + WebSocket real-time gateway
- PostgreSQL (primary DB) + Redis (optional caching, fallback to pg)
- Docker multi-stage builds for API, Admin, TV surfaces
- Full CI/CD pipeline: GitHub Actions (CI + release + mobile + TV + OTA + Docker + store deploy)
- Expo EAS builds for all platforms (development, preview, staging, production, androidtv, appletv, firetv)
- Fastlane automation: iOS (Match certs, TestFlight, App Store) + Android (Play Store, Firebase Distribution)
- Samsung Tizen .wgt + LG webOS .ipk packaging
- TurboRepo monorepo with parallel builds and GitHub Actions cache
- Drizzle ORM schema with full migration history
- Sentry error tracking with source map upload for all surfaces
- render.yaml with 4 services (API, Admin, Web, TV) on free tier
- git pre-commit hook (verify gate on TS/spec changes)
- Post-deploy smoke test, secrets vault verification, rollback scripts
- Single `pnpm run release:production` command for zero-manual-step releases
