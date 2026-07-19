---
name: FailoverHandler React Native network events
description: DOM online/offline events are silently broken on React Native; public notify API and how to wire it.
---

## Root cause

React Native Hermes exposes `window` but it is NOT a DOM window.
DOM `online`/`offline` events never fire from the OS on RN.
Checking `typeof window === "undefined"` is NOT a safe DOM guard on RN.
`navigator.onLine` is also unreliable on RN (often always true).

## Fix applied (July 2026)

File: `vendor/broadcast-sync/src/engine/FailoverHandler.ts`

1. **DOM guard**: static `_isDomEnvironment()` checks BOTH `window` AND `document`.
   Hermes has `window` but never `document` → correctly excluded.
2. **`bindDomEvents` constructor option** (default true): RN callers pass
   `{ bindDomEvents: false }` to skip DOM binding entirely.
3. **Public `notifyOnline()` / `notifyOffline()`**: external callers (RN NetInfo)
   call these to trigger the offline-wait / resume logic.
4. **`isLikelyOffline()`**: returns false on non-DOM environments.

## How to wire on React Native

```ts
import NetInfo from "@react-native-community/netinfo";
const handler = new FailoverHandler(callbacks, { bindDomEvents: false });
const unsub = NetInfo.addEventListener((state) => {
  if (state.isConnected) handler.notifyOnline();
  else                   handler.notifyOffline();
});
// cleanup: unsub(); handler.unbind();
```

**Why it matters:** Without the fix, every network error burned a retry slot even
when the device was offline → premature SKIP_PENDING/FATAL cascades on RN.
Tests: `vendor/broadcast-sync/src/engine/FailoverHandler.test.ts`
