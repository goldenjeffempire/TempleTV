# Temple TV — Build .aab with Android Studio
> Generates the Google Play-ready `app-release.aab` using Android Studio on your machine.
> Everything in the `android/` folder is already pre-configured — you only need to
> create your signing keystore, then click Build.

---

## What you need (one-time install)
- **Android Studio** (any recent version): https://developer.android.com/studio
- **Java 17+** — bundled with Android Studio, no separate install needed

---

## Step 1 — Generate your release keystore

On **Mac / Linux** — run from the `artifacts/mobile/` folder:
```bash
bash scripts/generate-keystore.sh
```

On **Windows** — double-click `scripts\generate-keystore.bat`

This creates two files inside `android/`:
- `temple-tv-release.keystore` — your signing key
- `keystore.properties` — the passwords (auto-read by Gradle)

> **Back both files up somewhere safe** (USB drive, 1Password, encrypted cloud).
> If you lose them you cannot publish future updates to the same Play Store listing.

---

## Step 2 — Open the project in Android Studio

1. Launch Android Studio
2. Click **Open** (not "New Project")
3. Navigate to and select the **`artifacts/mobile/android/`** folder
4. Wait for Gradle sync to finish (first time: 5–15 min while it downloads SDKs)

If Android Studio asks to upgrade the Gradle plugin — click **Don't remind me again**.

---

## Step 3 — Build the signed .aab

1. In the menu bar: **Build → Generate Signed Bundle / APK…**
2. Select **Android App Bundle** → click **Next**
3. Click **Choose existing…** and select `android/temple-tv-release.keystore`
4. Enter the passwords you set in Step 1
5. Key alias: `temple-tv-key`
6. Tick **Remember passwords**
7. Click **Next**
8. Select build variant: **release**
9. Click **Create**

Android Studio bundles the JS (Metro), compiles the native code (Gradle + R8),
signs the binary, and saves the file to:

```
artifacts/mobile/android/app/release/app-release.aab
```

Build time: ~10–20 minutes on first run (subsequent builds are faster).

---

## Step 4 — Upload to Google Play

1. Go to https://play.google.com/console
2. Create a new app (package: `com.templetv.jctm`)
3. Go to **Testing → Internal testing** → Create new release
4. Upload `app-release.aab`
5. Add release notes and roll out

---

## Environment variables

The production API URL (`https://api.templetv.org.ng`) is already set in
`.env.production` — Metro reads this automatically during the JS bundle step.
No manual configuration needed.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Gradle sync fails: `SDK not found` | In Android Studio → SDK Manager → install API 35 |
| `keytool not found` | keytool comes with Java. Open Android Studio terminal — it has Java in PATH |
| Build fails: `Duplicate class` | In Android Studio terminal: `./gradlew clean` then rebuild |
| `minSdkVersion` mismatch | No action needed — already set to 24 (Android 7) |
| `.aab` not found after build | Check `android/app/release/` or `android/app/build/outputs/bundle/release/` |

---

## Subsequent releases

For every new release:
1. Bump `"version"` in `app.json` (e.g. `"1.1.0"`)
2. Bump `"versionCode"` in `app.json` by 1 (e.g. `3`)
3. Run `pnpm expo prebuild --platform android --no-install` again from `artifacts/mobile/`
4. Rebuild in Android Studio

---

*Temple TV JCTM Broadcasting — Jesus Christ Temple Ministry*
