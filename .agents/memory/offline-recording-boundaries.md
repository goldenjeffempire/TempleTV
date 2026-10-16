---
name: Offline recording boundaries
description: Product acceptance and integrity tradeoffs for offline broadcast recordings.
---

Offline playback must mean downloaded recordings, never simulated live video.
Do not download YouTube or bypass provider/DRM restrictions. Real installed-Android
acceptance is required before claiming production-ready offline playback.

**Why:** The user explicitly requested genuine offline broadcast recordings and
real-world validation, not a browser-only demonstration or mocked downloads.

**How to apply:** Keep offline playback separate from live presence, automatic
live navigation, and live viewer leases. Distinguish compilation, browser UX,
engine tests, and installed-device acceptance in release reports.

Do not add full-file hashing to the memory-constrained API just to supply offline
checksums. Legacy public uploads may lack a server digest; use HTTPS plus trusted
byte length for the first transfer and establish a local digest, checking a
server digest when one is available.

**Why:** Full-file backend scans compete with broadcast blob streaming on the
512 MiB production API. A local digest verifies later integrity but does not
prove an older source was valid before download; do not claim otherwise.

**How to apply:** Preserve that distinction in authorization and verification.
The current offline-window default is technical policy, not confirmed licensing
for paid/private content; consult the owner before extending it to such content.

Administrator-uploaded broadcast recordings must prepare automatically without
a download button, survive app restarts, and remain locally playable without a
backend renewal. Do not apply this requirement to live streams, YouTube, private
media or unrelated VOD features. Prefer Wi-Fi for automatic preparation and
never silently download entire broadcasts over cellular. Reclaim outdated
automatic copies under storage pressure, not manual downloads or active playback.

**Why:** The owner explicitly requested durable automatic offline broadcasts,
then clarified mobile-data protection and cleanup of outdated cached files.

**How to apply:** Keep broadcast-only durable access separate from the existing
expiring manual-recording policy. State preparation/storage limits honestly,
and distinguish software tests from installed-device validation.
