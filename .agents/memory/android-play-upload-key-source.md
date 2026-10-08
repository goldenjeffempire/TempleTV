---
name: Android Play upload key source
description: Signing-key constraint for Temple TV Android production releases.
---

Android store bundles must use the Play-compatible upload certificate. Local
credentials are supported by the secure wrapper; the cloud profile may use
remote credentials only after a completed cloud bundle has been verified
against the certificate Google Play expects.

**Why:** The original remote key differed from the Play-compatible key. The user
subsequently replaced Expo's default Android credentials, and a completed cloud
bundle was verified with the correct certificate. Local-only guidance predating
that replacement is stale. The backup is PKCS#12 and requires conversion to JKS
for the existing local wrapper.

**How to apply:** Use secure credential handling, never print signing passwords,
and verify each finished bundle before presenting it as Play-ready. The expected
SHA-1 is `52:2C:16:01:87:CF:98:86:F2:FB:AB:3B:0A:3A:FC:B1:E8:BF:91:69`.
Do not assume a previously correct remote key remains unchanged.