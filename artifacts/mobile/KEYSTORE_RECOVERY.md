# Android Signing Key Recovery Guide

> **Context:** Google Play rejected the App Bundle because it was signed with the wrong key.
>
> - **Expected by Google Play** (SHA1): `52:2C:16:01:87:CF:98:86:F2:FB:AB:3B:0A:3A:FC:B1:E8:BF:91:69`
> - **Used in latest build** (SHA1): `0E:D5:6B:D1:DC:02:76:86:29:8E:51:6A:A0:AC:53:A7:BF:60:9C:BD`
>
> **Root cause:** The `production` EAS profile used `credentialsSource: "remote"`.
> EAS rotated its remote keystore at some point, silently replacing the original key.
> **This has been fixed** — the `production` profile no longer includes Android config.
> All Android Play Store builds must use the **`production-android`** profile, which
> uses `credentialsSource: "local"` and reads from `credentials.json` (gitignored).

---

## Path A — You have the original `.keystore` / `.jks` file

This is the fastest path. The original keystore is the one whose SHA1 fingerprint is
`52:2C:16:01:87:CF:98:86:F2:FB:AB:3B:0A:3A:FC:B1:E8:BF:91:69`.

### Step 1 — Verify your keystore fingerprint

```bash
keytool -list -v \
  -keystore /path/to/your/original.keystore \
  -alias templetv \
  | grep "SHA1:"
```

Confirm the SHA1 matches `52:2C:16:01:87:CF:98:86:F2:FB:AB:3B:0A:3A:FC:B1:E8:BF:91:69`.
If it does, proceed.

### Step 2 — Place the keystore in the mobile directory

```bash
# Copy it into the mobile app directory (it is gitignored — safe to leave here)
cp /path/to/your/original.keystore artifacts/mobile/release.keystore
```

### Step 3 — Fill in credentials.json

Edit `artifacts/mobile/credentials.json` (already created, gitignored):

```json
{
  "android": {
    "keystore": {
      "keystorePath": "./release.keystore",
      "keystorePassword": "YOUR_ACTUAL_KEYSTORE_PASSWORD",
      "keyAlias": "templetv",
      "keyPassword": "YOUR_ACTUAL_KEY_PASSWORD"
    }
  }
}
```

> If your key alias is not `templetv`, update the `keyAlias` field accordingly.
> Run `keytool -list -v -keystore release.keystore` to see the alias name.

### Step 4 — Upload the original keystore to EAS remote (recommended backup)

This keeps EAS's remote credential store in sync so the dashboard reflects reality:

```bash
cd artifacts/mobile
eas credentials --platform android
# Choose: "Update existing credentials" → "Set up existing keystore"
# Upload release.keystore and enter the same passwords
```

### Step 5 — Build and submit

```bash
cd artifacts/mobile

# Build signed .aab with the correct key
eas build --platform android --profile production-android

# Submit to Play Store internal track
eas submit --platform android --profile production
```

---

## Path B — You do NOT have the original keystore

If the original keystore was lost (e.g. EAS rotated it and no backup was made),
you must ask Google to reset your upload key. This is a formal process with Google.

### Step 1 — Enroll in Google Play App Signing (if not already)

If your app is not yet enrolled in Google Play App Signing, enroll now:
- Play Console → Your app → Setup → App signing
- Follow the enrollment flow

### Step 2 — Request an upload key reset

Google allows resetting the **upload key** (not the app signing key) once:

1. Go to [Play Console Help](https://support.google.com/googleplay/android-developer/contact/otherbugs)
2. Subject: **"Request upload key reset"**
3. Provide:
   - Package name: `com.templetv.jctm`
   - Developer account email
   - The new upload key certificate (`.pem`) you want to use
4. Google typically responds within 1–3 business days

**To generate a new upload key and export its certificate:**

```bash
# 1. Generate a new keystore
keytool -genkeypair \
  -alias templetv \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000 \
  -keystore release.keystore \
  -dname "CN=Temple TV, OU=JCTM, O=Jesus Christ Temple Ministry, L=Lagos, ST=Lagos, C=NG"

# 2. Export the public certificate as PEM (send this to Google)
keytool -export \
  -alias templetv \
  -keystore release.keystore \
  -rfc \
  -file upload_certificate.pem

# 3. Verify the fingerprint of the new key
keytool -list -v -keystore release.keystore -alias templetv | grep "SHA1:"
```

Once Google approves the reset, copy the keystore to `artifacts/mobile/release.keystore`,
fill in `credentials.json`, and follow Path A Steps 3–5.

---

## Preventing this from happening again

The `eas.json` has been updated so that:

| Profile | Platform | Credentials |
|---------|----------|-------------|
| `production` | iOS only | EAS remote (safe — iOS certs do not affect Android Play Store) |
| `production-ios` | iOS only | EAS remote |
| `production-android` | Android only | **Local** (`credentials.json`) — EAS cannot rotate this |

**Always use `production-android` for Play Store Android submissions:**

```bash
eas build --platform android --profile production-android
```

**Never use** `eas build --platform android --profile production` for Play Store submissions
— that profile is now iOS-only but was previously the source of the key mismatch.

---

## Keystore backup checklist

After recovering, store the keystore in at least two secure locations:

- [ ] Password manager (1Password, Bitwarden, etc.) as a secure note with file attachment
- [ ] Encrypted cloud backup (Google Drive, iCloud) in a restricted folder
- [ ] Company secrets vault / HSM if available

The keystore is the **only** way to publish updates to your existing Play Store listing.
Losing it permanently means creating a new Play Store listing and losing all reviews/ratings.
