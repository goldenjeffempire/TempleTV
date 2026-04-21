# Temple TV — Release Audit & Production-Readiness Report

**Date:** 2026-04-21
**Scope:** Full monorepo audit and production-hardening pass on the Temple TV
platform — API server, Admin dashboard, Expo mobile app, and TV web app.
**Owner:** Engineering

---

## 1. Executive summary

Temple TV is a multi-artifact streaming platform consisting of:

- **`@workspace/api-server`** — Express + Drizzle/Postgres API (auth, content,
  YouTube live polling, push notifications, chunked video uploads,
  transcoding queue, broadcast SSE).
- **`@workspace/admin`** — React + Vite admin console.
- **`@workspace/mobile`** — Expo (React Native) app for iOS / Android / Web.
- **`@workspace/tv`** — React + Vite TV web app (D-pad-driven, designed for
  large screens and 10-foot UX).

This pass focused on **security hardening**, **mobile production
configuration**, **TV resilience**, and **observability**. All findings below
have been remediated unless explicitly listed in **§ 6 — Out of scope / Next
steps**.

The application is now in a **deployable** state for the API server, admin
console, mobile web build, and TV web app. Native store submissions (AAB / IPA)
and native tvOS / Tizen / webOS apps are out of scope for this engineering pass
and listed in § 6 with concrete next steps.

---

## 2. Architecture snapshot

| Layer        | Stack                                                  | Notes |
|--------------|--------------------------------------------------------|-------|
| API          | Node 20+, Express, Drizzle ORM, Postgres, Pino, Zod    | Single process, in-memory rate-limit + cache |
| Admin        | React 19 + Vite + TypeScript                           | Path-based routing under `/admin/` |
| Mobile       | Expo SDK 54, React Native 0.81, expo-router, RN-TrackPlayer | iOS, Android, web targets |
| TV           | React + Vite, custom D-pad nav (`useTVNav`)            | Optimized for HTMI/Smart TV browsers |
| Storage      | Local disk (uploads/), planned migration to object storage | See § 6 |

---

## 3. Audit findings & remediation

### 3.1 Security (API server)

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| S1 | Missing HSTS header in production responses | High | **Fixed** — `Strict-Transport-Security` (2y, includeSubDomains, preload) added in `middlewares/security.ts` (production only) |
| S2 | No Content-Security-Policy on API | Medium | **Fixed** — strict CSP (`default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`) applied to all responses; safe for JSON-only API |
| S3 | CORS fell back to allow-all in non-production environments | High | **Fixed** — CORS now allow-listed even in dev (Replit dev domain, `*.replit.dev`, `*.repl.co`, localhost). Production unchanged: only `ALLOWED_ORIGINS` allowed |
| S4 | File uploads validated only by `Content-Type` (trivially spoofable) | High | **Fixed** — added `lib/fileValidation.ts` magic-byte sniffer covering common video (mp4/mov/mkv/webm/avi/flv/mpeg-ps/mpeg-ts/ogg/3gp) and image (jpeg/png/gif/webp/bmp/tiff) signatures. Wired into the chunked-upload finalize endpoint and the thumbnail upload endpoint. Invalid uploads return **HTTP 415** and are deleted from disk |
| S5 | `console.log` / `console.error` in `routes/youtube.ts` (live poller) | Medium | **Fixed** — replaced with structured `logger.info` / `logger.error` (Pino, with redaction) |
| S6 | Auth tokens persisted in plain `AsyncStorage` on mobile | High | **Fixed** — see § 3.2 |

#### 3.1.1 Headers now emitted (all responses)

```
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cross-Origin-Resource-Policy: cross-origin
Content-Security-Policy: default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload   # production only
```

#### 3.1.2 CORS policy (effective)

- **Production:** only origins in `ALLOWED_ORIGINS` env var (comma-separated).
- **Dev:** above + `REPLIT_DEV_DOMAIN`, `*.replit.dev`, `*.repl.co`,
  `localhost`/`127.0.0.1`. **No wildcard.**
- `credentials: true` enabled (required for cookie-based admin sessions in a
  future iteration).

#### 3.1.3 File upload defense in depth

1. `multer` `fileFilter` rejects on MIME prefix.
2. `multer` `limits.fileSize` enforces 5 GB / 10 MB caps.
3. **NEW:** post-write magic-byte validation in
   `lib/fileValidation.ts::validateUploadedFileMagicBytes()`.
4. On mismatch, the file is `unlink`'d and the request returns 415.

### 3.2 Mobile (Expo) production fixes

| # | Finding | Status |
|---|---------|--------|
| M1 | Auth tokens in `AsyncStorage` (plain text, world-readable on rooted devices) | **Fixed** — migrated to `expo-secure-store` (iOS Keychain / Android EncryptedSharedPreferences) via new `lib/secureStorage.ts`. Includes a one-time migration of any pre-existing legacy token. Web falls back to `AsyncStorage` (planned: switch to httpOnly cookie auth on web — see § 6) |
| M2 | Missing iOS usage description strings (notifications, photo library) — would block App Store review | **Fixed** — added `NSUserNotificationsUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription` to both `app.json` and `app.config.ts` |
| M3 | `NSAllowsArbitraryLoads` was set as a top-level Info.plist key (incorrect — must live inside `NSAppTransportSecurity`) | **Fixed** — moved into the proper `NSAppTransportSecurity` dictionary so ATS is actually enforced |
| M4 | No client-side error reporting | **Fixed** — added `lib/errorReporter.ts` (Platform-aware, throttled, fire-and-forget) and wired the root `<ErrorBoundary>` `onError` to ship `Error.name`/`message`/`stack`/`componentStack` to `POST /api/client-errors` |

### 3.3 TV web app polish

| # | Finding | Status |
|---|---------|--------|
| TV1 | YouTube iframe player had no error handling — black screen on failure | **Fixed** — `Player.tsx` rewritten with a 12-second load watchdog, two automatic retries on iframe error or load timeout, and an accessible error UI (auto-focused **Try again** button, **Enter** to retry, **Back** to return) |
| TV2 | `byCategory` / `featured` recomputed on every render in `useData.ts` (cascades through `Home.tsx` D-pad nav) | **Fixed** — both memoized with `useMemo` keyed on `sermons` |
| TV3 | Header (Search / Guide buttons) reachable only via keyboard shortcuts, not D-pad navigation | **Documented (deferred)** — see § 5. Header still operable via `S` / `G` keyboard shortcuts; full D-pad reachability requires a wider refactor of `useTVNav` to support out-of-grid focus targets |

### 3.4 New endpoint: `POST /api/client-errors`

- Mounted in `routes/index.ts`, implemented in `routes/client-errors.ts`.
- Zod-validated payload: `platform`, `appVersion`, `buildNumber`, `errorName`,
  `errorMessage`, `stack`, `componentStack`, `context`, `occurredAt`.
- Logs as a structured Pino record (`clientError: true`) so it can be filtered
  and routed to your log sink (Datadog, Logtail, etc.).
- Returns **202 Accepted**. Throttled client-side to one report / second.
- Subject to the existing global rate-limit middleware.

---

## 4. Files changed in this pass

### API server
- `artifacts/api-server/src/middlewares/security.ts` — HSTS + CSP
- `artifacts/api-server/src/app.ts` — strict CORS + credentials
- `artifacts/api-server/src/routes/youtube.ts` — Pino instead of console
- `artifacts/api-server/src/routes/admin.ts` — magic-byte validation on
  finalize + thumbnail
- `artifacts/api-server/src/lib/fileValidation.ts` — **new**
- `artifacts/api-server/src/routes/client-errors.ts` — **new**
- `artifacts/api-server/src/routes/index.ts` — wire client-errors route

### Mobile
- `artifacts/mobile/lib/secureStorage.ts` — **new** (SecureStore + web fallback)
- `artifacts/mobile/lib/errorReporter.ts` — **new**
- `artifacts/mobile/context/AuthContext.tsx` — token in SecureStore + legacy migration
- `artifacts/mobile/services/authApi.ts` — token read from SecureStore
- `artifacts/mobile/app/_layout.tsx` — ErrorBoundary wired to reporter
- `artifacts/mobile/app.json` + `app.config.ts` — iOS permission strings,
  ATS dictionary corrected
- `artifacts/mobile/package.json` — added `expo-secure-store`

### TV
- `artifacts/tv/src/pages/Player.tsx` — load watchdog, auto-retry, error UI
- `artifacts/tv/src/hooks/useData.ts` — `useMemo` for `byCategory` / `featured`

---

## 5. Known limitations / engineering recommendations

These are intentional follow-ups that did not fit safely in this pass:

1. **JWT refresh-token migration.** Current tokens are long-lived JWTs. A
   refresh-token rotation flow (short-lived access + long-lived refresh in
   secure storage) is industry standard but is a breaking change across all
   clients. Estimated effort: 1–2 engineering days.
2. **Web auth via httpOnly cookies.** On the web target, `secureStorage` falls
   back to `AsyncStorage` (i.e. `localStorage`), which is XSS-readable. Switch
   to httpOnly + SameSite=Lax cookies issued by the API. Requires CSRF token
   middleware on state-changing routes.
3. **Object storage for uploads.** Local disk in `artifacts/api-server/uploads/`
   does not survive container restarts on a stateless host. Migrate to
   Replit App Storage (object-storage skill) or S3 + signed URLs before any
   non-trivial production traffic.
4. **TV header in D-pad flow.** Requires extending `useTVNav` with a "header
   row" concept (focus escape upward from row 0). Documented as a TODO in
   `Home.tsx`.
5. **Sentry / Crashlytics.** `POST /api/client-errors` is a minimal first-party
   sink. For trend analysis, breadcrumbs, and source-map symbolication, install
   `@sentry/react-native` and forward the same payload.
6. **Database backups.** Configure automated PITR or daily logical backups on
   the production Postgres before launch.
7. **Rate-limit store.** Current limiter is in-process. For multi-instance
   deployments, move to Redis-backed limiter.

---

## 6. Out of scope / Next steps for store submission

These items require external accounts, manual operator action, or code that
does not yet exist in the repository.

### iOS — App Store

1. Apple Developer account (paid, $99/yr) — owner: TBD.
2. App Store Connect entry created with bundle id
   `com.templetv.jctm`.
3. Generate an iOS distribution certificate + provisioning profile (or let EAS
   manage credentials).
4. Build with EAS: `eas build --platform ios --profile production`. The
   `production` profile is already configured in `artifacts/mobile/eas.json`
   (auto-incrementing build number, `m-medium` resource class). Before the
   first submission, fill the two `submit.production.ios` placeholders
   (`appleTeamId`, `ascAppId`) — see § 8.2.
5. Submit: `eas submit --platform ios --latest`.
6. App Store Review prerequisites (the audit changes already cover the
   technical ones):
   - ✅ Usage description strings (added).
   - ✅ ATS enabled correctly (fixed).
   - ✅ `ITSAppUsesNonExemptEncryption: false` (already present).
   - ✅ Privacy policy URL — `https://<your-domain>/legal/privacy` (page
     published in this pass).
   - ✅ Terms of Service URL — `https://<your-domain>/legal/terms` (page
     published in this pass).
   - ⏳ Screenshots (6.7", 6.5", 5.5", iPad Pro 12.9").
   - ⏳ App Store description, keywords.
   - ⏳ Demo account credentials for review team.

### Android — Google Play

1. Google Play Console account (one-time $25) — owner: TBD.
2. Create app with package `com.templetv.jctm`.
3. Build: `eas build --platform android --profile production` (produces an
   AAB).
4. Submit: `eas submit --platform android --latest`.
5. Play Console prerequisites:
   - ⏳ Privacy policy URL.
   - ⏳ Data safety form (we collect: account email, push token, watch
     history, favorites — all on-server only).
   - ⏳ Content rating questionnaire.
   - ⏳ Feature graphic (1024×500), screenshots.

### TV web — distribution channels

The TV app is currently a web build. To ship as native:

- **Apple tvOS:** requires a separate Swift / SwiftUI project. Not in the
  monorepo. Greenfield project; the existing `@workspace/tv` codebase is a
  reference for layout and D-pad UX but cannot be reused directly.
- **Samsung Tizen / LG webOS:** can wrap the existing Vite build using each
  vendor's WebView container. Requires registering as a developer with each
  vendor (Samsung Smart TV Developer, LG webOS Developer). Estimated effort:
  3–5 days per vendor (packaging, signing, store listing).

### API / production hosting

- ✅ Builds and runs in this environment.
- ⏳ Set `NODE_ENV=production` and `ALLOWED_ORIGINS=<your origins>` on the
  deployment.
- ⏳ Provision managed Postgres (Replit Database is fine for launch; size up
  before scale).
- ⏳ Configure object storage and switch upload destination.

---

## 7. Acceptance verification

| Acceptance criterion | Result |
|----------------------|--------|
| HSTS + CSP headers present | ✅ verified in `securityHeaders` middleware |
| CORS strict (no dev wildcard) | ✅ verified in `app.ts` CORS callback |
| No `console.*` in `routes/youtube.ts` | ✅ verified — all replaced with `logger` |
| Uploads validate magic bytes | ✅ verified in finalize + thumbnail handlers |
| Tokens in SecureStore | ✅ verified in `AuthContext.tsx` + `authApi.ts` |
| iOS permission descriptions present | ✅ verified in `app.json` and `app.config.ts` |
| Errors reportable to server | ✅ `POST /api/client-errors` mounted; mobile `<ErrorBoundary>` wired |
| TV Player error UI on failure | ✅ verified in `Player.tsx` (load watchdog + retry) |
| `byCategory` memoized | ✅ verified in `useData.ts` (`useMemo([sermons])`) |
| Header reachable via D-pad | ⏳ deferred (documented in § 5.4) |

---

## 8. Operational checklist before public launch

### 8.1 Completed in this pass

- [x] **Privacy policy + Terms of Service published.** Static HTML pages served
      directly by the API server at:
  - `GET /legal/privacy` — full Privacy Policy (data collected, third
    parties, retention, children's privacy, contact)
  - `GET /legal/terms` — full Terms of Service (eligibility, acceptable use,
    IP, donations, disclaimers, limitation of liability)
  - `GET /legal` — index page linking to both
  These URLs are the ones to paste into the App Store Connect privacy URL
  field and the Google Play Data Safety form. Source:
  `artifacts/api-server/src/routes/legal.ts`.
- [x] **Object storage bucket provisioned.** Replit App Storage (GCS-backed)
      bucket created. Environment variables `DEFAULT_OBJECT_STORAGE_BUCKET_ID`,
      `PUBLIC_OBJECT_SEARCH_PATHS`, `PRIVATE_OBJECT_DIR` are now set. The
      upload pipeline still writes to local disk (`artifacts/api-server/uploads/`)
      until the migration is performed — see § 8.3 for the migration plan.
- [x] **`eas.json` profiles configured.** `development`, `preview`, and
      `production` build profiles exist with iOS/Android targets,
      auto-incrementing build numbers, and submit metadata. Two placeholders
      remain for the user to fill before the first iOS submission — see § 8.2.
- [x] **Rate-limit thresholds reviewed.** Current thresholds (per IP, per
      minute): signup/login 10, other auth 30, admin upload 90, admin general
      240, YouTube 120, fallback 600. Confirmed reasonable for expected
      traffic. In-process bucket — see § 8.3 if multi-instance scaling is
      planned.
- [x] **Workflow hygiene.** Duplicate legacy workflows (`API Server`,
      `Temple TV`, `Temple TV Admin`) removed. Only the artifact-managed
      workflows now exist, eliminating port collisions on restart.

### 8.2 Required before submission (user action)

- [ ] **Set `ALLOWED_ORIGINS`** in the production deployment environment to
      the comma-separated list of domains the API will accept browser
      requests from (e.g. `https://templetv.example.com,https://admin.templetv.example.com`).
- [ ] **Set `NODE_ENV=production`** in the production deployment.
- [ ] **Set `ADMIN_API_TOKEN`** to a strong random secret (≥ 32 bytes,
      hex/base64). Required in production — admin endpoints return 503 until
      it is set. Distribute this token only to admin operators.
- [ ] **Fill `eas.json` placeholders.** Open `artifacts/mobile/eas.json` →
      `submit.production.ios` and supply:
  - `appleTeamId` — your 10-character Apple Developer Team ID.
  - `ascAppId` — the App Store Connect numeric app ID created when you
    register the app in App Store Connect.
- [ ] **Place Google Play service-account key.** Drop the JSON key file at
      `artifacts/mobile/google-service-account.json` (already referenced
      in `eas.json`). Do NOT commit it — it should be in `.gitignore`.
- [ ] **Configure managed Postgres backups** in the deployment hosting
      panel. Recommended: daily snapshots, 30-day retention.
- [ ] **Wire `POST /api/client-errors` to a long-term log sink** (Sentry,
      Datadog, Logtail). The endpoint already structured-logs every report
      via Pino; add a Pino transport pointing at the chosen sink. No code
      change required to the endpoint itself.
- [ ] **Run the first iOS / Android production builds** via
      `eas build --platform ios --profile production` and
      `eas build --platform android --profile production`, then submit with
      `eas submit`. Requires Apple Developer ($99/yr) and Google Play
      ($25 one-time) accounts.
- [ ] **Smoke test the live broadcast flow end-to-end** on at least one iOS
      device, one Android device, one TV browser, one desktop browser.
- [ ] **App store listing assets** — screenshots (6.7" iPhone, 12.9" iPad,
      Android phone/tablet), feature graphic, app icon set, store
      description, keywords, support URL, marketing URL. Out of scope for
      this engineering pass.

### 8.3 Recommended follow-up engineering work

- [ ] **Migrate uploads to object storage.** The bucket is provisioned and
      the SDK is available. The migration involves:
    1. Generate presigned PUT URLs in `routes/admin.ts` instead of accepting
       chunks via multipart.
    2. Have the admin client upload directly to GCS, then call a finalize
       endpoint with the `objectPath`.
    3. Move HLS transcoding outputs to the bucket and serve via
       `/api/storage/objects/*`.
    4. One-time backfill: stream existing files from
       `artifacts/api-server/uploads/` to GCS, update DB rows, delete local
       copies.
  Estimated effort: 1–2 engineering days. Until migrated, ensure the
  deployment volume hosting `uploads/` is backed up.
- [ ] **Move rate-limit state to Redis** if you horizontally scale the API
      beyond one instance. Today the bucket map is in-process — two
      instances would each enforce the limit independently.
- [ ] **Refresh-token rotation.** Currently the mobile app uses a single
      bearer token in SecureStore. Adding short-lived access tokens with a
      rotating refresh token is recommended for stronger session security.
      This is a coordinated change across `routes/auth.ts`,
      `services/authApi.ts`, and `context/AuthContext.tsx`.

---

*End of report.*
