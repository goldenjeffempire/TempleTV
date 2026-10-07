---
name: Android reliability diagnosis
description: Native API-level and release-attribution constraints for production incident investigations.
---

Gate each Android framework method by its own introduction level, not by the
age of its enclosing Builder or feature. An unavailable method can throw a
LinkageError rather than Exception; catching Exception is not API compatibility.

**Why:** A production Android 12 stack confirmed NoSuchMethodError from PiP
Builder.setTitle, introduced in Android 13. Grouping methods from different
Android releases under one feature gate left a real crash path despite
apparent exception handling.

**How to apply:** Check official method-level references when auditing native
modules; retain distinct guards and require device/release verification.

Do not attribute a user's reproduced Android navigation defect to an old
installed version without evidence.

**Why:** The user explicitly corrected that their uploaded screenshot was the
new version and requested a fix.

**How to apply:** Treat those reports as current-release defects; distinguish
browser route checks from installed Android reproduction and release sign-off.

Treat Play issue-list titles as diagnostic leads, not complete native traces.
An event percentage on a mixed crash/ANR list is not a crash-rate percentage.

**Why:** Production diagnostics identified a leading PiP NoSuchMethodError
cluster and separate player memory/shutdown issues, but the list did not
identify the unresolved framework method or the thread blocking shutdown.

**How to apply:** Match titles to code to prioritize investigation, obtain
expanded stacks for exact attribution, and distinguish buffer allocation
targets from measured total memory use or verified OOM elimination.
