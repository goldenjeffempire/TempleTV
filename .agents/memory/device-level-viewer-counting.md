---
name: Device-level viewer counting
description: Preserve installation-level unique-device broadcast counts and independently expiring foreground app presence.
---

Count distinct server-issued installation credentials for broadcast playback; never deduplicate concurrent physical devices by account owner. Track app foreground activity in a separate expiring lease so opening the app, browsing, or background sessions do not add to broadcast viewers.

**Why:** One account can watch from multiple devices, and app presence does not establish active playback.

**How to apply:** Keep sequenced, expiring app and playback leases separate; merge neither dataset into viewer totals. Describe an opaque installation credential as session validation, not proof of a unique human or attested device.
