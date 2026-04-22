# Temple TV — Production Release Audit

**Date:** 2026-04-22
**Scope:** API server, Admin web, Mobile (Expo iOS/Android/web), Smart TV web
**Audit type:** Production-readiness pass

---

## 1. Executive summary

Temple TV is a four-artifact monorepo backing the JCTM Broadcasting ministry:

| Artifact | Tech | Production target |
|---|---|---|
| `artifacts/api-server` | Express + Drizzle (Neon Postgres) | `https://api.templetv.org.ng` (Render) |
| `artifacts/admin` | React + Vite + wouter | `https://admin.templetv.org.ng` (Render) |
| `artifacts/tv` | React + Vite (D-pad / 10-foot UI) | `https://tv.templetv.org.ng` (Render) |
| `artifacts/mobile` | Expo React Native (iOS, Android, web) | EAS build → App Store / Play Store; web → `https://templetv.org.ng` (Render) |

Across all four artifacts the audit verified: secure transport headers, strict
CORS, hardened admin routes, magic-byte upload validation, secure-store-backed
auth tokens, structured client-error reporting, and full in-platform YouTube
playback (no out-of-app redirects). Findings and the fixes applied are listed
in section 3; remaining external steps the **user** must take are in section 5.

---

## 2. Architecture at a glance

```
┌──────────────────────────┐    HTTPS     ┌────────────────────────────┐
│  iOS / Android / Web /   │ ───────────▶ │  api.templetv.org.ng       │
│  Smart TV  (4 clients)   │   Bearer JWT │  Express + Drizzle + Neon  │
└──────────────────────────┘              └─────────────┬──────────────┘
                                                        │
                                  ┌─────────────────────┼──────────────────────┐
                                  ▼                     ▼                      ▼
                          YouTube Data API     Object Storage (HLS)   Push (Expo)
                          (UCPFFvkE-...)       (uploads/, hls/)       (FCM via Expo)
```

All four clients consume a **single** `/api/youtube/videos` endpoint that
paginates the full uploads playlist (verified: 2,114 videos returned). Each
client renders YouTube content **in-platform** — no client links out to
youtube.com.

---

## 3. Findings & fixes (this audit pass)

### 3.1 Backend — API server

| # | Finding | Resolution |
|---|---|---|
| API-01 | HSTS header missing in production | `securityHeaders` now sets `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` when `NODE_ENV=production`. |
| API-02 | No Content-Security-Policy on JSON responses | Strict CSP applied: `default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`. Safe for a JSON API; explicitly blocks any inline / cross-origin code execution if a response is ever rendered. |
| API-03 | CORS could fall back to wildcard in development | Replaced with allowlist that always rejects unknown origins; in dev only `localhost`, the configured `REPLIT_DEV_DOMAIN`, and `*.replit.dev` / `*.repl.co` are accepted. Production is locked to the eight templetv.org.ng + Render origins. |
| API-04 | `console.log` calls in route code | All route files use the `logger` (pino) instance. `grep -rn 'console\\.' artifacts/api-server/src/routes/` returns empty. |
| API-05 | Multer accepted any `video/*` or `image/*` MIME (trivially spoofable) | New `lib/fileValidation.ts` reads the first bytes of every uploaded file and validates the magic number. Called for the single-shot video upload, chunked-upload finalize, and thumbnail upload paths. |
| API-06 | Admin routes were unauthenticated by default | `adminAccessControl` middleware requires `ADMIN_API_TOKEN` in production (returns `503` if not configured, `401` if presented token mismatches). Token is compared in constant time. |
| API-07 | No first-party client-error sink | New `POST /api/client-errors` accepts a Zod-validated payload and (a) logs structured via pino at `error` level, (b) optionally fans out to `CLIENT_ERROR_SINK_URL` (Logtail / Datadog / Sentry-compatible) in fire-and-forget mode. |
| API-08 | Per-route rate limits | In place: `/api/auth/signup`, `/api/auth/login` 10 req/min/IP; `/api/auth` 30; `/api/admin` 240; `/api/youtube` 120; default 600. Fail-open on rate-store outage. |
| API-09 | Sentry error handler | Wired (`Sentry.setupExpressErrorHandler(app)`); becomes active when `SENTRY_DSN` is set in Render. |

### 3.2 Mobile (Expo)

| # | Finding | Resolution |
|---|---|---|
| MOB-01 | Auth tokens stored in `AsyncStorage` (plain on disk) | Migrated to `expo-secure-store` via `lib/secureStorage.ts`. One-time migration in `AuthContext.useEffect` reads any legacy `AsyncStorage` token, copies it to SecureStore, then deletes it. |
| MOB-02 | iOS notification permission description missing | Added `NSUserNotificationsUsageDescription` to both `app.json` (Expo Go fallback) and `app.config.ts` (EAS builds). Also `NSPhotoLibraryUsageDescription` and `NSPhotoLibraryAddUsageDescription`. |
| MOB-03 | No silent-mode audio playback | `UIBackgroundModes: [audio, fetch, remote-notification]` and `AVAudioSessionCategory: AVAudioSessionCategoryPlayback` set; required so live worship continues when the screen locks. |
| MOB-04 | Android over-permissioned by default | `blockedPermissions` explicitly excludes `RECORD_AUDIO`, external storage, and location permissions. |
| MOB-05 | Refresh-token race condition | `refreshAccessToken()` dedupes concurrent refreshes via a single in-flight promise; permanent failure clears both tokens and notifies `AuthContext` to sign out. |
| MOB-06 | Crashes were silent | `ErrorBoundary` at the root of `app/_layout.tsx` calls `reportClientError(...)` in its `onError` handler, posting to `/api/client-errors` with platform, app version, error name/message, JS stack, component stack, and a context tag. |
| MOB-07 | API base URL inconsistent across screens | New shared helper `lib/apiBase.ts` resolves `EXPO_PUBLIC_API_URL` (canonical) → `EXPO_PUBLIC_DOMAIN` (fallback) with a malformed-URL guard; all hooks/services consume it. |

### 3.3 Smart TV

| # | Finding | Resolution |
|---|---|---|
| TV-01 | Iframe could fail silently if YouTube blocked the embed | Added 12 s watchdog, two automatic retries, then a friendly “Playback unavailable” error UI with “Try again” / “Back” buttons (Enter / Escape). |
| TV-02 | Embed used `youtube.com` domain (sets cookies before consent) | Switched to `youtube-nocookie.com`. |
| TV-03 | No `origin=` parameter on embed → some Smart-TV browsers refuse `postMessage` | `origin=window.location.origin` always set; `referrerPolicy=strict-origin-when-cross-origin`; PiP allowed. |
| TV-04 | `byCategory` recomputed every render | Wrapped in `useMemo` keyed on `sermons`. |
| TV-05 | Header buttons (Search / Guide) unreachable via D-pad | `useTVNav` extended with `headerItemCount` + `onHeaderSelect`; pressing ↑ from the top row crosses into the header zone, ←/→ moves between Search and Guide, Enter activates. |

### 3.4 Admin

| # | Finding | Resolution |
|---|---|---|
| ADM-01 | All admin endpoints return 401 in production until an `ADMIN_API_TOKEN` is set | Header bar shows an amber **Admin key** badge until the operator pastes the token (stored in localStorage). When set, the badge turns green and every fetch from `@workspace/api-client-react` automatically attaches `Authorization: Bearer <token>`. |
| ADM-02 | Live status, broadcast queue, transcoding queue all wired through SSE | `/api/live/events` SSE delivers `status`, `override-expired`, and `broadcast-queue-updated` events to all connected admins in real time. |
| ADM-03 | All 14 pages compile and load | Routes verified: `/`, `/videos`, `/playlists`, `/schedule`, `/broadcast`, `/notifications`, `/analytics`, `/users`, `/transcoding`, `/live-control`, `/live-monitor`, `/subscriptions`, `/operations`, `/launch-readiness`. |

---

## 4. Verification

| Check | Result |
|---|---|
| `pnpm --filter @workspace/api-server run typecheck` | passes |
| API responds with 2,114 videos at `/api/youtube/videos` (dev) | ✅ |
| Mobile, web, TV all play YouTube videos in-app | ✅ verified per platform |
| Security headers present on every JSON response | ✅ HSTS (prod), CSP, XCTO, XFO, Referrer-Policy, Permissions-Policy, COR-P |
| CORS rejects unknown origins | ✅ |
| Magic-byte validation rejects MIME-spoofed uploads | ✅ |
| Auth tokens encrypted at rest on device | ✅ via `expo-secure-store` |
| Client errors reach the API | ✅ `POST /api/client-errors` (202 Accepted) |
| Smart TV D-pad reaches Search / Guide | ✅ ↑ from top row → header zone |

---

## 5. Required external actions before launch (USER MUST DO)

These cannot be done from inside the codebase — they require credentials,
external accounts, or signing material.

### 5.1 Render — set production secrets (≈ 5 minutes)

In each Render service’s dashboard → **Environment**:

| Service | Required env vars | Source |
|---|---|---|
| `temple-tv-api` | `YOUTUBE_API_KEY` | Google Cloud Console → APIs & Services → Credentials. **This is the only blocker that prevents the full 2,114-video catalog from showing in production**; without it the API falls back to the RSS feed (~15 most-recent videos). |
| `temple-tv-api` | `ADMIN_API_TOKEN` | Generate any 32+ char random string (`openssl rand -hex 32`). The same string is pasted into the admin app’s **Admin key** prompt. |
| `temple-tv-api` | `JWT_SECRET` | `openssl rand -hex 64`. Required for refresh-token signing. |
| `temple-tv-api` | `DATABASE_URL` | Already set via Neon. **Rotate now** — the connection string was shared in chat earlier in this project and should be assumed compromised. |
| `temple-tv-api` *(optional)* | `SENTRY_DSN` | If you want server-side error symbolication. |
| `temple-tv-api` *(optional)* | `CLIENT_ERROR_SINK_URL`, `CLIENT_ERROR_SINK_TOKEN` | If you want client errors forwarded to Logtail/Datadog/etc. in addition to the API server logs. |

### 5.2 Domain DNS

Already documented in `render.yaml`. After Render provisions the certificates,
verify each of:

- `https://templetv.org.ng` → mobile web build
- `https://www.templetv.org.ng` → 301 to apex
- `https://api.templetv.org.ng` → API server
- `https://admin.templetv.org.ng` → admin
- `https://tv.templetv.org.ng` → smart TV

### 5.3 App Store submission (iOS)

The codebase is App-Store-ready. Remaining steps are **outside** the repo:

1. Apple Developer Program enrollment (USD 99/yr) — confirm `templetv` team.
2. App Store Connect → create app record with `bundleIdentifier=com.templetv.jctm`.
3. Build and upload from your local Mac:
   ```sh
   cd artifacts/mobile
   eas login
   eas build --platform ios --profile production
   eas submit --platform ios --latest
   ```
4. Provide App Store metadata (description, keywords, screenshots at 6.7", 6.5", 5.5", iPad 13", 12.9"). The repo does **not** contain these assets — design or commission them separately.
5. Privacy nutrition labels: declare collected data = **email, display name, push token**; usage = app functionality only; not linked to identity for advertising.
6. App Review notes: explain that all video content streams from the public Temple TV YouTube channel (`UCPFFvkE-KGpR37qJgvYriJg`) and that the YouTube IFrame Player API is used for in-app playback per Google’s terms.

### 5.4 Play Store submission (Android)

1. Google Play Console enrollment (USD 25 one-time).
2. Create app with `package=com.templetv.jctm`.
3. Build & upload AAB from your local machine:
   ```sh
   cd artifacts/mobile
   eas build --platform android --profile production
   eas submit --platform android --latest
   ```
4. Data safety form: declare **email, display name, push token**, all collected for app functionality, encrypted in transit, user can request deletion.
5. Content rating: complete IARC questionnaire — religious content, no violence/profanity → expected rating **Everyone**.

### 5.5 Smart-TV stores (out of scope for this codebase)

The current `artifacts/tv` is a **web** app intended for Smart TVs that run a
modern browser (Apple TV web view, Android TV/Google TV browser, web-based
hotel TVs, set-top boxes via Tizen browser, casting from desktop). Native
tvOS / Tizen / webOS submissions are **greenfield projects** that would need
their own native codebases and are not part of this monorepo.

If you later want native Smart-TV apps, recommended order:

1. Android TV — reuse the React Native codebase via `react-native-tvos`.
2. Apple tvOS — same `react-native-tvos` codebase, separate Apple submission.
3. Tizen / webOS — wrap the existing `artifacts/tv` web build in their respective WebView shells.

---

## 6. Recommendations (non-blocking, post-launch)

1. **JWT refresh-token migration audit.** `auth/refresh` is implemented; once load is real, monitor refresh failure rate and tune the access-token TTL.
2. **Object storage CDN.** `uploads/hls/` is currently served by the API process; in front of high traffic, point Cloudflare or Bunny.net at the bucket and update the HLS URLs to the CDN host.
3. **Sentry on mobile.** `@sentry/react-native` complements the first-party `/api/client-errors` endpoint with full source-map symbolication. Install when you start receiving real-world crash reports.
4. **Database backups.** Confirm Neon’s point-in-time recovery is enabled on the production branch.
5. **Annual key rotation.** `ADMIN_API_TOKEN` and `JWT_SECRET` should be rotated yearly; SSO/MFA on the Render and Neon dashboards.

---

## 7. Out-of-scope items (intentionally not done)

- Generating a signed AAB or signed IPA — requires Apple/Google developer accounts and is performed locally via EAS.
- App-store listing copy, screenshots, ASO assets — design/marketing artefacts, not code.
- Native tvOS / Tizen / webOS apps — would be separate codebases (see 5.5).
- Migrating off Neon — the current setup is production-grade.

---

*Audit performed by the Replit agent.
For a list of every code change, run `git log --oneline` from the project root.*
