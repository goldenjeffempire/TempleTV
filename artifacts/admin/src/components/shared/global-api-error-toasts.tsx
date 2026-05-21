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
 * Mount once inside AppLayout so it is active for the entire admin session.
 * Returns null — renders no DOM of its own.
 */

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { apiErrorBus, type ApiErrorEvent } from "@/lib/api-error-bus";

const DEDUP_WINDOW_MS = 10_000;
const MAX_ACTIVE_TOASTS = 3;

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

      seenRef.current.set(key, now);
      activeRef.current += 1;

      const onClose = () => {
        activeRef.current = Math.max(0, activeRef.current - 1);
      };

      const isTransient =
        status === 0 || status === 502 || status === 503 || status === 504;

      if (isTransient) {
        toast.warning("Server unreachable — retrying automatically", {
          description:
            "The API server is briefly unavailable. In-flight requests will retry on the next attempt.",
          duration: 5_000,
          onDismiss: onClose,
          onAutoClose: onClose,
        });
      } else {
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
