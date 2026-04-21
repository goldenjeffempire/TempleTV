# Temple TV — App Store & Play Store Listing Copy

This file contains the marketing copy, keywords, and metadata to paste into
App Store Connect (iOS) and the Google Play Console (Android) when creating
the store listings. Generated as part of the launch-readiness pass.

> Replace `<your-domain>` placeholders with the production domain
> (e.g. `templetv.org.ng`) before submission.

---

## App identity

| Field | Value |
|---|---|
| App name | **Temple TV** |
| Bundle / package id | `com.templetv.jctm` |
| Subtitle (iOS, 30 chars) | Watch JCTM live & on demand |
| Short description (Android, 80 chars) | Live broadcasts and on-demand sermons from Jesus Christ Temple Ministry. |
| Primary category | Lifestyle (alternate: Reference) |
| Secondary category (iOS) | News |
| Content rating | Everyone (no objectionable content) |
| Pricing | Free |
| In-app purchases | None |

---

## Apple App Store

### Promotional text (170 char max — editable without re-review)

```
New: Programme Guide, background Radio Mode, and offline sermon library.
Tap Watch to join the live service from anywhere in the world.
```

### Description (4000 char max)

```
Temple TV is the official streaming app of Jesus Christ Temple Ministry
(JCTM). Watch live Sunday services, daily devotionals, and a growing
library of teachings, prophecy, healing and worship sermons — at home, on
the road, or on your TV.

WHY TEMPLE TV
• Live broadcasts straight from the JCTM auditorium, with low-latency
  start and automatic retry if your connection drops.
• A complete on-demand library of sermons, organised by category:
  Faith, Healing, Deliverance, Worship, Teachings, and Special Programs.
• Programme Guide showing what's coming up next on the channel.
• Radio Mode for hands-free, audio-only listening — perfect for the car
  or for when the screen is locked.
• Save sermons to your Library, build playlists, and pick up where you
  left off across all your devices when you sign in.
• Designed for accessibility: large text support, reduced-motion aware,
  and full D-pad navigation on tvOS-class browsers.
• Data Saver mode for slower connections.

GIVE
You can support the ministry directly from inside the app via Paystack,
Flutterwave, or bank transfer. Donations are processed by trusted
payment partners — Temple TV never sees your card details.

PRIVACY
Your viewing history and favourites stay on your device unless you sign
in. Authentication tokens are stored in the platform-secure keychain.
You can delete your account from Settings at any time.

ABOUT THE MINISTRY
Jesus Christ Temple Ministry (JCTM) is a Christian ministry based in
Nigeria. Visit jctm.org.ng to learn more.

SUPPORT
Questions? Email support@<your-domain> or visit https://<your-domain>/support.
```

### Keywords (100 char max, comma-separated, no spaces)

```
temple,tv,jctm,church,sermon,worship,prayer,gospel,christian,bible,live,stream,faith,healing
```

### What's New (release notes — 4000 char max)

```
1.0 — First public release.
• Live broadcast playback with auto-retry.
• Sermon library with offline metadata caching.
• Programme Guide.
• Radio Mode for background audio playback.
• Save sermons, build playlists, sync across devices when signed in.
• Donate via Paystack, Flutterwave, or bank transfer.
```

### Support / marketing URLs

| Field | Value |
|---|---|
| Support URL | `https://<your-domain>/support` (or `mailto:support@<your-domain>`) |
| Marketing URL | `https://<your-domain>` |
| Privacy Policy URL | `https://<your-domain>/legal/privacy` |
| EULA | Standard Apple Licensed Application End-User License Agreement |

### Demo account credentials (for review team)

A reviewer demo account is created by running:

```bash
pnpm --filter @workspace/api-server exec tsx scripts/seed-demo-account.ts
```

Default credentials:

| Field | Value |
|---|---|
| Email | `reviewer@templetv.org.ng` |
| Password | `TempleTV-Review-2026!` |
| Notes | Pre-verified email, no further onboarding required. Tap **Settings → Sign In** on the mobile app. |

> Override defaults by setting `DEMO_EMAIL`, `DEMO_PASSWORD`, `DEMO_NAME`
> before running the script. Re-run any time to reset the password.

### Age rating questionnaire (iOS)

| Question | Answer |
|---|---|
| Cartoon or fantasy violence | None |
| Realistic violence | None |
| Sexual content / nudity | None |
| Profanity / crude humor | None |
| Mature/suggestive themes | None |
| Horror / fear themes | None |
| Medical / treatment information | None |
| Gambling / contests | None |
| Unrestricted web access | **No** (in-app links open Safari with explicit user action) |
| User-generated content | None |
| Made for Kids? | **No** |
| **Resulting rating** | **4+** |

---

## Google Play Console

### Short description (80 char max)

```
Live broadcasts and on-demand sermons from Jesus Christ Temple Ministry.
```

### Full description (4000 char max)

Use the Apple **Description** block above verbatim. Google Play accepts
plain text and renders bullets as `•` characters fine.

### What's New (release notes, 500 char max)

```
First public release. Live broadcasts, on-demand sermons by category,
Programme Guide, Radio Mode, offline metadata caching, playlists, and
in-app giving via Paystack, Flutterwave or bank transfer.
```

### Data safety form

| Data type collected | Purpose | Shared with 3rd parties? | Optional? | Encrypted in transit? | Can user request deletion? |
|---|---|---|---|---|---|
| Email address | Account management | No | Yes (only if signing in) | Yes | Yes — Settings → Delete Account |
| Display name | Account management | No | Yes | Yes | Yes |
| App interactions (sermons watched, favourites) | App functionality | No | Yes (only if signed in — otherwise stays on device) | Yes | Yes |
| Push token | Send broadcast-start notifications | No (delivered via Expo push, FCM/APNs) | Yes | Yes | Yes — disable notifications or sign out |
| Crash logs / diagnostics | App stability | No (sent only to first-party `/api/client-errors`) | No | Yes | N/A — pseudonymous, no PII |

We **do not** collect: precise location, contacts, photos, microphone,
financial info (donations are handled by Paystack/Flutterwave directly),
health data, or web browsing history.

### Content rating questionnaire (IARC)

All sensitive-content questions answered **No**. Final IARC rating: **3+ /
Everyone**.

### Target audience and content

- Target age groups: 13+ (no Made-for-Families designation).
- Ads: **No ads served by the app.**
- In-app purchases: **None.**
- Government app: **No.**
- Contains user-generated content: **No.**

### Store listing assets

| Asset | Spec | Path in repo |
|---|---|---|
| App icon | 512×512 PNG (Play Console auto-generates from 1024×1024) | `screenshots/store-assets/app-icon-1024x1024.png` |
| Feature graphic | 1024×500 PNG/JPG | `screenshots/store-assets/feature-graphic-1024x500.png` |
| Phone screenshots | 1080×1920 ×6 | `screenshots/android/phone/` |
| 10″ tablet screenshots | 1920×1200 ×6 | `screenshots/android/tablet-10/` |

### Support / contact

| Field | Value |
|---|---|
| Email | `support@<your-domain>` |
| Website | `https://<your-domain>` |
| Privacy Policy URL | `https://<your-domain>/legal/privacy` |
| Phone | _(optional, leave blank)_ |

---

## Smart-TV stores (future)

The TV web app at `https://tv.<your-domain>` is the production Smart-TV
target until native Tizen / webOS / tvOS apps are built (see
`RELEASE_AUDIT.md` § 6 for distribution plans). Use the Smart-TV
screenshots at `screenshots/smart-tv/` when those listings are created.

---

*End of listing copy.*
