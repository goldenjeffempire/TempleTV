---
name: EAS local credentials — JKS required, PKCS12 alias not resolved
description: EAS local credentials handler silently fails to find the alias when the keystorePath points to a PKCS12 (.p12) file; must convert to JKS first.
---

## Rule

EAS `credentialsSource: "local"` with a PKCS12 keystore (`.p12`, `.bak.p12`) produces `EAS_BUILD_INVALID_KEYSTORE_ALIAS_ERROR` even when `keytool -list` confirms the alias exists. Always convert to JKS before using as a local credential.

**Why:** EAS's credentials validation layer uses the Android Gradle plugin's signing config, which resolves the key alias differently for PKCS12 vs JKS. The alias lookup silently fails on PKCS12, returning "does not exist" even though it does.

**How to apply:**

```bash
# Convert PKCS12 backup to JKS
keytool -importkeystore \
  -srckeystore release.keystore.bak.p12 \
  -srcstoretype PKCS12 \
  -srcstorepass "YOUR_PASS" \
  -srcalias "YOUR_ALIAS" \
  -destkeystore artifacts/mobile/release.keystore.jks \
  -deststoretype JKS \
  -deststorepass "YOUR_PASS" \
  -destkeypass "YOUR_PASS" \
  -destalias "YOUR_ALIAS" \
  -noprompt
```

Then:
- `credentials.json` → `keystorePath: "./release.keystore.jks"`, `keyPassword` same as `keystorePassword`
- `.easignore` → add `!release.keystore.jks` exception under the `*.jks` rule

Also: EAS keystore backup `.bak.p12` files have the key password set to the same value as the keystore password (not empty/null), even when the backup metadata says "null". Always use the store password for both fields in `credentials.json`.
