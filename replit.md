# Temple TV (JCTM) Broadcasting Platform

## Overview

Temple TV (JCTM) is an enterprise-grade broadcasting platform offering a comprehensive media experience. It includes a cross-platform mobile app, a Smart TV web app, an admin dashboard, and a Node.js/Express API backend. Key capabilities include Live TV, Video-on-Demand (VOD) sermon library, 24/7 Radio mode, push notifications, offline video downloads, adaptive streaming, subscription management, user authentication, and a unified real-time broadcast synchronization system across all platforms. The platform aims to deliver a seamless and engaging content consumption experience.

## User Preferences

- The user wants the agent to focus on delivering high-quality, production-ready code.
- The user expects the agent to adhere to the existing monorepo structure and technology stack.
- The user prefers that the agent prioritize features that enhance user experience and operational efficiency.
- The user wants the agent to ensure new features are integrated seamlessly with the real-time broadcast synchronization system.
- The user expects the agent to perform comprehensive testing and address any TypeScript errors or deprecated patterns.
- The user requires the agent to consider security, performance, and scalability in all implemented features.
- The user wants the agent to ensure all changes respect the existing design system, including light-first auto theming and glassmorphism UI elements.

## System Architecture

The platform is built as a monorepo using `pnpm workspaces`, Node.js 24, and TypeScript 5.9.

**Core Architectural Decisions:**
- **Unified Live Broadcast Sync:** A single live input (YouTube Live, HLS URL, or RTMP) feeds all platforms simultaneously via Server-Sent Events (SSE) for real-time state changes (`GET /api/broadcast/events`). An Admin Live Control panel facilitates instant broadcasting.
- **Micro-frontend Approach:** Separation of concerns with distinct artifacts for mobile (`artifacts/mobile`), Smart TV (`artifacts/tv`), and admin (`artifacts/admin`).
- **Data Persistence:** PostgreSQL with Drizzle ORM for database management.
- **API Framework:** Express 5 for the backend API.
- **Validation:** Zod for schema validation.
- **Monorepo Management:** `pnpm` for package management and workspace organization.
- **Cross-Platform Mobile:** Expo (React Native) with `expo-router` for mobile development.
- **Admin Dashboard:** React/Vite for the administrative interface.
- **Adaptive Streaming:** HLS transcoding (FFmpeg) with adaptive bitrate (ABR) streaming for uploaded videos, served via Replit Object Storage (GCS).
- **Caching:** Dual-layer Redis/in-memory caching for API responses and YouTube data, with transparent fallback.
- **Authentication:** JWT-based user authentication with refresh tokens, account management, and server-side storage for favorites and watch history.
- **Notifications:** Expo Push API for scheduled and instant push notifications.
- **UI/UX:**
    - **Theme:** Light-first auto theme with an automatic midnight theme activated from 8:00 PM to 5:59 AM based on the device/browser local time zone.
    - **Design System:** Glassmorphism-style UI with theme-aware glass backgrounds.
    - **Smart TV UI:** 10-foot UI design with large fonts, prominent focus rings, and D-pad/remote navigation.
- **Key Features:**
    - **Video Playback:** In-app YouTube video player (`react-native-youtube-iframe`) with seek bar on all platforms, continuous streaming engine, and automatic advancement.
    - **Content Organization:** Categorization of sermons (Faith, Healing, Deliverance, Worship, Teachings, Special Programs) with search, filtering, and sorting capabilities.
    - **Radio Mode:** Audio-only mode with background playback, sleep timer, and video-to-audio toggle. Powered by a persistent root-level audio engine (`PersistentAudioPlayer`) mounted in `_layout.tsx` — a hidden, offscreen YouTube iframe that owns playback whenever a sermon is selected, surviving tab navigation. The visible `/player` route takes ownership when active to prevent double-playback. Player refs use a compare-and-swap ownership pattern so racing mount/unmount transitions never null out the active controls.
    - **Offline Capabilities:** Offline video downloads using `expo-file-system` and offline metadata caching.
    - **Admin Control:** Dedicated admin panels for Live Control, subscription management, user management, video transcoding queue, scheduled notifications, and platform operations/health monitoring.
    - **TV Guide:** Real-time TV Guide for Smart TV app with live program highlighting and reminder system.
    - **Security & Observability:** API security middleware, admin API protection with `ADMIN_API_TOKEN`, production metrics (Prometheus-compatible), and structured logging.
    - **Enterprise SEO:** Per-route `<title>`, description, canonical, OG, and Twitter cards on every mobile web page via the `usePageSeo` hook (`artifacts/mobile/hooks/usePageSeo.ts`). Root `+html.tsx` ships a Schema.org `@graph` (Organization + WebSite with sitelinks SearchAction + BroadcastService + MobileApplication). Player route emits dynamic `VideoObject` / `BroadcastEvent` JSON-LD per sermon for Google Video carousel eligibility. Sitemap architecture is a sitemap-index at `templetv.org.ng/sitemap.xml` that fans out to a static `sitemap-pages.xml` (mobile `public/`) and a **dynamic** `sitemap-sermons.xml` served by the API server (`artifacts/api-server/src/routes/sitemap.ts`) with full Google Video Sitemap extensions. TV web has its own complete head + manifest + robots; admin is hard-blocked from indexing (`noindex,nofollow,noarchive,nosnippet` + full-disallow `robots.txt`).
    - **Containerization:** Docker support with `docker-compose` for orchestration of API, Admin, PostgreSQL, and Redis services.

## External Dependencies

- **Database:** PostgreSQL
- **ORM:** Drizzle ORM
- **Cloud Storage:** Google Cloud Storage (Replit Object Storage)
- **Push Notifications:** Expo Push API
- **Live Streaming/Video Platform:** YouTube Live
- **Payment Gateways (Donations):** Paystack, Flutterwave
- **In-App Video Player:** `react-native-youtube-iframe`
- **Audio/Video Playback:** `expo-av`
- **File System (Mobile):** `expo-file-system`
- **Caching:** Redis
- **Containerization:** Docker, Nginx
- **API Specification:** OpenAPI
- **Frontend Frameworks:** React, Vite
- **Mobile Framework:** Expo (React Native)
- **Backend Framework:** Express
- **Video Processing:** FFmpeg (for HLS transcoding)