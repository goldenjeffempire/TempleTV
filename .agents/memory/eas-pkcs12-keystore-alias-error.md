---
name: EAS invalid-keystore-alias error is really a wrong key password
description: PKCS12 keystores force keyPassword == storePassword; a mismatched keyPassword surfaces as the misleading EAS_BUILD_INVALID_KEYSTORE_ALIAS_ERROR
---

# EAS_BUILD_INVALID_KEYSTORE_ALIAS_ERROR — real cause is the key password

When an EAS Android build fails with `EAS_BUILD_INVALID_KEYSTORE_ALIAS_ERROR`
("The alias specified for this keystore does not exist"), the alias usually
DOES exist. Verify with `keytool -list -v -keystore <ks> -storepass <pw>`.

**Root cause seen:** the keystore is **PKCS12** format (default for modern
keytool; check `Keystore type:` in `-list -v`). PKCS12 cannot have a separate
key password — the key password MUST equal the store password. If
`credentials.json` sets a `keyPassword` that differs from `keystorePassword`
(e.g. the literal string `"null"`), EAS/Gradle can't unlock the private key and
reports it as a bogus *alias-not-found* error rather than a password error.

**Fix:** set `keyPassword` == `keystorePassword` in `credentials.json`.

**Why:** keytool `-certreq` with ANY `-keypass` "succeeds" on a PKCS12 store
(the flag is effectively ignored), which is the diagnostic tell that the store
is PKCS12 and the key password is really just the store password.

**How to apply:** on this misleading error, (1) confirm alias exists via
keytool, (2) check `Keystore type: PKCS12`, (3) make `keyPassword` match
`keystorePassword`, (4) rebuild. Keystore validation happens early in the EAS
build, so status moving to IN_PROGRESS past the credentials step confirms the fix.
