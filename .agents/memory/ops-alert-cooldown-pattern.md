---
name: Ops-alert polling-cycle flood prevention
description: Any ops-alert emitted inside a recurring worker/scan function needs a per-instance cooldown field or it floods the admin SSE channel on every tick while the condition persists.
---

**The pattern:**
Workers that poll on a fixed interval (queue-health-guard every 5 min, storage-health every 60 s, etc.) and call `adminEventBus.push("ops-alert", ...)` when a threshold is breached will re-emit the alert on every cycle until the condition clears. This floods the admin console SSE and any notification hooks.

**The fix:**
Add a `lastOpsAlertAtMs = 0` private field to the worker class. Gate the emit behind a cooldown check (e.g. `OPS_ALERT_COOLDOWN_MS = 30 * 60_000`). Reset `lastOpsAlertAtMs = 0` when the condition recovers, so the first breach after recovery is always reported immediately.

```typescript
private lastOpsAlertAtMs = 0;
const OPS_ALERT_COOLDOWN_MS = 30 * 60_000;

// inside scan():
const nowMs = Date.now();
if (nowMs - this.lastOpsAlertAtMs >= OPS_ALERT_COOLDOWN_MS) {
  this.lastOpsAlertAtMs = nowMs;
  adminEventBus.push("ops-alert", { ... });
} // else: suppress (log at debug level only)

// on recovery:
this.lastOpsAlertAtMs = 0;
```

**Why:** The queue-health-guard emitted every 5 minutes when the broadcast queue was below threshold (common in dev with no local videos), spamming the admin SSE channel and any connected notification handlers indefinitely.

**How to apply:** Any new worker or monitor that calls `adminEventBus.push("ops-alert", ...)` inside a recurring scan/check function must include this throttle. One-shot alerts (startup checks, one-time events) don't need it.
