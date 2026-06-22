/**
 * GlobalApiErrorToasts — subscribes to the apiErrorBus and surfaces
 * transient / server errors as non-blocking Sonner toasts.
 *
 * Rules:
 *  • Deduplicates repeated errors from the same endpoint within a 10-second
 *    window — prevents a bulk operation failure from flooding the toast stack.
 *  • Caps simultaneous active toasts at 3 so the screen never fills.
 *  • Classifies errors:
 *      status 0 / 502 / 503 / 504 → amber warning  ("Server unreachable")
 *      status 5xx                  → red error      ("Server error")
 *  • 401 / 403 are intentionally excluded — they trigger the auth expiry
 *    flow which has its own UX (redirect to /login).
 *
 * Transient-error batching logic:
 *  • Requires TRANSIENT_THRESHOLD distinct-path failures within TRANSIENT_WINDOW_MS
 *    before showing the "server unavailable" toast. A single rolling-restart
 *    blip typically hits ≤ 2 paths simultaneously; genuine unavailability hits 3+.
 *  • Each path is marked as "seen" the moment it contributes to the threshold
 *    counter, not only when the toast fires. Without this, sub-threshold paths
 *    are never deduplicated and each TanStack Query retry re-inflates the counter,
 *    causing the toast to fire on every background refetch during a restart.
 *  • BATCH_COOLDOWN_MS: once the toast fires it is suppressed for 45 seconds
 *    regardless of how many more transient errors arrive. The user already knows
 *    the server is unavailable; repeating the message is noise. Queries
 *    auto-retry, so no manual action is required.
 *
 * Mount once inside AppLayout so it is active for the entire admin session.
 * Returns null — renders no DOM of its own.
 */

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { apiErrorBus, type ApiErrorEvent } from "@/lib/api-error-bus";

const DEDUP_WINDOW_MS = 10_000;

const MAX_ACTIVE_TOASTS = 3;

// How many distinct-path transient errors (502/503/504/network) must occur
// within TRANSIENT_WINDOW_MS before the "server unreachable" toast is shown.
// Raised from 2 → 3: a single rolling restart typically hits 2 concurrent
// background queries; genuine unavailability consistently hits 3+.
const TRANSIENT_THRESHOLD = 3;
const TRANSIENT_WINDOW_MS = 20_000;

// After the batch toast fires, suppress all further transient events for this
// many milliseconds. The user already knows — repeating it is noise.
const BATCH_COOLDOWN_MS = 45_000;

// Normalise a path for deduplication: strip query strings and replace
// UUID/numeric segments with ":id" so bulk row failures collapse to one toast.
function normalisePath(raw: string): string {
  return raw
    .split("?")[0]!
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{18,}/gi, "/:id")
    .replace(/\/\d{4,}/g, "/:id");
}

export function GlobalApiErrorToasts() {
  const seenRef = useRef<Map<string, number>>(new Map());
  const activeRef = useRef(0);
  // Timestamps of recent transient errors contributing to the threshold counter.
  const transientTimestampsRef = useRef<number[]>([]);
  // When the last batch toast was shown — used for the BATCH_COOLDOWN_MS gate.
  const lastBatchToastAtRef = useRef(0);

  useEffect(() => {
    const unsub = apiErrorBus.subscribe((ev: ApiErrorEvent) => {
      const { status, path, message } = ev;

      // Auth errors have their own UX — skip them here.
      if (status === 401 || status === 403) return;

      const now = Date.now();
      const key = `${status}:${normalisePath(path)}`;
      const lastSeen = seenRef.current.get(key) ?? 0;

      if (now - lastSeen < DEDUP_WINDOW_MS) return;
      if (activeRef.current >= MAX_ACTIVE_TOASTS) return;

      const isTransient =
        status === 0 || status === 502 || status === 503 || status === 504;

      if (isTransient) {
        // Already showed a batch toast recently — the user knows. Stay silent
        // until the cooldown expires so every subsequent retry does not re-fire.
        if (now - lastBatchToastAtRef.current < BATCH_COOLDOWN_MS) return;

        // Mark this path as "seen" immediately when it contributes to the
        // threshold counter — not only when the toast fires. Without this,
        // retries from sub-threshold paths bypass the per-path dedup on every
        // refetch interval, constantly re-inflating the counter and causing the
        // toast to fire long after the server has recovered.
        seenRef.current.set(key, now);

        // Append this failure and prune entries outside the rolling window.
        transientTimestampsRef.current.push(now);
        transientTimestampsRef.current = transientTimestampsRef.current.filter(
          (ts) => now - ts < TRANSIENT_WINDOW_MS,
        );

        // Below threshold — a single brief blip, not an outage. Stay silent.
        if (transientTimestampsRef.current.length < TRANSIENT_THRESHOLD) return;

        // Threshold reached: sustained or widespread failure. Show the toast
        // and arm the batch cooldown so it does not repeat every retry cycle.
        lastBatchToastAtRef.current = now;
        activeRef.current += 1;
        const onClose = () => {
          activeRef.current = Math.max(0, activeRef.current - 1);
        };

        toast.warning("API server temporarily unavailable", {
          description:
            "Multiple requests failed — the server may be restarting. Requests will retry automatically.",
          duration: 6_000,
          onDismiss: onClose,
          onAutoClose: onClose,
        });
      } else {
        seenRef.current.set(key, now);
        activeRef.current += 1;
        const onClose = () => {
          activeRef.current = Math.max(0, activeRef.current - 1);
        };

        const title =
          status >= 500 ? `Server error (${status})` : message;
        const description =
          status >= 500 && message && message !== title ? message : undefined;

        toast.error(title, {
          description,
          duration: 8_000,
          onDismiss: onClose,
          onAutoClose: onClose,
        });
      }
    });

    return unsub;
  }, []);

  return null;
}
