---
name: Android reliability diagnosis
description: Native API-level and release-attribution constraints for production incident investigations.
---

Gate each Android framework method by its own introduction level, not by the
age of its enclosing Builder or feature. An unavailable method can throw a
LinkageError rather than Exception; catching Exception is not API compatibility.

**Why:** PiP had methods from different Android releases grouped under one
platform gate, leaving a real crash path despite apparent exception handling.

**How to apply:** Check official method-level references when auditing native
modules; retain distinct guards and require device/release verification.

Do not attribute a user's reproduced Android navigation defect to an old
installed version without evidence.

**Why:** The user explicitly corrected that their uploaded screenshot was the
new version and requested a fix.

**How to apply:** Treat those reports as current-release defects; distinguish
browser route checks from installed Android reproduction and release sign-off.
