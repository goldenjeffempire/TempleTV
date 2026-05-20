# Temple TV — App Store Screenshots

Generated: April 21, 2026
Source: Live screenshots captured directly from the running mobile (Expo) and
TV web applications.

All screenshots are saved as `.jpg` files. Filenames are numbered (`01-`,
`02-`, etc.) so the upload order in App Store Connect / Play Console matches
the recommended marketing order: **Home → Guide → Library → Radio → Settings →
Donate** for mobile, and **Home → TV Guide → Search** for the TV app.

---

## Apple App Store

Apple App Store Connect (2026 spec) requires **one** screenshot set per device
class. Apple auto-scales 6.9″ iPhone screenshots down for older iPhones, and
13″ iPad screenshots down for older iPads, so only these two device sizes are
required for full iPhone + iPad coverage.

### `ios/6.9-iphone/` — iPhone 6.9″ (REQUIRED)

| File | Resolution | Spec resolution | Compliant |
|------|------------|-----------------|-----------|
| 01-home.jpg | 1320×2868 | 1320×2868 (iPhone 16 Pro Max portrait) | ✅ |
| 02-guide.jpg | 1320×2868 | — | ✅ |
| 03-library.jpg | 1320×2868 | — | ✅ |
| 04-radio.jpg | 1320×2868 | — | ✅ |
| 05-settings.jpg | 1320×2868 | — | ✅ |
| 06-donate.jpg | 1320×2868 | — | ✅ |

> Apple requires **at least 3** and accepts up to **10** screenshots. We
> provide 6 — a complete marketing flow.

### `ios/ipad-13/` — iPad 13″ (REQUIRED if iPad supported)

| File | Resolution | Spec resolution | Compliant |
|------|------------|-----------------|-----------|
| 01-home.jpg | 2064×2752 | 2064×2752 (iPad Pro M4 13″ portrait) | ✅ |
| 02-guide.jpg | 2064×2752 | — | ✅ |
| 03-library.jpg | 2064×2752 | — | ✅ |
| 04-radio.jpg | 2064×2752 | — | ✅ |
| 05-settings.jpg | 2064×2752 | — | ✅ |
| 06-donate.jpg | 2064×2752 | — | ✅ |

> Apple requires **at least 3** and accepts up to **10**. We provide 6 — full
> parity with the iPhone set.

> **Legacy device sizes (6.7″ iPhone, 12.9″ iPad) are not separately
> required.** Apple App Store Connect automatically scales the 6.9″ iPhone
> set down to 6.7″/6.5″/5.5″ devices, and the 13″ iPad set down to 12.9″/11″
> iPads. Providing the larger sizes only is the current Apple-recommended
> workflow.

---

## Google Play Store

Google Play accepts 16:9 or 9:16 phone screenshots between **320 px** and
**3840 px** on the long edge, and recommends 1080×1920 portrait for phones.
Tablet screenshots use the same range in landscape orientation.

### `android/phone/` — Phone (REQUIRED)

| File | Resolution | Spec | Compliant |
|------|------------|------|-----------|
| 01-home.jpg | 1080×1920 | 9:16 portrait, 1080×1920 recommended | ✅ |
| 02-guide.jpg | 1080×1920 | — | ✅ |
| 03-library.jpg | 1080×1920 | — | ✅ |
| 04-radio.jpg | 1080×1920 | — | ✅ |
| 05-settings.jpg | 1080×1920 | — | ✅ |
| 06-donate.jpg | 1080×1920 | — | ✅ |

> Play Store requires **at least 2** and accepts up to **8**. We provide 6.

### `android/tablet-10/` — 10″ Tablet (RECOMMENDED)

| File | Resolution | Spec | Compliant |
|------|------------|------|-----------|
| 01-home.jpg | 1920×1200 | 16:10 landscape, 1280×800 minimum | ✅ |
| 02-guide.jpg | 1920×1200 | — | ✅ |
| 03-library.jpg | 1920×1200 | — | ✅ |
| 04-radio.jpg | 1920×1200 | — | ✅ |
| 05-settings.jpg | 1920×1200 | — | ✅ |
| 06-donate.jpg | 1920×1200 | — | ✅ |

> Optional but improves Play Store ranking and the "Designed for Tablet"
> Play Store badge. Google Play uses the same 10″ assets for 7″ tablet
> listings, so a separate 7″ folder is not required.

---

## Smart TV (Apple TV / Google TV / Tizen / webOS)

Smart-TV stores accept full-bleed 16:9 hero shots. The standard is 1920×1080
HD; a UHD 2880×1620 capture is also included for marketing use.

### `smart-tv/1080p/` — 1920×1080 (REQUIRED)

| File | Resolution | Spec | Compliant |
|------|------------|------|-----------|
| 01-home.jpg | 1920×1080 | 16:9, 1920×1080 (FHD landscape) | ✅ |
| 02-tv-guide.jpg | 1920×1080 | — | ✅ |
| 03-search.jpg | 1920×1080 | — | ✅ |

### `smart-tv/4k/` — UHD marketing capture

| File | Resolution | Spec | Compliant |
|------|------------|------|-----------|
| 01-home-uhd.jpg | 2880×1620 | 16:9, suitable for 4K marketing | ✅ |

> Note: a true 3840×2160 capture exceeded the screenshot tool's 3000-pixel
> max edge. Stores accept the FHD captures above; the UHD is provided as a
> high-resolution marketing asset.

---

## Coverage summary

| Platform | Files | Status |
|---|---:|---|
| Apple App Store — iPhone 6.9″ | 6 | ✅ Exceeds minimum (3) |
| Apple App Store — iPad 13″ | 6 | ✅ Exceeds minimum (3) |
| Google Play — Phone | 6 | ✅ Exceeds minimum (2) |
| Google Play — 10″ Tablet | 6 | ✅ Optional, full set provided |
| Smart TV — 1080p | 3 | ✅ |
| Smart TV — UHD marketing | 1 | ✅ |
| **Total** | **28** | |

---

## Re-generating screenshots

These were captured from the live development servers using the workspace
screenshot tool. To regenerate (e.g. after UI changes):

1. Ensure `artifacts/mobile: expo` and `artifacts/tv: web` workflows are
   running.
2. The TV app honours a `?screen=guide` or `?screen=search` query param to
   deep-link the initial screen for screenshot purposes (added in this pass
   to `artifacts/tv/src/App.tsx`).
3. Run the screenshot capture step again from the agent — the device
   viewport sizes used for each folder are documented in the tables above.

## Notes for the user

- **Programme Guide (mobile/TV)** currently shows the empty state because no
  scheduled broadcast items are queued. To re-shoot with content visible,
  add a few items to the broadcast queue in the admin dashboard, then
  re-capture `02-guide.jpg` for each device class.
- **Login/Signup** screens are not included since most apps lead with their
  hero/content screens. If you would like login screens in the marketing
  set, add `07-login.jpg` and `08-signup.jpg` from `/login` and `/signup`.
- **Status bar / notch overlays:** the captured screenshots are full-bleed
  web renders without an iOS status bar overlay. App Store Connect accepts
  these as-is; if you want a simulated status bar, run the captures through
  a frame tool (e.g. Picsew, Screely) before uploading.
- **Legacy device folders** (6.7″ iPhone, 12.9″ iPad, 7″ tablet) were
  intentionally omitted — the stores auto-scale from the larger sizes
  provided here, and uploading duplicate sets is no longer recommended by
  Apple or Google.
