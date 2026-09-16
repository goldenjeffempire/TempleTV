---
name: Android Play upload key source
description: Signing-key constraint for Temple TV Android production releases.
---

Use the corrected local Play upload keystore for Android store bundles. Do not
switch a production Android build to EAS remote credentials unless its signing
certificate has first been proven to match the latest Play-compatible release.

**Why:** Certificate comparison showed that the most recent locally signed
Play-compatible AAB and the preceding remotely signed EAS AAB use different
certificates. The local credential files are not currently present in the
workspace, and a private key cannot be recovered from a prior AAB.

**How to apply:** Restore the corrected keystore through secure credential
handling, verify its certificate fingerprint against the latest accepted
release, then use the existing local-credentials Android app-bundle profile.