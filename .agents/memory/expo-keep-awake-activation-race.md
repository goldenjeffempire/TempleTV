---
name: Expo keep-awake activation race
description: Safe cleanup for asynchronous Expo keep-awake activation in player lifecycle effects.
---

Use a stable, component-owned wake-lock tag. Cleanup must catch the returned
deactivation promise and account for activation completing after the effect was
cancelled.

**Why:** Native activation is asynchronous. React cleanup can run first, and
deactivating an unregistered default tag rejects with “has not activated yet.”
A synchronous `try/catch` does not catch that promise rejection.

**How to apply:** Track cancellation inside the effect, catch both activation
and deactivation promises, and release the owned tag again when a late
activation resolves after cleanup.