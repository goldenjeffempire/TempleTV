# Temple TV — App Store & Play Store Listing Copy

> **Package/Bundle ID**: `com.templetv.app`
> **Version**: 1.0.0 (Android versionCode 21, iOS buildNumber 1)
> **Last updated**: May 2026
>
> All placeholder domains have been resolved. Copy-paste ready.

---

## App identity

| Field | Value |
|---|---|
| **App name** | Temple TV: JCTM Live & Sermons |
| **Bundle / package ID** | `com.templetv.app` |
| **iOS subtitle** (30 chars) | Watch JCTM Live & On Demand |
| **Android short description** (80 chars) | Live worship, sermons & broadcasts from Jesus Christ Temple Ministry (JCTM). |
| **Primary category** | Entertainment (Android) / Lifestyle (iOS alternate) |
| **Secondary category (iOS)** | Reference |
| **Content rating** | Everyone / 3+ |
| **Pricing** | Free |
| **In-app purchases** | None |
| **Contains ads** | No |

---

## Google Play Console

> For the complete Play Console setup guide including data safety, content rating, target audience, compliance declarations, and publishing settings, see **[docs/google-play-console.md](docs/google-play-console.md)**.

### App name (30 chars — Play Store)

```
Temple TV: JCTM Live & Sermons
```

### Short description (80 chars)

```
Live worship, sermons & broadcasts from Jesus Christ Temple Ministry (JCTM).
```

### Full description (4000 chars)

```
Temple TV is the official streaming app of Jesus Christ Temple Ministry (JCTM) — your home for live Sunday services, daily devotionals, and a growing library of faith-filled teachings, prophecy, healing sermons, and worship music, available anywhere in the world.

━━━━━━━━━━━━━━━━━━━━━━━━━━
LIVE BROADCASTS
━━━━━━━━━━━━━━━━━━━━━━━━━━
• Watch live directly from the JCTM auditorium with low-latency HLS streaming and automatic reconnection if your connection drops.
• Real-time broadcast notifications so you never miss a service.
• Live viewer count and interactive prayer requests during broadcasts.
• Automatic failover keeps the stream going even during technical interruptions.

━━━━━━━━━━━━━━━━━━━━━━━━━━
ON-DEMAND SERMON LIBRARY
━━━━━━━━━━━━━━━━━━━━━━━━━━
• Thousands of sermons, teachings, and worship recordings organized by category: Faith, Healing, Deliverance, Worship, Prophecy, and Special Programs.
• Full-text search across the entire sermon archive.
• Save sermons to your personal Library and pick up where you left off across all your devices when signed in.
• Programme Guide showing what is coming up next on the channel.

━━━━━━━━━━━━━━━━━━━━━━━━━━
RADIO MODE
━━━━━━━━━━━━━━━━━━━━━━━━━━
• Switch to audio-only Radio Mode for hands-free, background listening — perfect for driving, working, or when your screen is locked.
• Continuous playback with media controls visible on your lock screen and notification shade.

━━━━━━━━━━━━━━━━━━━━━━━━━━
PERSONALIZATION
━━━━━━━━━━━━━━━━━━━━━━━━━━
• Create a free account to sync your Library, watch history, and preferences across all your devices.
• Receive push notifications for live broadcast start times and new sermon uploads.
• Data Saver mode for low-bandwidth connections.

━━━━━━━━━━━━━━━━━━━━━━━━━━
SUPPORT THE MINISTRY
━━━━━━━━━━━━━━━━━━━━━━━━━━
• Give directly from the app via secure payment partners.
• Temple TV never stores or sees your card or bank details — all transactions are processed by certified payment providers.

━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR PRIVACY
━━━━━━━━━━━━━━━━━━━━━━━━━━
• Watching without signing in keeps all viewing activity on your device only.
• Account data is encrypted in transit at all times.
• Delete your account and all associated data from Settings at any time.
• We do not sell, share, or monetize your personal data.

━━━━━━━━━━━━━━━━━━━━━━━━━━
ABOUT JCTM
━━━━━━━━━━━━━━━━━━━━━━━━━━
Jesus Christ Temple Ministry (JCTM) is a Christian ministry based in Nigeria, dedicated to the proclamation of the Gospel of Jesus Christ through prayer, teaching, healing, and worship. Visit jctm.org.ng to learn more.

━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTACT & SUPPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━
• Email: support@templetv.org.ng
• Website: https://templetv.org.ng
• Privacy Policy: https://jctm.org.ng/privacy-policy
```

### What's New — v1.0.0 (500 chars)

```
1.0 — First public release.
• Live broadcast streaming with automatic retry.
• On-demand sermon library (Faith, Healing, Worship, Deliverance).
• Programme Guide.
• Radio Mode for background audio playback.
• Save sermons to your Library; sync across devices when signed in.
• Push notifications for live broadcast start.
```

### Contact details

| Field | Value |
|---|---|
| **Developer email** | `templedeveloper@jctm.org.ng` |
| **Support email** | `support@templetv.org.ng` |
| **Support website** | `https://templetv.org.ng/support` |
| **Privacy policy** | `https://jctm.org.ng/privacy-policy` |
| **Phone** | *(leave blank)* |

### App access (reviewer credentials)

| Field | Value |
|---|---|
| **Email** | `reviewer@templetv.org.ng` |
| **Password** | `TempleTV-Review-2026!` |
| **Notes** | Pre-verified email, no onboarding required. Tap Settings → Sign In. |

**Seed command**:
```bash
pnpm --filter @workspace/api-server exec tsx scripts/seed-demo-account.ts
```

### Store assets

| Asset | Spec | File |
|---|---|---|
| App icon | 512×512 PNG | `artifacts/mobile/assets/images/icon.png` |
| Feature graphic | 1024×500 PNG/JPG | `artifacts/mobile/assets/images/feature-graphic.png` |
| Phone screenshots | 1080×1920 × 6 | `screenshots/android/phone/` |
| 10-inch tablet screenshots | 1920×1200 × 6 | `screenshots/android/tablet-10/` |
| Android TV banner | 320×180 PNG | `artifacts/mobile/assets/images/tv-banner.png` |

### Data safety summary

| Data type | Collected | Shared | Purpose |
|---|---|---|---|
| Email address | Yes (if account created) | No | Account login |
| Display name | Yes (if account created) | No | Account personalization |
| Profile photo | Yes (if user uploads one) | No | Account personalization |
| App interactions (watch history, saved sermons) | Yes (if signed in) | No | Resume playback, library sync |
| Push token (FCM) | Yes (if notifications enabled) | No (delivered via Expo/FCM infra) | Live broadcast alerts |
| Crash/diagnostic logs | Yes | No | App stability |
| Location | **No** | — | Explicitly blocked |
| Contacts | **No** | — | Explicitly blocked |
| Microphone/camera | **No** | — | Permission disabled |
| Financial info | **No** | — | Handled by Paystack/Flutterwave |

### Content rating (IARC)

All sensitive-content questions: **No**. Final IARC rating: **Everyone / 3+**

### Target audience

- Ages 13+ (no Made-for-Families designation)
- Ads: **None**
- In-app purchases: **None**
- Government app: **No**
- User-generated content visible to others: **No**

### App category

| Field | Value |
|---|---|
| **Primary** | Entertainment |
| **Tags** | Streaming, Christian, Church, Sermon, Worship |

---

## Apple App Store

### Promotional text (170 chars)

```
New: Programme Guide, background Radio Mode, and sermon library sync.
Tap Watch to join the live service from anywhere in the world.
```

### Description (4000 chars)

```
Temple TV is the official streaming app of Jesus Christ Temple Ministry
(JCTM). Watch live Sunday services, daily devotionals, and a growing
library of teachings, prophecy, healing and worship sermons — at home, on
the road, or on your TV.

LIVE BROADCASTS
• Watch live directly from the JCTM auditorium, with low-latency
  HLS streaming and automatic retry if your connection drops.
• Real-time broadcast notifications so you never miss a service.
• Live viewer count and interactive prayer requests during broadcasts.

ON-DEMAND SERMON LIBRARY
• Thousands of sermons and teachings, organized by category:
  Faith, Healing, Deliverance, Worship, Prophecy, Special Programs.
• Full-text search across the entire archive.
• Programme Guide showing what's coming up next on the channel.

RADIO MODE
• Switch to audio-only Radio Mode for hands-free, background listening —
  perfect for the car or when your screen is locked.
• Continuous playback with lock-screen media controls.

PERSONALIZATION
• Create a free account to sync your Library and watch history across
  all your devices.
• Receive push notifications for live broadcast starts.
• Data Saver mode for slower connections.

SUPPORT THE MINISTRY
• Give directly from inside the app via secure payment partners.
• Temple TV never stores or sees your card details — all transactions
  are processed by certified payment providers.

PRIVACY
• Watching without signing in keeps all activity on your device only.
• Account data is encrypted in transit at all times.
• Delete your account from Settings at any time.
• We do not sell, share, or monetize your personal data.

ABOUT JCTM
Jesus Christ Temple Ministry (JCTM) is a Christian ministry based in
Nigeria, dedicated to the Gospel of Jesus Christ through prayer,
teaching, healing, and worship. Visit jctm.org.ng to learn more.

SUPPORT
Email: support@templetv.org.ng
Website: https://templetv.org.ng
Privacy Policy: https://jctm.org.ng/privacy-policy
```

### Keywords (100 chars, comma-separated)

```
jctm,church,sermon,worship,prayer,gospel,christian,live,stream,faith,healing,temple,ministry,nigeria
```

### What's New — v1.0.0

```
1.0 — First public release.
• Live broadcast playback with auto-retry.
• Sermon library with offline metadata caching.
• Programme Guide.
• Radio Mode for background audio playback.
• Save sermons, sync across devices when signed in.
• Push notifications for live broadcast start.
```

### Support / marketing URLs

| Field | Value |
|---|---|
| **Support URL** | `https://templetv.org.ng/support` |
| **Marketing URL** | `https://templetv.org.ng` |
| **Privacy Policy URL** | `https://jctm.org.ng/privacy-policy` |
| **EULA** | Standard Apple Licensed Application End-User License Agreement |

### Demo account credentials (App Store review team)

| Field | Value |
|---|---|
| Email | `reviewer@templetv.org.ng` |
| Password | `TempleTV-Review-2026!` |
| Notes | Pre-verified. Tap Settings → Sign In. No further onboarding required. |

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
| Unrestricted web access | No (in-app links open Safari with explicit user action) |
| User-generated content visible to others | None |
| Made for Kids? | No |
| **Resulting rating** | **4+** |

---

## Smart TV stores (future)

The TV web app at `https://tv.templetv.org.ng` is the production Smart TV
target until native Tizen / webOS / tvOS apps are built (see `RELEASE_AUDIT.md`
§ 6 for distribution plans). Use Smart TV screenshots at `screenshots/smart-tv/`
when those listings are created.

---

*End of listing copy — Temple TV v1.0.0*
