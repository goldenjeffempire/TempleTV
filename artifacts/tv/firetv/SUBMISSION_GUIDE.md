# Amazon Fire TV — Submission Guide

Temple TV can be published to the Amazon Appstore for Fire TV via two paths:

---

## Path A — Web App (Fastest)

Amazon Appstore accepts **Hosted Web Apps** for Fire TV. The existing TV web app
(`https://tv.templetv.org.ng`) is already optimised for this:

### Steps

1. Log in to [Amazon Developer Console](https://developer.amazon.com/apps-and-games)
2. Click **Add a New App** → select **Web**
3. Set the launch URL to `https://tv.templetv.org.ng`
4. Under **Device Support**, check **Fire TV**
5. Upload assets (see `STORE_ASSETS.md`):
   - App icon: 1280×720 PNG
   - Screenshots: Fire TV screenshots (1920×1080)
   - Feature graphic: 1024×500 PNG
6. Add app metadata, privacy policy URL, and content rating
7. Submit for review

### Checklist before submission

- [ ] D-pad navigation works end-to-end
- [ ] Auth gate (TV code pairing) works
- [ ] Live stream plays correctly
- [ ] Sermon VOD plays correctly
- [ ] Back button returns to previous screen
- [ ] No touch-only UI elements without D-pad equivalent

---

## Path B — Native Android APK (Expo)

The Expo mobile app (`artifacts/mobile`) is configured with Android TV support
via the `android-tv.js` config plugin. This produces an APK that runs natively on
Fire TV via the Amazon Appstore.

### Build commands

```bash
# Install EAS CLI
npm install -g eas-cli

# Build Fire TV APK
cd artifacts/mobile
eas build --platform android --profile firetv
```

### Amazon Appstore submission

1. Go to [Amazon Developer Console](https://developer.amazon.com/apps-and-games)
2. Add New App → **Android**
3. Upload the APK from the EAS build
4. Under **Device Support**, select **Fire TV** (deselect phone/tablet if TV-only)
5. Add store assets and metadata
6. Submit for review

---

## Required Store Assets

| Asset | Size | Format |
|-------|------|--------|
| App icon | 1280×720 | PNG |
| Small icon | 114×114 | PNG |
| Screenshots (Fire TV) | 1920×1080 | PNG (min 3) |
| Feature graphic | 1024×500 | PNG |
| Promotional image | 1024×500 | PNG |

---

## Deep Link Support

Fire TV supports deep links via `templetv://` scheme. The TV web app handles
query params for direct navigation:

```
https://tv.templetv.org.ng/?screen=guide
https://tv.templetv.org.ng/?screen=search
```
